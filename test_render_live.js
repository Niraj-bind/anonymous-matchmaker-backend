const https = require('https');
const io = require('socket.io-client');

const BASE_URL = 'https://anonymous-matchmaker-backend.onrender.com';

function makeRequest(path, method, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const postData = JSON.stringify(data || {});
    
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

async function testLiveRender() {
  console.log('=== TESTING LIVE RENDER POSTGRESQL API & WEBSOCKETS ===');
  
  const userA = `user_a_${Math.floor(Math.random() * 10000)}`;
  const userB = `user_b_${Math.floor(Math.random() * 10000)}`;

  console.log(`1. Registering User A (${userA})...`);
  const resA = await makeRequest('/api/auth/register', 'POST', {
    username: userA,
    password: 'password123',
    age: 22,
    gender: 'man',
  });
  console.log('User A Response:', resA.status, resA.body);

  console.log(`2. Registering User B (${userB})...`);
  const resB = await makeRequest('/api/auth/register', 'POST', {
    username: userB,
    password: 'password123',
    age: 23,
    gender: 'woman',
  });
  console.log('User B Response:', resB.status, resB.body);

  if (resA.status === 201 && resB.status === 201) {
    console.log('🎉 REGISTRATION TEST PASSED! Live PostgreSQL is working with 0 errors!');
    
    const socketA = io(BASE_URL, {
      transports: ['polling', 'websocket'],
      auth: { token: resA.body.token },
    });

    const socketB = io(BASE_URL, {
      transports: ['polling', 'websocket'],
      auth: { token: resB.body.token },
    });

    socketA.on('connect', () => {
      console.log('Live Socket A connected! ID:', socketA.id);
      socketA.emit('start_matching');
    });

    socketB.on('connect', () => {
      console.log('Live Socket B connected! ID:', socketB.id);
      socketB.emit('start_matching');
    });

    socketA.on('match_found', (data) => {
      console.log('🎉 LIVE SOCKET A MATCHED:', data);
      socketA.disconnect();
      socketB.disconnect();
      process.exit(0);
    });
  } else {
    console.error('❌ Registration test failed!');
    process.exit(1);
  }
}

testLiveRender().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
