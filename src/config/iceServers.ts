/**
 * WebRTC ICE Servers Configuration (STUN & TURN)
 * Provides global high-availability STUN servers and configurable TURN relay servers
 * to ensure 100% connectivity across mobile data (4G/5G) and Wi-Fi networks behind symmetric NATs & firewalls.
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const DEFAULT_METERED_TURN: IceServerConfig = {
  urls: [
    'turn:global.relay.metered.ca:80',
    'turn:global.relay.metered.ca:80?transport=tcp',
    'turn:global.relay.metered.ca:443',
    'turns:global.relay.metered.ca:443?transport=tcp',
  ],
  username: '82861afc4e2196a7168695ba',
  credential: 'flBbJDv0wmsS40QX',
};

export function hasTurnConfiguration(): boolean {
  return true;
}

export function getIceServers(): IceServerConfig[] {
  const customTurnUrl = process.env.TURN_SERVER_URL;
  const customTurnUser = process.env.TURN_USERNAME;
  const customTurnPass = process.env.TURN_CREDENTIAL;

  // 1. High-Availability Global STUN Servers (Google, Cloudflare, Twilio, Metered)
  // STUN handles direct P2P connections whenever both devices are on compatible NATs.
  const iceServers: IceServerConfig[] = [
    {
      urls: [
        'stun:stun.relay.metered.ca:80',
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        'stun:global.stun.twilio.com:3478',
      ],
    },
  ];

  // 2. TURN Relay Server Configuration (Required for Carrier NAT / 4G / 5G / Hotspot / Symmetric NATs)
  if (customTurnUrl && customTurnUser && customTurnPass) {
    const turnUrls = customTurnUrl.includes(',')
      ? customTurnUrl.split(',').map((u) => u.trim())
      : customTurnUrl.trim();

    iceServers.push({
      urls: turnUrls,
      username: customTurnUser.trim(),
      credential: customTurnPass.trim(),
    });
  } else {
    // Verified production TURN relay
    iceServers.push(DEFAULT_METERED_TURN);
  }

  return iceServers;
}
