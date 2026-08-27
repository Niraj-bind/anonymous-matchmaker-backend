const http = require('http');
const io = require('socket.io-client');

const BASE_URL = 'http://localhost:4000';

function makeRequest(path, method, data, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const postData = JSON.stringify(data || {});
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
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

async function runTest() {
  console.log('=== STARTING END-TO-END E2E TEST ===');

  // 1. Register User A
  const userAName = 'test_user_a_' + Date.now().toString().slice(-4);
  console.log(`\n1. Registering User A (${userAName})...`);
  const resA = await makeRequest('/api/auth/register', 'POST', {
    username: userAName,
    password: 'password123',
    age: 25,
    gender: 'man',
  });
  console.log('User A Response:', resA.status, resA.body);

  // 2. Register User B
  const userBName = 'test_user_b_' + Date.now().toString().slice(-4);
  console.log(`\n2. Registering User B (${userBName})...`);
  const resB = await makeRequest('/api/auth/register', 'POST', {
    username: userBName,
    password: 'password123',
    age: 24,
    gender: 'woman',
  });
  console.log('User B Response:', resB.status, resB.body);

  if (resA.status !== 201 || resB.status !== 201) {
    console.error('Registration failed!');
    process.exit(1);
  }

  const tokenA = resA.body.token;
  const appIdA = resA.body.user.appId;
  const tokenB = resB.body.token;
  const appIdB = resB.body.user.appId;

  console.log(`\nUser A App ID: ${appIdA}`);
  console.log(`User B App ID: ${appIdB}`);

  // 3. Test Layer 2 App ID Connection Request
  console.log(`\n3. Sending Connection Request from User A to User B (App ID: ${appIdB})...`);
  const connRes = await makeRequest('/api/connections/request', 'POST', { targetAppId: appIdB }, tokenA);
  console.log('Connection Request Response:', connRes.status, connRes.body);

  // 4. Test Layer 1 Ephemeral Socket Matchmaking
  console.log('\n4. Connecting WebSockets for User A and User B...');

  const socketA = io(BASE_URL, {
    transports: ['websocket'],
    auth: { token: tokenA },
  });

  const socketB = io(BASE_URL, {
    transports: ['websocket'],
    auth: { token: tokenB },
  });

  let matchDone = false;

  socketA.on('connect', () => {
    console.log('Socket A connected! ID:', socketA.id);
    console.log('Socket A emitting start_matching...');
    socketA.emit('start_matching', { gender: 'man', age: 25, preferGender: 'any', preferAgeMin: 18, preferAgeMax: 99 });
  });

  socketB.on('connect', () => {
    console.log('Socket B connected! ID:', socketB.id);
    console.log('Socket B emitting start_matching...');
    socketB.emit('start_matching', { gender: 'woman', age: 24, preferGender: 'any', preferAgeMin: 18, preferAgeMax: 99 });
  });

  socketA.on('match_found', (data) => {
    console.log('🎉 SOCKET A RECEIVED match_found:', data);
    matchDone = true;
  });

  socketB.on('match_found', (data) => {
    console.log('🎉 SOCKET B RECEIVED match_found:', data);
    matchDone = true;
  });

  setTimeout(() => {
    if (matchDone) {
      console.log('\n✅ TEST PASSED PERFECTLY! Both Users Matched Live via WebSockets!');
    } else {
      console.error('\n❌ MATCH TEST TIMEOUT! Check server socket logs.');
    }
    socketA.disconnect();
    socketB.disconnect();
    process.exit(matchDone ? 0 : 1);
  }, 4000);
}

runTest().catch((err) => {
  console.error('Test script error:', err);
  process.exit(1);
});
