'use strict';
// V61: the server closes a silent paired browser within browserDeadMs (field 14 Oct:
// ~2 min), keeps a pong-answering browser, and the browser rejoins within seconds
// (silent server, stuck connect, network "online", 5s retry cap).
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const vm = require('node:vm');
const UnifiedAppServer = require('./server-core.js');

function client(port) {
  const socket = net.connect(port, '127.0.0.1');
  let buf = Buffer.alloc(0), upgraded = false;
  const messages = [], c = { socket, messages, pings: 0, answerPings: true, closed: false };
  const frame = (op, body) => { const p = Buffer.from(body); const h = Buffer.alloc(6 + (p.length > 125 ? 2 : 0));
    h[0] = 0x80 | op; if (p.length > 125) { h[1] = 0xfe; h.writeUInt16BE(p.length, 2); } else h[1] = 0x80 | p.length; // zero mask
    return Buffer.concat([h, p]); };
  c.send = obj => socket.write(frame(1, JSON.stringify(obj)));
  socket.on('close', () => { c.closed = true; });
  socket.on('error', () => {});
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; upgraded = true; buf = buf.slice(i + 4); }
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + len) return;
      const op = buf[0] & 0x0f, body = buf.slice(off, off + len); buf = buf.slice(off + len);
      if (op === 0x9) { c.pings++; if (c.answerPings) socket.write(frame(0xA, body)); }
      else if (op === 0x1) messages.push(JSON.parse(body.toString()));
      else if (op === 0x8) c.closed = true;
    }
  });
  return new Promise(resolve => socket.on('connect', () => {
    socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
      'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Protocol: karcast-v1\r\n\r\n');
    resolve(c);
  }));
}
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('timeout: ' + label); };

async function pair(port) {
  const phone = await client(port);
  phone.send({ version: '1.0', type: 'register', messageId: 'r', timestamp: Date.now(), phone_token: 'b'.repeat(64) });
  await until(() => phone.messages.find(m => m.type === 'registered'), 2000, 'registered');
  const code = phone.messages.find(m => m.type === 'registered').pairingCode;
  const browser = await client(port);
  browser.send({ version: '1.0', type: 'join', pairingCode: code, messageId: 'j', timestamp: Date.now() });
  await until(() => phone.messages.find(m => m.type === 'peer_ready'), 2000, 'peer_ready');
  return { phone, browser };
}

async function serverTests() {
  const server = new UnifiedAppServer({ port: 0, browserPingMs: 300, browserDeadMs: 1000 });
  const port = await server.start();
  let detectMs;
  try {
    // 1. A browser whose network vanished (answers nothing) is closed in ~1s; phone is told.
    const dead = await pair(port);
    dead.browser.answerPings = false;
    const t0 = Date.now();
    await until(() => dead.phone.messages.find(m => m.type === 'closed' && /Browser disconnected/.test(m.reason || '')), 4000, 'dead browser detected');
    detectMs = Date.now() - t0;
    assert(detectMs <= 2500, `silent browser detected in ${detectMs}ms (was ~2 minutes)`);
    assert(server.livenessCounters.deadBrowsersClosed >= 1);
    // 2. A live browser answering WebSocket pings is never closed and receives liveness heartbeats.
    const live = await pair(port);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(live.browser.closed, false, 'pong-answering browser stays connected');
    assert(live.browser.pings >= 2, 'server pings an idle browser');
    assert(live.browser.messages.some(m => m.type === 'heartbeat' && m.serverLiveness), 'server sends liveness heartbeats');
    assert(!live.phone.messages.some(m => m.type === 'closed'), 'phone of a live browser is not told it closed');
    for (const c of [dead.phone, dead.browser, live.phone, live.browser]) c.socket.destroy();
  } finally { await server.stop(); }
  return { detectMs };
}

function browserTests() {
  let now = 1000000; const timers = [], intervals = [], listeners = {}, sockets = [];
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { hidden: true, value: '', textContent: '', style: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, getContext() { return { drawImage() {} }; } }); return nodes.get(id); };
  class Socket { static OPEN = 1; constructor() { this.readyState = 0; this.sent = []; sockets.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; } }
  const window = { VideoDecoder: class { configure() {} close() {} decode() {} }, EncodedVideoChunk: class {}, location: { search: '?transport=relay&pair_code=123456' },
    addEventListener(type, fn) { listeners[type] = fn; } };
  const context = { window, document: { getElementById: node }, location: { protocol: 'https:', host: 'staging.karcast.app' }, URLSearchParams, WebSocket: Socket,
    Uint8Array, ArrayBuffer, DataView, Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(process.env.KARCAST_SOURCE || 'public/app.js', 'utf8'), context);
  const hooks = window.__KARCAST_TEST_HOOKS__;
  const tick = () => intervals.find(i => i.ms === 1000).fn();
  const open = s => { s.readyState = 1; s.onopen(); };
  hooks.connectAndJoin(); open(sockets.at(-1));

  // a) Against a server that never sent liveness heartbeats, silence is tolerated (older servers).
  now += 20000; tick();
  assert.equal(sockets.length, 1, 'no liveness enforcement without server liveness heartbeats');
  // b) After a liveness heartbeat, 8s of silence triggers an immediate rejoin.
  sockets[0].onmessage({ data: JSON.stringify({ type: 'heartbeat', serverLiveness: true }) });
  now += 7000; tick(); assert.equal(sockets.length, 1, '7s silence is still alive');
  now += 1500; tick(); assert.equal(sockets.length, 2, 'silent signaling rejoins immediately');
  assert.equal(hooks.getDiagnostics().lastFastRejoinReason, 'signaling silent');
  // c) A connection attempt stuck in CONNECTING is retried after 6s.
  now += 6500; tick(); assert.equal(sockets.length, 3, 'stuck connect is retried');
  // d) The network "online" event rejoins at once.
  open(sockets.at(-1)); sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'heartbeat', serverLiveness: true }) });
  now += 5000; listeners.online(); assert.equal(sockets.length, 4, 'online event rejoins');
  open(sockets.at(-1)); sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'heartbeat', serverLiveness: true }) });
  listeners.online(); assert.equal(sockets.length, 4, 'online does nothing while signaling is fresh');
  // e) Paced retries are capped at 5s (were 10s).
  for (let i = 0; i < 6; i++) { const s = sockets.at(-1); s.onclose({ code: 1006 }); timers.at(-1).fn(); }
  const retryDelays = timers.filter(t => t.ms >= 2500 && t.ms <= 10000).map(t => t.ms);
  assert(retryDelays.length > 0 && Math.max(...retryDelays) <= 5000, `retry delays capped at 5s: ${retryDelays}`);
  return { fastRejoins: hooks.getDiagnostics().fastRejoins };
}

(async () => {
  const s = await serverTests();
  const b = browserTests();
  console.log(`PASS V61 reconnect: silent browser closed in ${s.detectMs}ms, live browser kept, browser rejoins on silence/stuck connect/online (${b.fastRejoins}), retries capped at 5s`);
})().catch(e => { console.error(e); process.exitCode = 1; });
