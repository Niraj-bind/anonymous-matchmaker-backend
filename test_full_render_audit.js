const https = require('https');
const io = require('socket.io-client');

const BASE_URL = 'https://anonymous-matchmaker-backend.onrender.com';

function makeRequest(path, method, data, token) {
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
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
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

async function runAudit() {
  console.log('====================================================');
  console.log('🕵️ FULL RENDER LIVE AUDIT: LAYER 1 & LAYER 2');
  console.log('====================================================');

  const randStr = Math.floor(Math.random() * 100000);
  const usernameA = `test_audit_a_${randStr}`;
  const usernameB = `test_audit_b_${randStr}`;

  console.log(`\n1. Creating User A (${usernameA})...`);
  const userA = await makeRequest('/api/auth/register', 'POST', {
    username: usernameA,
    password: 'Password123!',
    age: 22,
    gender: 'man',
  });
  console.log('User A Result:', userA.status, userA.body.user?.appId);

  console.log(`\n2. Creating User B (${usernameB})...`);
  const userB = await makeRequest('/api/auth/register', 'POST', {
    username: usernameB,
    password: 'Password123!',
    age: 23,
    gender: 'woman',
  });
  console.log('User B Result:', userB.status, userB.body.user?.appId);

  if (userA.status !== 201 || !userA.body.token) {
    console.error('FAILED TO REGISTER USER A');
    return;
  }

  const tokenA = userA.body.token;
  const tokenB = userB.body.token;
  const appIdB = userB.body.user.appId;

  // TEST LAYER 2: App ID Connection Request
  console.log(`\n3. [LAYER 2] User A requesting connection to User B App ID (${appIdB})...`);
  const connReq = await makeRequest('/api/connections/request', 'POST', {
    targetAppId: appIdB,
  }, tokenA);
  console.log('Layer 2 Request Status:', connReq.status, connReq.body);

  console.log(`\n4. [LAYER 2] User B fetching pending connections...`);
  const getConns = await makeRequest('/api/connections', 'GET', null, tokenB);
  console.log('Layer 2 User B Connections List:', getConns.status, getConns.body);

  // TEST LAYER 1: Socket Matchmaker Pairing
  console.log(`\n5. [LAYER 1] Connecting Socket A & Socket B to ${BASE_URL}...`);
  
  const socketA = io(BASE_URL, {
    transports: ['polling', 'websocket'],
    auth: { token: tokenA },
    query: { token: tokenA },
    extraHeaders: { Authorization: `Bearer ${tokenA}` },
  });

  const socketB = io(BASE_URL, {
    transports: ['polling', 'websocket'],
    auth: { token: tokenB },
    query: { token: tokenB },
    extraHeaders: { Authorization: `Bearer ${tokenB}` },
  });

  socketA.on('connect_error', (err) => console.error('Socket A Connect Error:', err.message));
  socketB.on('connect_error', (err) => console.error('Socket B Connect Error:', err.message));

  let connectedA = false;
  let connectedB = false;

  socketA.on('connect', () => {
    console.log('Socket A Connected! ID:', socketA.id);
    connectedA = true;
    checkAndStartMatching();
  });

  socketB.on('connect', () => {
    console.log('Socket B Connected! ID:', socketB.id);
    connectedB = true;
    checkAndStartMatching();
  });

  function checkAndStartMatching() {
    if (connectedA && connectedB) {
      console.log('\n6. Both Sockets connected! Emitting start_matching from both...');
      socketA.emit('start_matching', { gender: 'man', age: 22, preferGender: 'any', preferAgeMin: 18, preferAgeMax: 99 });
      socketB.emit('start_matching', { gender: 'woman', age: 23, preferGender: 'any', preferAgeMin: 18, preferAgeMax: 99 });
    }
  }

  socketA.on('matching_started', (data) => console.log('Socket A matching_started:', data));
  socketB.on('matching_started', (data) => console.log('Socket B matching_started:', data));

  socketA.on('match_found', (data) => {
    console.log('\n🎉 [LAYER 1 SUCCESS] SOCKET A MATCHED:', data);
    socketA.disconnect();
    socketB.disconnect();
    process.exit(0);
  });

  socketB.on('match_found', (data) => {
    console.log('\n🎉 [LAYER 1 SUCCESS] SOCKET B MATCHED:', data);
  });
}

runAudit().catch(err => console.error('Audit script exception:', err));
