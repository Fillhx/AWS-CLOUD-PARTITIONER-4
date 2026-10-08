#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { StoreBackendStack } from '../lib/store-backend-stack';
import { StoreReplicaStack } from '../lib/store-replica-stack';

const PRIMARY_REGION = 'us-east-1';
const REPLICA_REGION = 'us-west-2';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Boss Fight activo por defecto. Para desplegar solo la versión base: cdk deploy -c bossFight=false
const bossFight = String(app.node.tryGetContext('bossFight') ?? 'true') !== 'false';

let replicaBucketName: string | undefined;
let replicaStack: StoreReplicaStack | undefined;
if (bossFight) {
  replicaBucketName = `lab4-product-images-replica-${account}-${REPLICA_REGION}`;
  replicaStack = new StoreReplicaStack(app, 'StoreReplicaStack', {
    env: { account, region: REPLICA_REGION },
    bucketName: replicaBucketName,
    description: 'LAB4: réplica cross-region de las imágenes de productos',
  });
}

const backend = new StoreBackendStack(app, 'StoreBackendStack', {
  env: { account, region: PRIMARY_REGION },
  bossFight,
  replicaBucketName,
  description: 'LAB4: almacenamiento de la tienda online (S3, RDS, DynamoDB, EBS)',
});
// El bucket destino tiene que existir antes de configurar la replicación.
if (replicaStack) backend.addStackDependency(replicaStack);
