import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { StoreBackendStack } from '../lib/store-backend-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const synth = (bossFight: boolean) =>
  Template.fromStack(
    new StoreBackendStack(new cdk.App(), 'TestStack', {
      env,
      bossFight,
      replicaBucketName: bossFight ? 'replica-bucket-test' : undefined,
    }),
  );

const base = synth(false);
const boss = synth(true);

describe('Requisitos base', () => {
  test('S3: bucket privado con lifecycle a Standard-IA a los 90 días', () => {
    base.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            Transitions: [{ StorageClass: 'STANDARD_IA', TransitionInDays: 90 }],
          }),
        ],
      },
    });
  });

  test('RDS: PostgreSQL cifrado, sin IP pública y en subnets aisladas', () => {
    base.resourceCountIs('AWS::RDS::DBInstance', 1);
    base.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DBName: 'store',
    });

    // Las subnets del subnet group de RDS no asignan IP pública ni tienen ruta a internet.
    const subnetGroup = Object.values(base.findResources('AWS::RDS::DBSubnetGroup'))[0];
    const subnets = base.toJSON().Resources;
    for (const ref of subnetGroup.Properties.SubnetIds) {
      expect(subnets[ref.Ref].Properties.MapPublicIpOnLaunch).toBe(false);
    }
    base.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('RDS: solo acepta el puerto 5432 desde la EC2 de procesamiento', () => {
    const ingress = Object.values(base.findResources('AWS::EC2::SecurityGroupIngress'));
    expect(ingress).toHaveLength(1);
    expect(ingress[0].Properties).toMatchObject({ FromPort: 5432, ToPort: 5432, IpProtocol: 'tcp' });
    expect(ingress[0].Properties.CidrIp).toBeUndefined();
    expect(ingress[0].Properties.SourceSecurityGroupId).toBeDefined();
  });

  test('DynamoDB: customerId como PK, orderId como SK, on-demand y GSI por orderId', () => {
    base.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'customerId', KeyType: 'HASH' },
        { AttributeName: 'orderId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'orderId-index',
          KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
        }),
      ],
      StreamSpecification: Match.absent(),
    });
  });

  test('EBS: volumen gp3 cifrado para procesamiento temporal en la EC2', () => {
    base.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [
        Match.objectLike({
          DeviceName: '/dev/sdb',
          Ebs: Match.objectLike({ VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true }),
        }),
      ],
    });
  });

  test('La EC2 no abre ningún puerto de entrada', () => {
    const processorSg = Object.values(
      base.findResources('AWS::EC2::SecurityGroup', {
        Properties: { GroupDescription: Match.stringLikeRegexp('^EC2 de procesamiento') },
      }),
    )[0];
    expect(processorSg.Properties.SecurityGroupIngress ?? []).toHaveLength(0);
  });

  test('Sin recursos del Boss Fight en la versión base', () => {
    base.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
    base.hasResourceProperties('AWS::S3::Bucket', { ReplicationConfiguration: Match.absent() });
  });
});

describe('Boss Fight', () => {
  test('DynamoDB Streams con un consumidor Lambda', () => {
    boss.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
    boss.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BisectBatchOnFunctionError: true,
    });
  });

  test('RDS: read replica de la principal, también sin IP pública', () => {
    boss.resourceCountIs('AWS::RDS::DBInstance', 2);
    boss.hasResourceProperties('AWS::RDS::DBInstance', {
      SourceDBInstanceIdentifier: Match.anyValue(),
      PubliclyAccessible: false,
    });
  });

  test('S3: versionado y replicación cross-region hacia el bucket réplica', () => {
    boss.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      ReplicationConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            Destination: Match.objectLike({
              Bucket: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':s3:::replica-bucket-test']] },
            }),
          }),
        ],
      },
    });
  });

  test('No reemplaza ni elimina ningún recurso de la versión base', () => {
    const before = base.toJSON().Resources;
    const after = boss.toJSON().Resources;
    // Mismos IDs lógicos: CloudFormation actualiza en vez de recrear.
    for (const id of Object.keys(before)) {
      expect(after[id]?.Type).toBe(before[id].Type);
    }
    // La EC2, la RDS principal y la VPC quedan idénticas.
    for (const [id, res] of Object.entries<any>(before)) {
      if (['AWS::EC2::Instance', 'AWS::RDS::DBInstance', 'AWS::EC2::VPC'].includes(res.Type)) {
        expect(after[id]).toEqual(res);
      }
    }
  });
});
