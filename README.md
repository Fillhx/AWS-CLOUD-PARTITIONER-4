# LAB4 — Almacenamiento de una tienda online con AWS CDK

Cada tipo de dato de la tienda va al servicio de almacenamiento que mejor encaja con él. Todo está definido en CDK (TypeScript): no hay que crear nada a mano en la consola, ni siquiera las tablas de la base de datos.

| Dato | Servicio | Tipo | Dónde está en el código |
|---|---|---|---|
| Imágenes de productos | **S3** | Objetos | `ProductImagesBucket` |
| Catálogo (categorías, productos, inventario) | **RDS PostgreSQL** | Relacional | `CatalogDb` + `db/schema.sql` |
| Órdenes de compra | **DynamoDB** | NoSQL clave-valor | `OrdersTable` |
| Procesamiento temporal de órdenes | **EBS** en una EC2 | Bloque | `OrderProcessor` (`/mnt/orders-tmp`) |

## Justificación: por qué cada servicio

### Imágenes → S3 (almacenamiento de objetos)
- Las imágenes son archivos grandes, no estructurados, que se escriben una vez y se leen muchas. Es justo el caso para el que existe un almacén de objetos: se guarda el archivo completo bajo una clave (`products/CAM-001.jpg`) y se descarga por HTTP.
- No tiene límite de capacidad y se paga por GB usado, no por disco reservado. Su durabilidad es de 11 nueves.
- Se integra con CloudFront para servir imágenes a todo el mundo.
- **Lifecycle a S3 Standard-IA a los 90 días.** Una imagen vieja (de un producto descontinuado o de una temporada pasada) casi no se consulta. Standard-IA cuesta cerca de un 45 % menos por GB y mantiene la misma latencia, así que la imagen sigue disponible al instante si alguien la pide. A cambio cobra por cada lectura y tiene un mínimo de 128 KB por objeto y de 30 días, lo que encaja con imágenes grandes y viejas.
- **Por qué no las otras opciones.** Guardar las imágenes en la base de datos (BLOBs) la infla, encarece los backups y le quita memoria al catálogo. Un disco EBS solo lo puede montar una instancia y no escala solo.

### Catálogo → RDS PostgreSQL (relacional)
- El catálogo tiene **relaciones y reglas de integridad**: un producto pertenece a una categoría, el inventario es de un producto, el precio no puede ser negativo y el SKU es único. SQL hace que la base garantice estas reglas con claves foráneas, `CHECK` y `UNIQUE`, en vez de dejarlo al código.
- Las consultas típicas cruzan tablas, por ejemplo "productos de la categoría X con stock y precio menor a Y". Eso es un `JOIN`, y es natural en SQL.
- Las **transacciones ACID** permiten descontar inventario sin vender más unidades de las que hay.
- RDS es administrado: AWS se encarga de los parches, los backups automáticos, el cifrado y las réplicas.
- **Seguridad.** La instancia está en **subnets aisladas** (sin ruta a internet), con `PubliclyAccessible: false`, y solo acepta conexiones al puerto 5432 desde el Security Group de la EC2 de procesamiento. La contraseña la genera Secrets Manager, así que no aparece en el código.

### Órdenes → DynamoDB (NoSQL)
- Las órdenes llegan en **escrituras de alta frecuencia** y siempre se consultan por clave. DynamoDB responde en milisegundos de un dígito a cualquier volumen y, en modo `PAY_PER_REQUEST`, escala solo, sin servidores ni capacidad que planear.
- **Diseño de claves:**
  - **PK `customerId`, SK `orderId`.** Así, "todas las órdenes de un cliente" es un único `Query` que devuelve los resultados ordenados. Si el `orderId` es ordenable por tiempo (por ejemplo, un ULID o `2026-10-08#123`), también salen en orden cronológico.
  - **GSI `orderId-index`.** El enunciado pide acceder a una orden también por su `orderId`, sin conocer al cliente. Sin este índice esa consulta sería un `Scan` de toda la tabla.
- **Esquema flexible.** Cada orden puede traer atributos distintos (cupón, dirección alternativa, notas) sin migraciones.
- **Por qué no RDS para las órdenes.** Sería un cuello de botella de escritura en una sola instancia principal, y no se usan `JOIN` sobre las órdenes.
- Tiene **Point-in-time recovery** activado, así que se puede restaurar a cualquier segundo de los últimos 35 días.

