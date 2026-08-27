import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

export const s3Client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
  },
  forcePathStyle: true,
});

export const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'anonymous-matchmaker-storage';
export const PUBLIC_STORAGE_URL = process.env.PUBLIC_STORAGE_URL || 'http://localhost:9000/anonymous-matchmaker-storage';

/**
 * Uploads a file buffer directly to Cloudflare R2 / S3 storage.
 * Fallbacks seamlessly to Data URL format if local S3/MinIO service is unavailable.
 */
export async function uploadFileToS3(key: string, buffer: Buffer, contentType: string): Promise<string> {
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });

    await s3Client.send(command);
    return `${PUBLIC_STORAGE_URL}/${key}`;
  } catch (err) {
    console.warn(`S3 connection unavailable (${err}). Using fallback Data URL for zero-dependency media rendering.`);
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }
}

/**
 * Deletes all object keys matching a prefix (e.g. temp_chats/{sessionId}/).
 * Called on room exit to ensure zero-footprint ephemeral media cleanup.
 */
export async function deleteS3Folder(prefix: string): Promise<void> {
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
    });

    const listResult = await s3Client.send(listCommand);
    if (!listResult.Contents || listResult.Contents.length === 0) {
      return;
    }

    for (const object of listResult.Contents) {
      if (object.Key) {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: object.Key,
        });
        await s3Client.send(deleteCommand);
      }
    }
    console.log(`Deleted all ephemeral storage under prefix: ${prefix}`);
  } catch (error) {
    console.error(`Failed to delete S3 folder prefix ${prefix}:`, error);
  }
}
