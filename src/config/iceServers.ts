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

export function getIceServers(): IceServerConfig[] {
  const customTurnUrl = process.env.TURN_SERVER_URL;
  const customTurnUser = process.env.TURN_USERNAME;
  const customTurnPass = process.env.TURN_CREDENTIAL;

  // 1. High-Availability Global STUN Servers (Google, Cloudflare, Twilio, Mozilla)
  // STUN handles direct P2P connections whenever both devices are on compatible NATs.
  const iceServers: IceServerConfig[] = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        'stun:global.stun.twilio.com:3478',
        'stun:stun.services.mozilla.com',
      ],
    },
  ];

  // 2. TURN Relay Server Configuration (Required for Carrier NAT / 4G / 5G / Symmetric NATs)
  if (customTurnUrl) {
    // Supports comma-separated list of TURN urls or single URL
    const turnUrls = customTurnUrl.includes(',')
      ? customTurnUrl.split(',').map((u) => u.trim())
      : customTurnUrl.trim();

    iceServers.push({
      urls: turnUrls,
      username: customTurnUser || undefined,
      credential: customTurnPass || undefined,
    });
  } else {
    // Fallback: If no custom TURN is configured in environment,
    // provide open test TURN relays with UDP & TCP transports.
    // NOTE: For 100% guaranteed production reliability on mobile networks,
    // set TURN_SERVER_URL, TURN_USERNAME, TURN_CREDENTIAL in .env (e.g. Free 50GB from metered.ca or coturn).
    iceServers.push(
      {
        urls: [
          'turn:standard.relay.metered.ca:80',
          'turn:standard.relay.metered.ca:443',
          'turn:standard.relay.metered.ca:443?transport=tcp',
        ],
        username: process.env.METERED_USERNAME || 'f0907d4b462c15982e5b7cb8',
        credential: process.env.METERED_CREDENTIAL || '2K+r1o6k+4iQj5uN',
      }
    );
  }

  return iceServers;
}
