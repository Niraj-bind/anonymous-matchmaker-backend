"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadTempMedia = uploadTempMedia;
exports.uploadPersistentMedia = uploadPersistentMedia;
const uuid_1 = require("uuid");
const storage_1 = require("../config/storage");
async function uploadTempMedia(req, res) {
    try {
        const { sessionId, base64Data, mimeType } = req.body;
        if (!sessionId || !base64Data) {
            return res.status(400).json({ error: 'Session ID and base64 media data are required' });
        }
        const type = mimeType || 'image/jpeg';
        const extension = type.split('/')[1] || 'jpg';
        const fileBuffer = Buffer.from(base64Data, 'base64');
        // Key format: temp_chats/{sessionId}/{uuid}.jpg
        const key = `temp_chats/${sessionId}/${(0, uuid_1.v4)()}.${extension}`;
        const publicUrl = await (0, storage_1.uploadFileToS3)(key, fileBuffer, type);
        return res.status(200).json({
            mediaUrl: publicUrl,
            key,
            message: 'Temporary media uploaded. Will be deleted automatically when chat room closes.',
        });
    }
    catch (error) {
        console.error('Error uploading temporary media:', error);
        return res.status(500).json({ error: 'Failed to upload media' });
    }
}
async function uploadPersistentMedia(req, res) {
    try {
        const { connectionId, base64Data, mimeType } = req.body;
        if (!connectionId || !base64Data) {
            return res.status(400).json({ error: 'Connection ID and base64 media data are required' });
        }
        const type = mimeType || 'image/jpeg';
        const extension = type.split('/')[1] || 'jpg';
        const fileBuffer = Buffer.from(base64Data, 'base64');
        // Key format: persistent_chats/{connectionId}/{uuid}.jpg
        const key = `persistent_chats/${connectionId}/${(0, uuid_1.v4)()}.${extension}`;
        const publicUrl = await (0, storage_1.uploadFileToS3)(key, fileBuffer, type);
        return res.status(200).json({
            mediaUrl: publicUrl,
            key,
        });
    }
    catch (error) {
        console.error('Error uploading persistent media:', error);
        return res.status(500).json({ error: 'Failed to upload media' });
    }
}
