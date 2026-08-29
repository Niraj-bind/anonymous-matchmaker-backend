/**
 * WebRTC ICE Servers Configuration (STUN & TURN)
 * Provides fallback STUN & TURN servers for seamless P2P voice calling across NATs & Firewalls.
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function getIceServers(): IceServerConfig[] {
  const customTurnUrl = process.env.TURN_SERVER_URL;
  const customTurnUser = process.env.TURN_USERNAME;
  const customTurnPass = process.env.TURN_CREDENTIAL;

  const iceServers: IceServerConfig[] = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
        'stun:stun.services.mozilla.com',
      ],
    },
  ];

  // If custom TURN server is configured in environment
  if (customTurnUrl) {
    iceServers.push({
      urls: customTurnUrl,
      username: customTurnUser,
      credential: customTurnPass,
    });
  } else {
    // OpenRelay Public Free TURN Server (Free tier for testing / cross-network fallback)
    iceServers.push(
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelay',
        credential: 'openrelay',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelay',
        credential: 'openrelay',
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay',
      }
    );
  }

  return iceServers;
}
