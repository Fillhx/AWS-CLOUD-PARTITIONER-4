import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

// Disco EBS de procesamiento: se adjunta como /dev/sdb y se monta en SCRATCH_DIR.
const SCRATCH_DEVICE = '/dev/sdb';
const SCRATCH_DIR = '/mnt/orders-tmp';
const DB_NAME = 'store';
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

export interface StoreBackendStackProps extends cdk.StackProps {
  /**
   * Boss Fight (1.000.000 de clientes): DynamoDB Streams, read replica de RDS y replicación
   * cross-region de S3. Todo se agrega encima de los recursos existentes, sin recrearlos.
   */
  readonly bossFight: boolean;
  /** Nombre del bucket destino de la replicación (en otra región). Obligatorio si bossFight. */
  readonly replicaBucketName?: string;
}

export class StoreBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StoreBackendStackProps) {
    super(scope, id, props);

    if (props.bossFight && !props.replicaBucketName) {
      throw new Error('bossFight requiere replicaBucketName');
    }

    // --- VPC: subnet pública para la EC2 y subnet aislada (sin ruta a internet) para RDS. Sin NAT ---
    const vpc = new ec2.Vpc(this, 'StoreVpc', {
      maxAzs: 2, // RDS exige un subnet group que cubra al menos 2 AZs.
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // --- S3: imágenes de productos (almacenamiento de objetos) ---
    const imagesBucket = new s3.Bucket(this, 'ProductImagesBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // La replicación exige versionado en origen y destino. Activarlo es una actualización, no un reemplazo.
      versioned: props.bossFight,
      lifecycleRules: [
        {
          id: 'ImagenesViejasAStandardIA',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          // Con versionado, las versiones reemplazadas de una imagen no se quedan cobrando para siempre.
          noncurrentVersionExpiration: props.bossFight ? cdk.Duration.days(30) : undefined,
        },
      ],
      replicationRules: props.bossFight
        ? [
            {
              destination: s3.Bucket.fromBucketName(this, 'ReplicaBucket', props.replicaBucketName!),
              priority: 1,
              deleteMarkerReplication: true,
            },
          ]
        : undefined,
      // Laboratorio: cdk destroy vacía y borra el bucket. En producción sería RETAIN.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- DynamoDB: órdenes de compra (NoSQL, escrituras de alta frecuencia) ---
    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Boss Fight: cada alta o cambio de una orden queda como evento para procesarlo en tiempo real.
      stream: props.bossFight ? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES : undefined,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // La clave primaria resuelve "todas las órdenes de un cliente". Este índice resuelve "buscar una orden por su id".
    ordersTable.addGlobalSecondaryIndex({
      indexName: 'orderId-index',
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
    });

    // --- RDS PostgreSQL: catálogo (relacional), en subnets aisladas y sin IP pública ---
    const processorSg = new ec2.SecurityGroup(this, 'ProcessorSg', {
      vpc,
      description: 'EC2 de procesamiento: sin entrada (acceso por SSM)',
      allowAllOutbound: true,
    });
    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'RDS: PostgreSQL solo desde la EC2 de procesamiento',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(processorSg, ec2.Port.tcp(5432), 'PostgreSQL desde la EC2 de procesamiento');

    const dbSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
    const dbInstanceType = ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO);

    const database = new rds.DatabaseInstance(this, 'CatalogDb', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18_3 }),
      instanceType: dbInstanceType,
      vpc,
      vpcSubnets: dbSubnets,
      securityGroups: [dbSg],
      publiclyAccessible: false,
      databaseName: DB_NAME,
      // Usuario y contraseña generados en Secrets Manager: no hay credenciales en el código.
      credentials: rds.Credentials.fromGeneratedSecret('storeadmin'),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false, // Costo de laboratorio. En producción: true.
      // Las read replicas exigen backups automáticos en la instancia principal.
      backupRetention: cdk.Duration.days(1),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Boss Fight: read replica para repartir las lecturas del catálogo ---
    // CloudFormation la borra antes que la principal en cdk destroy, porque depende de ella.
    const readReplica = props.bossFight
      ? new rds.DatabaseInstanceReadReplica(this, 'CatalogReadReplica', {
          sourceDatabaseInstance: database,
          instanceType: dbInstanceType,
          vpc,
          vpcSubnets: dbSubnets,
          securityGroups: [dbSg],
          publiclyAccessible: false,
          // El cifrado se hereda de la principal (CloudFormation no acepta StorageEncrypted en una réplica).
          deletionProtection: false,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      : undefined;

    // --- EC2 + EBS: procesamiento de órdenes con disco temporal en bloque ---
    const processorRole = new iam.Role(this, 'ProcessorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'EC2 de procesamiento: SSM + acceso a los datos de la tienda',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    database.secret!.grantRead(processorRole);
    ordersTable.grantReadWriteData(processorRole);
    imagesBucket.grantReadWrite(processorRole);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y jq',
      // Cliente de PostgreSQL: el más nuevo que ofrezca el repositorio de AL2023.
      'for v in 18 17 16 15; do dnf install -y postgresql$v && break; done',

      // Disco EBS de procesamiento (en Nitro aparece como NVMe; amazon-ec2-utils crea el enlace /dev/sdb).
      `for i in $(seq 1 30); do [ -e ${SCRATCH_DEVICE} ] && break; sleep 2; done`,
      `DEV=$(readlink -f ${SCRATCH_DEVICE})`,
      'blkid "$DEV" || mkfs -t xfs "$DEV"',
      `mkdir -p ${SCRATCH_DIR}`,
      'UUID=$(blkid -s UUID -o value "$DEV")',
      `grep -q "$UUID" /etc/fstab || echo "UUID=$UUID ${SCRATCH_DIR} xfs defaults,nofail 0 2" >> /etc/fstab`,
      'mount -a',
      `chmod 1777 ${SCRATCH_DIR}`,

      // store-psql: abre psql contra el catálogo con la contraseña de Secrets Manager.
      // Para leer de la réplica: PGHOST=<endpoint de la réplica> store-psql
      'cat > /usr/local/bin/store-psql <<EOF',
      '#!/bin/bash',
      `SECRET=\\$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${database.secret!.secretArn} --query SecretString --output text)`,
      'export PGHOST=\\${PGHOST:-\\$(jq -r .host <<<"\\$SECRET")}',
      'export PGPORT=\\$(jq -r .port <<<"\\$SECRET")',
      'export PGDATABASE=\\$(jq -r .dbname <<<"\\$SECRET")',
      'export PGUSER=\\$(jq -r .username <<<"\\$SECRET")',
      'export PGPASSWORD=\\$(jq -r .password <<<"\\$SECRET")',
      'export PGSSLMODE=require',
      'exec psql "\\$@"',
      'EOF',
      'chmod +x /usr/local/bin/store-psql',

      // Crea las tablas del catálogo (idempotente) apenas la base acepte conexiones.
      'cat > /opt/schema.sql <<\'SQL\'',
      SCHEMA_SQL.trimEnd(),
      'SQL',
      'for i in $(seq 1 60); do store-psql -c "select 1" >/dev/null 2>&1 && break; sleep 10; done',
      'store-psql -v ON_ERROR_STOP=1 -f /opt/schema.sql',
    );

    const processor = new ec2.Instance(this, 'OrderProcessor', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true, // Salida a internet sin NAT; el SG no deja entrar nada.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: processorSg,
      role: processorRole,
      userData,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: SCRATCH_DEVICE,
          volume: ec2.BlockDeviceVolume.ebs(10, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            // Es almacenamiento temporal: se borra con la instancia y no quedan volúmenes huérfanos.
            deleteOnTermination: true,
          }),
        },
      ],
    });
    // El user data crea las tablas: la instancia arranca cuando la base ya existe.
    processor.node.addDependency(database);

    // --- Boss Fight: consumidor del stream de órdenes en tiempo real ---
    if (props.bossFight) {
      const orderEventsLogs = new logs.LogGroup(this, 'OrderEventsLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Sin log groups huérfanos al hacer cdk destroy.
      });
      const orderEventsFn = new lambda.Function(this, 'OrderEventsFunction', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        description: 'Procesa en tiempo real los eventos del stream de la tabla de órdenes',
        logGroup: orderEventsLogs,
        timeout: cdk.Duration.seconds(30),
        code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  for (const record of event.Records) {
    const image = record.dynamodb.NewImage ?? record.dynamodb.OldImage;
    console.log(JSON.stringify({
      evento: record.eventName,
      customerId: image.customerId?.S,
      orderId: image.orderId?.S,
      status: image.status?.S,
      total: image.total?.N,
    }));
  }
  return { procesados: event.Records.length };
};`),
      });
      orderEventsFn.addEventSource(
        new DynamoEventSource(ordersTable, {
          startingPosition: lambda.StartingPosition.LATEST,
          batchSize: 100,
          maxBatchingWindow: cdk.Duration.seconds(1),
          bisectBatchOnError: true,
          retryAttempts: 3,
        }),
      );
      new cdk.CfnOutput(this, 'OrderEventsLogGroup', { value: orderEventsLogs.logGroupName });
    }

    // --- Salidas ---
    new cdk.CfnOutput(this, 'ImagesBucketName', { value: imagesBucket.bucketName });
    new cdk.CfnOutput(this, 'OrdersTableName', { value: ordersTable.tableName });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: database.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbInstanceId', { value: database.instanceIdentifier });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: database.secret!.secretArn });
    new cdk.CfnOutput(this, 'ProcessorInstanceId', { value: processor.instanceId });
    if (readReplica) {
      new cdk.CfnOutput(this, 'ReadReplicaEndpoint', { value: readReplica.dbInstanceEndpointAddress });
    }
  }
}