### Procesamiento temporal → EBS (bloque)
- Procesar una orden (generar facturas en PDF, armar lotes o archivos de exportación) necesita un **sistema de archivos POSIX de baja latencia** donde escribir y borrar archivos intermedios. S3 no es un sistema de archivos, y DynamoDB y RDS no sirven para archivos.
- EBS es un disco de red que se monta en la EC2 como si fuera local. Aquí se usa un gp3 de 10 GB **cifrado**, montado en `/mnt/orders-tmp`.
- Como es temporal, tiene `deleteOnTermination: true`: se borra con la instancia y no deja volúmenes huérfanos.
- La EC2 no abre ningún puerto: se administra por Session Manager (SSM). Su rol solo puede leer el secreto de la base, leer y escribir en la tabla de órdenes y en el bucket de imágenes.
- Esta misma instancia **crea las tablas del catálogo al arrancar**: ejecuta `db/schema.sql`, que es idempotente. Así el requisito "ningún recurso manual" se cumple también dentro de la base de datos.

## Arquitectura

```
                        us-east-1  (StoreBackendStack)
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ VPC 2 AZs, sin NAT                                                      │
 │  Subnet pública                     Subnets aisladas (sin internet)     │
 │  ┌──────────────────────┐  5432    ┌─────────────────┐   ┌───────────┐ │
 │  │ EC2 OrderProcessor   │────────▶│ RDS PostgreSQL  │──▶│ Read      │ │
 │  │ + EBS /mnt/orders-tmp│         │ (catálogo)      │   │ Replica * │ │
 │  └─────────┬────────────┘         └─────────────────┘   └───────────┘ │
 └────────────┼────────────────────────────────────────────────────────────┘
              ├────────▶ DynamoDB OrdersTable ──stream *──▶ Lambda OrderEvents *
              └────────▶ S3 ProductImages ──replicación *──┐
                                                            ▼
                          us-west-2 (StoreReplicaStack *)  S3 réplica
                                                   * = Boss Fight
```

## Despliegue

```bash
npm install
npm test                       # 11 pruebas sobre las plantillas (requisitos + Boss Fight)
```

### Fase 1: versión base

```bash
npx cdk deploy StoreBackendStack -c bossFight=false
```

Tarda unos 10–15 minutos, la mayor parte en crear RDS.

### Fase 2: Boss Fight (1.000.000 de clientes)

```bash
npx cdk bootstrap aws://<cuenta>/us-west-2      # solo la primera vez: la réplica vive en otra región
npx cdk diff StoreBackendStack                  # debe mostrar solo [~] modificaciones y [+] altas, ningún reemplazo
npx cdk deploy --all
```

El Boss Fight se activa por defecto; `-c bossFight=false` lo desactiva. `cdk diff` y la prueba "No reemplaza ni elimina ningún recurso" lo demuestran. Pasa lo siguiente:

| Cambio | Efecto sobre lo existente |
|---|---|
| **DynamoDB Streams** (`NEW_AND_OLD_IMAGES`) + Lambda `OrderEventsFunction` | La tabla se modifica sin interrupción. Cada orden nueva o modificada llega a la Lambda en ~1 s, que la procesa en lotes de hasta 100. Si un lote falla, lo divide en dos (`bisectBatchOnError`) para aislar el registro problemático. |
| **Read Replica** de RDS | Es una instancia nueva. La principal no cambia. Las lecturas del catálogo (que son la mayoría en una tienda) se pueden mandar a la réplica y la principal queda para las escrituras. |
| **Replicación cross-region** de S3 a us-west-2 | El bucket se modifica sin interrupción: se le activa el versionado, que la replicación exige. Desde ese momento, cada imagen nueva se copia a la otra región. |

DynamoDB no necesita más cambios, porque `PAY_PER_REQUEST` ya absorbe el crecimiento de 100x.

> Ojo: la replicación de S3 solo copia los objetos **nuevos**. Para copiar los que ya existían habría que usar S3 Batch Replication.

## Verificar los criterios de éxito

