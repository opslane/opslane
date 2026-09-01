/** Minimal MinIO/S3 client for fetching objects from the worker. */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export interface MinIOConfig {
  endpoint: string;     // e.g., http://minio:9000
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function getMinIOConfig(): MinIOConfig | null {
  const endpoint = process.env['MINIO_ENDPOINT'] ?? process.env['REPLAY_STORE_ENDPOINT'];
  const accessKey = process.env['MINIO_ACCESS_KEY'] ?? process.env['REPLAY_STORE_ACCESS_KEY'];
  const secretKey = process.env['MINIO_SECRET_KEY'] ?? process.env['REPLAY_STORE_SECRET_KEY'];
  const bucket = process.env['MINIO_BUCKET'] ?? process.env['REPLAY_STORE_BUCKET'] ?? 'opslane-replays';

  if (!endpoint || !accessKey || !secretKey) return null;
  return { endpoint, accessKey, secretKey, bucket };
}

let cachedClient: S3Client | null = null;
let cachedConfig: MinIOConfig | null = null;

function getS3Client(config: MinIOConfig): S3Client {
  if (cachedClient && cachedConfig === config) return cachedClient;
  cachedClient = new S3Client({
    endpoint: config.endpoint,
    region: 'auto',
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
  cachedConfig = config;
  return cachedClient;
}

/** Fetch an object from S3/R2/MinIO by object key. Returns the raw Buffer. */
export async function fetchObject(objectKey: string, config: MinIOConfig): Promise<Buffer> {
  const client = getS3Client(config);
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
  });

  const response = await client.send(command);
  if (!response.Body) {
    throw new Error(`Empty response body for ${objectKey}`);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function putFrameObject(
  objectKey: string,
  body: Buffer,
  config: MinIOConfig,
): Promise<void> {
  await getS3Client(config).send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: 'image/png',
  }));
}
