import { Response } from 'express';
import { query } from '../config/db';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { getIceServers } from '../config/iceServers';

/**
 * Register or update Android FCM device token for background push & VoIP calls
 */
export async function updateDeviceToken(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { fcmToken, platform } = req.body;

    if (!userId || !fcmToken) {
      return res.status(400).json({ error: 'fcmToken is required' });
    }

    await query(
      `UPDATE users 
       SET fcm_token = $1, device_platform = $2, last_active_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [fcmToken.trim(), platform || 'android', userId]
    );

    console.log(`📱 Android Device Token registered for User: ${userId}`);

    return res.status(200).json({
      success: true,
      message: 'Android device token registered successfully',
    });
  } catch (error) {
    console.error('Error updating Android device token:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Android App Configuration & WebRTC Environment Bootstrap
 */
export async function getAndroidConfig(req: AuthenticatedRequest, res: Response) {
  try {
    const iceServers = getIceServers();

    return res.status(200).json({
      platform: 'android',
      version: '1.0.0',
      minSupportedVersion: '1.0.0',
      directApkDownloadUrl: process.env.DIRECT_APK_URL || null,
      iceServers,
      webrtcConstraints: {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          highpassFilter: true,
        },
        video: false,
      },
      socketConfig: {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 15,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        pingInterval: 10000,
        pingTimeout: 15000,
      },
      features: {
        audioCalling: true,
        ephemeralChat: true,
        persistentChat: true,
        mediaSharing: true,
      },
    });
  } catch (error) {
    console.error('Error fetching Android config:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
