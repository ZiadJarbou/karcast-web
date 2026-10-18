'use strict';
// V60: rejected typed pairing codes are reported (no silent retry loop), DIRECT
// ICE candidate classes are counted without addresses, and the server relay
// repeats its keyframe request while it waits for an IDR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const RelayFreshness = require('./relay-freshness.cjs');

function browser(search) {
  const nodes = new Map(), timers = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: id === 'pair-form', value: '', textContent: '', style: {}, classList: { toggle() {} },
      setAttribute() {}, events: {}, addEventListener(type, cb) { this.events[type] = cb; }, getContext() { return { drawImage() {} }; } });
    return nodes.get(id);
  };
  let socket, peer;
  class Socket { static OPEN = 1; constructor() { this.readyState = 1; this.sent = []; this.closed = false; socket = this; }
    send(d) { this.sent.push(JSON.parse(d)); } close() { this.closed = true; } }
  class Peer { constructor() { peer = this; this.iceConnectionState = 'new'; this.connectionState = 'new'; }
    createDataChannel() { return { readyState: 'connecting', send() {}, close() {} }; } addTransceiver() { return { receiver: {} }; }
    async createOffer() { return { type: 'offer', sdp: 'fixture' }; } async setLocalDescription() {} async setRemoteDescription() {}
    addIceCandidate() { return Promise.resolve(); } getStats() { return Promise.resolve(new Map([['a', { type: 'candidate-pair', state: 'failed' }], ['b', { type: 'candidate-pair', state: 'failed' }]])); } close() {} }
  const window = { VideoDecoder: class { configure() {} close() {} decode() {} }, EncodedVideoChunk: class {}, location: { search }, addEventListener() {} };
  const context = { window, document: { getElementById: node }, location: { protocol: 'https:', host: 'staging.karcast.app' },
    URLSearchParams, WebSocket: Socket, RTCPeerConnection: Peer, Uint8Array, ArrayBuffer, DataView, Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(process.env.KARCAST_SOURCE || 'public/app.js', 'utf8'), context);
  return { hooks: window.__KARCAST_TEST_HOOKS__, node, timers, socket: () => socket, peer: () => peer };
}

(async () => {
  // 1. Typed code rejected: visible reason, form shown again, no hidden reconnect timer.
  for (const code of ['PAIRING_CODE_INVALID', 'SESSION_ALREADY_PAIRED', 'PAIRING_CODE_EXPIRED']) {
    const b = browser('?transport=relay&pair_code=123456');
    b.hooks.connectAndJoin(); b.socket().onopen();
    const timersBefore = b.timers.length;
    b.socket().onmessage({ data: JSON.stringify({ type: 'error', code, message: 'x' }) });
    assert.equal(b.hooks.getUIState(), code === 'PAIRING_CODE_EXPIRED' ? 'CODE_EXPIRED' : 'INVALID_CODE');
    assert.equal(b.node('pair-form').hidden, false, `${code}: pairing form is offered again`);
    const shown = b.node('message-box');
    assert.equal(shown.hidden, false, `${code}: the reason is visible`);
    assert.match(shown.textContent, code === 'PAIRING_CODE_EXPIRED' ? /expired/ : code === 'SESSION_ALREADY_PAIRED' ? /another browser/ : /not accepted/,
      `${code}: the reason names what happened`);
    const reconnects = b.timers.slice(timersBefore).filter(t => t.ms >= 1000);
    assert.equal(reconnects.length, 0, `${code}: no silent retry of a rejected code`);
    assert.equal(b.socket().closed, true, `${code}: rejected signaling socket is retired`);
  }

  // 2. DIRECT candidate classes are counted (numbers only, no addresses kept).
  const d = browser('?pair_code=123456');
  d.hooks.connectAndJoin(); d.socket().onopen();
  d.socket().onmessage({ data: JSON.stringify({ type: 'joined', sessionId: 'ice' }) });
  d.socket().onmessage({ data: JSON.stringify({ type: 'peer_ready', role: 'phone' }) });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const p = d.peer();
  assert(p, 'direct path created a peer');
  p.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 0b1c2d3e-aaaa.local 54400 typ host', toJSON() { return {}; } } });
  p.onicecandidate({ candidate: { candidate: 'candidate:2 1 udp 1686052607 203.0.113.9 54400 typ srflx raddr 0.0.0.0 rport 0', toJSON() { return {}; } } });
  d.socket().onmessage({ data: JSON.stringify({ type: 'candidate', candidate: { candidate: 'candidate:3 1 udp 2122260223 100.121.4.33 40000 typ host', sdpMid: '0' } }) });
  const g = d.hooks.getDiagnostics();
  assert.equal(g.DIRECT_LOCAL_MDNS, 1); assert.equal(g.DIRECT_LOCAL_SRFLX, 1); assert.equal(g.DIRECT_REMOTE_HOST, 1);
  assert(!JSON.stringify(g).includes('100.121.4.33') && !JSON.stringify(g).includes('.local'), 'no candidate addresses retained');
  p.iceConnectionState = 'failed'; p.oniceconnectionstatechange();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(d.hooks.getDiagnostics().DIRECT_PAIRS_FAILED, 2);

  // 3. Server relay repeats its keyframe request every KEY_RETRY_MS while waiting.
  let now = 0;
  const gate = new RelayFreshness(() => now);
  const phone = { sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
  const dest = { socket: { writableLength: 0 }, sent: [], sendBinary(b, done) { this.sent.push(b); done && done(); return true; } };
  const packet = flags => { const b = Buffer.alloc(17); b.set([75, 67, 1, flags]); return b; };
  const keyRequests = () => phone.sent.filter(m => m.type === 'request_keyframe').length;
  assert.equal(gate.forward(dest, phone, 's1', packet(0)), false);
  assert.equal(keyRequests(), 1, 'first missing reference requests a key');
  now = 500; gate.forward(dest, phone, 's1', packet(0));
  assert.equal(keyRequests(), 1, 'no request flood within the retry interval');
  now = 2100; gate.forward(dest, phone, 's1', packet(0));
  assert.equal(keyRequests(), 2, 'an unanswered request is repeated after KEY_RETRY_MS');
  now = 2200; assert.equal(gate.forward(dest, phone, 's1', packet(2)), true, 'IDR resumes forwarding');
  now = 9000; gate.forward(dest, phone, 's1', packet(0));
  assert.equal(keyRequests(), 2, 'healthy chain sends no further requests');
  assert.equal(gate.snapshot().keyRetries, 1);
  console.log('PASS V60: rejected pairing codes reported without silent retry, ICE classes counted without addresses, relay key requests repeat while waiting');
})().catch(e => { console.error(e); process.exitCode = 1; });
