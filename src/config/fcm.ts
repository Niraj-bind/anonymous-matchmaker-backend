import { initializeApp, cert, applicationDefault, App } from 'firebase-admin/app';
import { getMessaging, Message } from 'firebase-admin/messaging';
import dotenv from 'dotenv';

dotenv.config();

let firebaseApp: App | null = null;
let isFcmInitialized = false;

// Initialize Firebase Admin SDK for Android Push Notifications
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let serviceAccount: any;
    try {
      // Check if it's a JSON string or file path
      if (process.env.FIREBASE_SERVICE_ACCOUNT.trim().startsWith('{')) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      } else {
        serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT);
      }
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
      isFcmInitialized = true;
      console.log('🔔 Firebase Admin FCM initialized successfully for Android push notifications.');
    } catch (parseErr: any) {
      console.warn('🔔 Failed to parse FIREBASE_SERVICE_ACCOUNT:', parseErr.message);
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    firebaseApp = initializeApp({
      credential: applicationDefault(),
    });
    isFcmInitialized = true;
    console.log('🔔 Firebase Admin FCM initialized via Application Default Credentials.');
  } else {
    console.log('🔔 Note: FIREBASE_SERVICE_ACCOUNT not configured. FCM push notifications will run in mock/log mode.');
  }
} catch (e: any) {
  console.warn('🔔 Firebase Admin initialization warning:', e.message);
}

/**
 * Universal FCM Push Notification Dispatcher for Android
 */
export async function sendAndroidDataPush(fcmToken: string, dataPayload: Record<string, string>): Promise<boolean> {
  if (!fcmToken) return false;

  if (!isFcmInitialized || !firebaseApp) {
    console.log(`[FCM-SIMULATED-ANDROID-PUSH] To: ${fcmToken.slice(0, 12)}... Payload:`, dataPayload);
    return true;
  }

  try {
    const messaging = getMessaging(firebaseApp);
    const message: Message = {
      token: fcmToken,
      data: dataPayload,
      android: {
        priority: 'high',
        ttl: 30 * 1000, // 30 seconds for real-time alerts
      },
    };

    const response = await messaging.send(message);
    console.log(`🔔 FCM Android Push delivered successfully. Message ID: ${response}`);
    return true;
  } catch (err: any) {
    console.error('🔔 Failed to send FCM Android push:', err.message);
    return false;
  }
}

/**
 * High-Priority Data Push for Incoming Android Voice Call (Full-Screen Intent)
 */
export async function sendAndroidIncomingCallPush(
  fcmToken: string,
  data: {
    callId: string;
    callerUserId: string;
    callerUsername: string;
    callerAppId: string;
    connectionId: string;
    isVideo: boolean;
  }
) {
  return sendAndroidDataPush(fcmToken, {
    type: 'incoming_call',
    callId: data.callId,
    callerUserId: data.callerUserId,
    callerUsername: data.callerUsername,
    callerAppId: data.callerAppId,
    connectionId: data.connectionId,
    isVideo: String(data.isVideo),
    timestamp: new Date().toISOString(),
  });
}

/**
 * High-Priority Call Cancel / End Push (Dismisses incoming call ring on Android)
 */
export async function sendAndroidCallEndedPush(fcmToken: string, data: { callId: string; reason?: string }) {
  return sendAndroidDataPush(fcmToken, {
    type: 'call_ended',
    callId: data.callId,
    reason: data.reason || 'ended',
  });
}

/**
 * High-Priority Chat Message Push for Android
 */
export async function sendAndroidChatMessagePush(
  fcmToken: string,
  data: {
    connectionId: string;
    senderId: string;
    senderUsername: string;
    messageText?: string;
    mediaUrl?: string;
  }
) {
  return sendAndroidDataPush(fcmToken, {
    type: 'new_message',
    connectionId: data.connectionId,
    senderId: data.senderId,
    senderUsername: data.senderUsername,
    messageText: data.messageText || (data.mediaUrl ? '📷 [Image]' : ''),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Connection Request Push for Android
 */
export async function sendAndroidConnectionRequestPush(
  fcmToken: string,
  data: {
    connectionId: string;
    senderId: string;
    senderUsername: string;
    senderAppId: string;
  }
) {
  return sendAndroidDataPush(fcmToken, {
    type: 'connection_request',
    connectionId: data.connectionId,
    senderId: data.senderId,
    senderUsername: data.senderUsername,
    senderAppId: data.senderAppId,
  });
}
