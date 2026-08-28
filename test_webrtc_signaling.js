const io = require('socket.io-client');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_32chars';
const BASE_URL = 'http://localhost:4000';

const userAId = 'user_caller_' + Date.now();
const userBId = 'user_callee_' + Date.now();

const tokenA = jwt.sign({ userId: userAId, appId: 'USERA1' }, JWT_SECRET);
const tokenB = jwt.sign({ userId: userBId, appId: 'USERB1' }, JWT_SECRET);

console.log('=== TESTING WEBRTC VOICE CALL SIGNALING ===');

const socketA = io(BASE_URL, {
  transports: ['polling', 'websocket'],
  auth: { token: tokenA },
});

const socketB = io(BASE_URL, {
  transports: ['polling', 'websocket'],
  auth: { token: tokenB },
});

let aConnected = false;
let bConnected = false;
let testPassed = false;

function checkReady() {
  if (aConnected && bConnected) {
    console.log('\nBoth Sockets Connected! Starting WebRTC Relay...');
    setTimeout(() => {
      console.log('1. Sending WebRTC SDP Offer from User A -> User B...');
      socketA.emit('webrtc_offer', {
        targetUserId: userBId,
        callId: 'call_test_123',
        sdp: { type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1...' },
      });
    }, 500);
  }
}

socketA.on('connect', () => {
  console.log('Caller Socket A connected:', socketA.id);
  aConnected = true;
  checkReady();
});

socketB.on('connect', () => {
  console.log('Callee Socket B connected:', socketB.id);
  bConnected = true;
  checkReady();
});

socketB.on('webrtc_offer', (data) => {
  console.log('🎉 Socket B received webrtc_offer from:', data.senderId);
  console.log('2. Sending WebRTC SDP Answer from User B -> User A...');
  socketB.emit('webrtc_answer', {
    targetUserId: data.senderId,
    callId: data.callId,
    sdp: { type: 'answer', sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1...' },
  });
});

socketA.on('webrtc_answer', (data) => {
  console.log('🎉 Socket A received webrtc_answer from:', data.senderId);
  console.log('3. Exchanging ICE candidates...');
  socketA.emit('ice_candidate', {
    targetUserId: userBId,
    callId: data.callId,
    candidate: { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  });
});

socketB.on('ice_candidate', (data) => {
  console.log('🎉 Socket B received ice_candidate from:', data.senderId);
  console.log('4. User A ending call...');
  socketA.emit('end_call', {
    targetUserId: userBId,
    callId: data.callId,
  });
});

socketB.on('call_ended', (data) => {
  console.log('🎉 Socket B received call_ended event:', data);
  testPassed = true;
  console.log('\n✅ WEBRTC VOICE CALL SIGNALING TEST PASSED 100%!');
  socketA.disconnect();
  socketB.disconnect();
  process.exit(0);
});

setTimeout(() => {
  if (!testPassed) {
    console.error('❌ WebRTC test timeout!');
    socketA.disconnect();
    socketB.disconnect();
    process.exit(1);
  }
}, 8000);
