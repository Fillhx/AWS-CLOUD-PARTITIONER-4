import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StoreReplicaStackProps extends cdk.StackProps {
  readonly bucketName: string;
}

/**
 * Boss Fight: bucket destino de la replicación cross-region de las imágenes.
 * Vive en otra región para que el catálogo siga teniendo imágenes si us-east-1 cae.
 */
export class StoreReplicaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StoreReplicaStackProps) {
    super(scope, id, props);

    const replicaBucket = new s3.Bucket(this, 'ProductImagesReplica', {
      // Nombre fijo: el stack de origen (otra región) lo referencia sin cross-region references.
      bucketName: props.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true, // Obligatorio en el destino de una replicación.
      lifecycleRules: [
        {
          id: 'ImagenesViejasAStandardIA',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new cdk.CfnOutput(this, 'ReplicaBucketName', { value: replicaBucket.bucketName });
  }
}
