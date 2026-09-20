'use strict';

const assert = require('assert/strict');
const http = require('http');
const UnifiedAppServer = require('./server-core.js');
const WsSocket = require('./tools/signal-server/ws_frame.cjs');
const { PROTOCOL_VERSION, MSG_TYPES } = require('./tools/signal-server/protocol.cjs');

function connectClient(port, clientIp = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const key = require('crypto').randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      agent: false,
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        'X-Forwarded-For': clientIp
      }
    });

    req.on('upgrade', (res, socket) => {
      const client = new WsSocket(socket);
      client.messages = [];
      client.on('message', text => {
        try {
          const json = JSON.parse(text);
          client.messages.push(json);
          client.emit('json_message', json);
        } catch (_) {}
      });
      resolve(client);
    });

    req.on('error', err => reject(err));
    req.end();
  });
}

function waitMessage(client, filterFn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const idx = client.messages.findIndex(filterFn);
    if (idx >= 0) {
      return resolve(client.messages.splice(idx, 1)[0]);
    }
    const timeout = setTimeout(() => {
      client.removeListener('json_message', onMsg);
      reject(new Error(`Timeout waiting for message. Msgs: ${JSON.stringify(client.messages)}`));
    }, timeoutMs);

    function onMsg(msg) {
      if (filterFn(msg)) {
        clearTimeout(timeout);
        client.removeListener('json_message', onMsg);
        const findIdx = client.messages.indexOf(msg);
        if (findIdx >= 0) client.messages.splice(findIdx, 1);
        resolve(msg);
      }
    }
    client.on('json_message', onMsg);
  });
}

(async () => {
  console.log('=== KarCast Web Deployment Server Test Suite ===\n');

  const server = new UnifiedAppServer({ port: 0 });
  const port = await server.start();
  console.log(`Test server running on port ${port}`);

  // Test 1: GET / (index.html)
  {
    const res = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${port}/`, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('<title>KarCast</title>'));
    console.log('PASS 1: GET / serves public/index.html');
  }

  // Test 2: GET /style.css
  {
    const res = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${port}/style.css`, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/css'));
    assert.ok(res.body.includes('--primary-color'));
    console.log('PASS 2: GET /style.css serves public/style.css');
  }

  // Test 3: GET /app.js
  {
    const res = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${port}/app.js`, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/javascript'));
    assert.ok(res.body.includes('phase3d-unified-client'));
    console.log('PASS 3: GET /app.js serves public/app.js');
  }

  // Test 4: GET /health
  {
    const res = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${port}/health`, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, 'app.karcast.app');
    console.log('PASS 4: GET /health returns 200 OK');
  }

  // Test 5: WebSocket Signaling Relay on /ws (Phone Register -> Browser Join -> Offer -> Answer)
  {
    const phone = await connectClient(port);
    phone.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.REGISTER }));
    const reg = await waitMessage(phone, m => m.type === MSG_TYPES.REGISTERED);

    const browser = await connectClient(port);
    browser.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.JOIN, pairingCode: reg.pairingCode }));
    await waitMessage(browser, m => m.type === MSG_TYPES.JOINED);

    browser.send(JSON.stringify({
      version: PROTOCOL_VERSION,
      type: MSG_TYPES.OFFER,
      sessionId: reg.sessionId,
      sdp: 'v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96'
    }));

    const offerPhone = await waitMessage(phone, m => m.type === MSG_TYPES.OFFER);
    assert.ok(offerPhone.sdp);

    phone.send(JSON.stringify({
      version: PROTOCOL_VERSION,
      type: MSG_TYPES.ANSWER,
      sessionId: reg.sessionId,
      sdp: 'v=0\r\no=- 654321 2 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96'
    }));

    const answerBrowser = await waitMessage(browser, m => m.type === MSG_TYPES.ANSWER);
    assert.ok(answerBrowser.sdp);

    phone.close();
    browser.close();
    console.log('PASS 5: WebSocket upgrade on /ws handles full signaling exchange');
  }

  // Test 6: Concurrency Load Test (100 Simultaneous Sessions)
  {
    console.log('\nStarting 100-Session Concurrency Load Test...');
    const COUNT = 100;
    const BATCH_SIZE = 20;
    const start = Date.now();

    const pairs = [];
    for (let batch = 0; batch < COUNT; batch += BATCH_SIZE) {
      const batchPromises = [];
      for (let i = batch; i < batch + BATCH_SIZE; i++) {
        batchPromises.push((async () => {
          const phoneIp = `10.0.${Math.floor(i / 200)}.${i % 200}`;
          const browserIp = `10.1.${Math.floor(i / 200)}.${i % 200}`;

          const p = await connectClient(port, phoneIp);
          p.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.REGISTER }));
          const reg = await waitMessage(p, m => m.type === MSG_TYPES.REGISTERED);

          const b = await connectClient(port, browserIp);
          b.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.JOIN, pairingCode: reg.pairingCode }));
          await waitMessage(b, m => m.type === MSG_TYPES.JOINED);

          return { p, b, sessionId: reg.sessionId };
        })());
      }
      const results = await Promise.all(batchPromises);
      pairs.push(...results);
    }

    assert.equal(pairs.length, COUNT);

    for (const item of pairs) {
      item.p.close();
      item.b.close();
    }

    const elapsed = Date.now() - start;
    console.log(`PASS 6: 100 simultaneous transient sessions connected & cleaned up in ${elapsed} ms!`);
  }

  await server.stop();
  console.log('\n=== All Deployment Server Integration & Load Tests PASSED ===');
})().catch(err => {
  console.error('\nFAIL: Deployment Server Test Failed:', err);
  process.exit(1);
});
