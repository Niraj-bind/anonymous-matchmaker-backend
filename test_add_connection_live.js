const https = require('https');

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

async function testConnectionFlow() {
  console.log('=== TESTING LIVE RENDER ADD CONNECTION (LAYER 2) ===');
  
  const userA = `user_conn_a_${Math.floor(Math.random() * 10000)}`;
  const userB = `user_conn_b_${Math.floor(Math.random() * 10000)}`;

  console.log(`1. Registering User A (${userA})...`);
  const resA = await makeRequest('/api/auth/register', 'POST', {
    username: userA,
    password: 'password123',
    age: 25,
    gender: 'man',
  });
  console.log('User A Response:', resA.status, resA.body);

  console.log(`2. Registering User B (${userB})...`);
  const resB = await makeRequest('/api/auth/register', 'POST', {
    username: userB,
    password: 'password123',
    age: 24,
    gender: 'woman',
  });
  console.log('User B Response:', resB.status, resB.body);

  const tokenA = resA.body.token;
  const appIdB = resB.body.user.appId;

  console.log(`3. User A sending connection request to User B's App ID (${appIdB})...`);
  const connRes = await makeRequest('/api/connections/request', 'POST', {
    targetAppId: appIdB,
  }, tokenA);
  
  console.log('Connection Request Result:', connRes.status, connRes.body);
}

testConnectionFlow().catch(err => {
  console.error('Test error:', err);
});
