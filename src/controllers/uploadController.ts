import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { uploadFileToS3 } from '../config/storage';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

export async function uploadTempMedia(req: AuthenticatedRequest, res: Response) {
  try {
    const { sessionId, base64Data, mimeType } = req.body;

    if (!sessionId || !base64Data) {
      return res.status(400).json({ error: 'Session ID and base64 media data are required' });
    }

    const type = mimeType || 'image/jpeg';
    const extension = type.split('/')[1] || 'jpg';
    const fileBuffer = Buffer.from(base64Data, 'base64');

    // Key format: temp_chats/{sessionId}/{uuid}.jpg
    const key = `temp_chats/${sessionId}/${uuidv4()}.${extension}`;
    const publicUrl = await uploadFileToS3(key, fileBuffer, type);

    return res.status(200).json({
      mediaUrl: publicUrl,
      key,
      message: 'Temporary media uploaded. Will be deleted automatically when chat room closes.',
    });
  } catch (error) {
    console.error('Error uploading temporary media:', error);
    return res.status(500).json({ error: 'Failed to upload media' });
  }
}

export async function uploadPersistentMedia(req: AuthenticatedRequest, res: Response) {
  try {
    const { connectionId, base64Data, mimeType } = req.body;

    if (!connectionId || !base64Data) {
      return res.status(400).json({ error: 'Connection ID and base64 media data are required' });
    }

    const type = mimeType || 'image/jpeg';
    const extension = type.split('/')[1] || 'jpg';
    const fileBuffer = Buffer.from(base64Data, 'base64');

    // Key format: persistent_chats/{connectionId}/{uuid}.jpg
    const key = `persistent_chats/${connectionId}/${uuidv4()}.${extension}`;
    const publicUrl = await uploadFileToS3(key, fileBuffer, type);

    return res.status(200).json({
      mediaUrl: publicUrl,
      key,
    });
  } catch (error) {
    console.error('Error uploading persistent media:', error);
    return res.status(500).json({ error: 'Failed to upload media' });
  }
}
