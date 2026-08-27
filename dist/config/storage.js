"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUBLIC_STORAGE_URL = exports.BUCKET_NAME = exports.s3Client = void 0;
exports.uploadFileToS3 = uploadFileToS3;
exports.deleteS3Folder = deleteS3Folder;
const client_s3_1 = require("@aws-sdk/client-s3");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.s3Client = new client_s3_1.S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
    },
    forcePathStyle: true,
});
exports.BUCKET_NAME = process.env.S3_BUCKET_NAME || 'anonymous-matchmaker-storage';
exports.PUBLIC_STORAGE_URL = process.env.PUBLIC_STORAGE_URL || 'http://localhost:9000/anonymous-matchmaker-storage';
/**
 * Uploads a file buffer directly to Cloudflare R2 / S3 storage.
 * Fallbacks seamlessly to Data URL format if local S3/MinIO service is unavailable.
 */
async function uploadFileToS3(key, buffer, contentType) {
    try {
        const command = new client_s3_1.PutObjectCommand({
            Bucket: exports.BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        });
        await exports.s3Client.send(command);
        return `${exports.PUBLIC_STORAGE_URL}/${key}`;
    }
    catch (err) {
        console.warn(`S3 connection unavailable (${err}). Using fallback Data URL for zero-dependency media rendering.`);
        return `data:${contentType};base64,${buffer.toString('base64')}`;
    }
}
/**
 * Deletes all object keys matching a prefix (e.g. temp_chats/{sessionId}/).
 * Called on room exit to ensure zero-footprint ephemeral media cleanup.
 */
async function deleteS3Folder(prefix) {
    try {
        const listCommand = new client_s3_1.ListObjectsV2Command({
            Bucket: exports.BUCKET_NAME,
            Prefix: prefix,
        });
        const listResult = await exports.s3Client.send(listCommand);
        if (!listResult.Contents || listResult.Contents.length === 0) {
            return;
        }
        for (const object of listResult.Contents) {
            if (object.Key) {
                const deleteCommand = new client_s3_1.DeleteObjectCommand({
                    Bucket: exports.BUCKET_NAME,
                    Key: object.Key,
                });
                await exports.s3Client.send(deleteCommand);
            }
        }
        console.log(`Deleted all ephemeral storage under prefix: ${prefix}`);
    }
    catch (error) {
        console.error(`Failed to delete S3 folder prefix ${prefix}:`, error);
    }
}