```bash
out() { aws cloudformation describe-stacks --stack-name StoreBackendStack \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out ImagesBucketName); TABLE=$(out OrdersTableName)
DB=$(out DbInstanceId); EC2=$(out ProcessorInstanceId)

# 1. S3: lifecycle configurada y subida de una imagen
aws s3api get-bucket-lifecycle-configuration --bucket $BUCKET
echo "imagen de prueba" > /tmp/CAM-001.jpg && aws s3 cp /tmp/CAM-001.jpg s3://$BUCKET/products/CAM-001.jpg

# 2. RDS sin IP pública
aws rds describe-db-instances --db-instance-identifier $DB \
  --query "DBInstances[0].[PubliclyAccessible,Endpoint.Address,StorageEncrypted]"
dig +short $(out DbEndpoint)        # debe resolver a una IP privada 10.x

# 3. Tablas del catálogo (consulta desde la EC2 por SSM)
aws ssm send-command --instance-ids $EC2 --document-name AWS-RunShellScript \
  --parameters 'commands=["store-psql -c \"\\dt\" -c \"select p.sku, p.name, c.name categoria, i.quantity from products p join categories c on c.id=p.category_id join inventory i on i.product_id=p.id\""]'
# Leer el resultado: aws ssm get-command-invocation --command-id <id> --instance-id $EC2

# 4. DynamoDB: escribir y leer con la estructura definida
aws dynamodb put-item --table-name $TABLE --item \
  '{"customerId":{"S":"C-001"},"orderId":{"S":"2026-10-08#0001"},"status":{"S":"PAID"},"total":{"N":"239800"}}'
aws dynamodb query --table-name $TABLE --key-condition-expression "customerId = :c" \
  --expression-attribute-values '{":c":{"S":"C-001"}}'
aws dynamodb query --table-name $TABLE --index-name orderId-index \
  --key-condition-expression "orderId = :o" --expression-attribute-values '{":o":{"S":"2026-10-08#0001"}}'

# 5. EBS montado en la EC2
aws ssm send-command --instance-ids $EC2 --document-name AWS-RunShellScript \
  --parameters 'commands=["df -h /mnt/orders-tmp","lsblk"]'
```

**Boss Fight:**

```bash
# Stream: la Lambda registra cada orden nueva
aws logs tail $(out OrderEventsLogGroup) --since 5m

# Read replica: lectura del catálogo desde la réplica
aws ssm send-command --instance-ids $EC2 --document-name AWS-RunShellScript \
  --parameters "commands=[\"PGHOST=$(out ReadReplicaEndpoint) store-psql -c 'select count(*) from products'\"]"

# Replicación: la imagen aparece en us-west-2 a los pocos segundos
aws s3 cp /tmp/CAM-001.jpg s3://$BUCKET/products/CAM-002.jpg
aws s3api head-object --bucket $BUCKET --key products/CAM-002.jpg --query ReplicationStatus   # COMPLETED
aws s3 ls s3://lab4-product-images-replica-<cuenta>-us-west-2/products/ --region us-west-2
```

## Costo aproximado

| Recurso | Costo |
|---|---|
| 2 RDS `db.t3.micro` | ~0,018 USD/h cada una |
| EC2 `t3.micro` | ~0,0104 USD/h |
| IPv4 pública | 0,005 USD/h |
| Secrets Manager | 0,40 USD/mes |
| S3, DynamoDB on-demand, Lambda | Prácticamente 0 con el volumen de un laboratorio |

**Un par de horas de laboratorio cuestan menos de 1 USD.** Para ahorrar se renunció a NAT Gateway (~32 USD/mes) y a RDS Multi-AZ, cosas que en producción sí se usarían.

## Limpieza

```bash
npx cdk destroy --all
```

- **Orden de borrado.** CloudFormation borra la read replica antes que la principal, porque la réplica depende de ella. Después borra el stack de la réplica de S3, porque el stack principal depende de él. RDS puede tardar unos 10 minutos.
- **Buckets.** Los dos se vacían solos (`autoDeleteObjects`), incluidas todas las versiones.
- **Al terminar, revisar que no quede nada:**
  ```bash
  aws rds describe-db-instances --query "DBInstances[].DBInstanceIdentifier"
  aws rds describe-db-snapshots --snapshot-type manual --query "DBSnapshots[].DBSnapshotIdentifier"
  aws ec2 describe-volumes --filters Name=status,Values=available --query "Volumes[].VolumeId"
  aws logs describe-log-groups --log-group-name-prefix /aws/lambda/StoreBackendStack --query "logGroups[].logGroupName"
  aws logs describe-log-groups --log-group-name-prefix /aws/lambda/StoreReplicaStack --region us-west-2 --query "logGroups[].logGroupName"
  ```
  Las Lambdas internas de CDK (`CustomVpcRestrictDefaultSG` y `CustomS3AutoDeleteObjects`) pueden dejar log groups vacíos, que se borran con `aws logs delete-log-group`.
