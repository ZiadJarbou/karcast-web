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
      client.binaryMessages = [];
      client.on('message', text => {
        try {
          const json = JSON.parse(text);
          client.messages.push(json);
          client.emit('json_message', json);
        } catch (_) {}
      });
      client.on('binary', data => {
        client.binaryMessages.push(Buffer.from(data));
        client.emit('binary_message', data);
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

function waitBinary(client, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (client.binaryMessages.length) return resolve(client.binaryMessages.shift());
    const timeout = setTimeout(() => {
      client.removeListener('binary_message', onData);
      reject(new Error('Timeout waiting for binary relay frame'));
    }, timeoutMs);
    function onData(data) {
      clearTimeout(timeout);
      client.removeListener('binary_message', onData);
      client.binaryMessages.shift();
      resolve(Buffer.from(data));
    }
    client.on('binary_message', onData);
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
    assert.ok(res.body.includes('id="connection-progress-value"'));
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
    assert.ok(res.body.includes('object-fit: contain'));
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
    assert.ok(res.body.includes('setProgressMilestone(100)'));
    assert.ok(res.body.includes("requestedTransport === 'relay'"));
    assert.ok(res.body.includes('displayWidth = sourceWidth * scale'));
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

  // Test 6: Browser disconnect keeps the phone session available for rejoin
  // Test 6: Paired relay forwards control to phone and binary media to browser
  {
    const phone = await connectClient(port, '10.4.0.1');
    phone.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.REGISTER }));
    const reg = await waitMessage(phone, m => m.type === MSG_TYPES.REGISTERED);
    const browser = await connectClient(port, '10.4.0.2');
    browser.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.JOIN, pairingCode: reg.pairingCode }));
    await waitMessage(browser, m => m.type === MSG_TYPES.JOINED);

    browser.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.RELAY_START, sessionId: reg.sessionId }));
    const relayStart = await waitMessage(phone, m => m.type === MSG_TYPES.RELAY_START);
    assert.equal(relayStart.sessionId, reg.sessionId);

    const frame = Buffer.from([0x4b, 0x43, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0x65]);
    phone.sendBinary(frame);
    assert.deepEqual(await waitBinary(browser), frame);
    phone.close();
    browser.close();
    console.log('PASS 6: Paired secure relay forwards control and binary H.264 frames');
  }

  // Test 7: Browser disconnect keeps the phone session available for rejoin
  {
    const phone = await connectClient(port, '10.2.0.1');
    phone.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.REGISTER }));
    const reg = await waitMessage(phone, m => m.type === MSG_TYPES.REGISTERED);

    const firstBrowser = await connectClient(port, '10.2.0.2');
    firstBrowser.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.JOIN, pairingCode: reg.pairingCode }));
    await waitMessage(firstBrowser, m => m.type === MSG_TYPES.JOINED);
    firstBrowser.close();

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      phone.messages.some(m => m.type === MSG_TYPES.CLOSED),
      false,
      'A signaling-only browser disconnect must not tear down phone WebRTC'
    );

    const secondBrowser = await connectClient(port, '10.2.0.3');
    secondBrowser.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.JOIN, pairingCode: reg.pairingCode }));
    const rejoined = await waitMessage(secondBrowser, m => m.type === MSG_TYPES.JOINED);
    assert.equal(rejoined.sessionId, reg.sessionId);

    secondBrowser.close();
    phone.close();
    console.log('PASS 6: Browser signaling disconnect preserves media and allows rejoin');
  }

  // Test 7: A vehicle auto-join takes over a phone session held by another browser
  {
    const phone = await connectClient(port, '10.3.0.1');
    phone.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.REGISTER }));
    const reg = await waitMessage(phone, m => m.type === MSG_TYPES.REGISTERED);

    const desktop = await connectClient(port, '10.3.0.2');
    desktop.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.JOIN, pairingCode: reg.pairingCode }));
    await waitMessage(desktop, m => m.type === MSG_TYPES.JOINED);

    const vehicle = await connectClient(port, '10.3.0.3');
    vehicle.send(JSON.stringify({ version: PROTOCOL_VERSION, type: MSG_TYPES.JOIN, pairingCode: 'auto' }));
    const joined = await waitMessage(vehicle, m => m.type === MSG_TYPES.JOINED);
    const replaced = await waitMessage(desktop, m => m.type === MSG_TYPES.CLOSED);

    assert.equal(joined.sessionId, reg.sessionId);
    assert.equal(replaced.reason, 'Another vehicle browser connected');
    assert.ok(server.sessionStore.getSessionById(reg.sessionId).browserSocket);
    assert.equal(server.sessionStore.browserToSession.size, 1);

    vehicle.close();
    desktop.close();
    phone.close();
    console.log('PASS 7: Vehicle auto-join takes over an existing desktop browser session');
  }

  // Test 8: Concurrency Load Test (100 Simultaneous Sessions)
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
    console.log(`PASS 8: 100 simultaneous transient sessions connected & cleaned up in ${elapsed} ms!`);
  }

  await server.stop();
  console.log('\n=== All Deployment Server Integration & Load Tests PASSED ===');
})().catch(err => {
  console.error('\nFAIL: Deployment Server Test Failed:', err);
  process.exit(1);
});
