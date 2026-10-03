'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SessionStore } = require('./tools/signal-server/session_store.cjs');
const WsSocket = require('./tools/signal-server/ws_frame.cjs');
const Server = require('./server-core');
const socket = () => ({ messages: [], send(s) { this.messages.push(JSON.parse(s)); } });
const store = new SessionStore();
try {
  const p1 = socket(), p2 = socket(), browser = socket();
  const first = store.registerPhoneSession(p1, 'phone-one', 'a'.repeat(64));
  const other = store.registerPhoneSession(p2, 'phone-two', 'b'.repeat(64));
  assert.throws(() => store.joinBrowserSession(browser, 'auto'), e => e.code === 'PAIRING_CODE_INVALID');
  assert.equal(store.joinBrowserSession(browser, '', 'browser', first.pairToken), first);
  assert.equal(other.browserSocket, null, 'A newer phone must never capture an existing pairing');
  const newPhone = socket();
  const resumed = store.registerPhoneSession(newPhone, 'phone-one', 'a'.repeat(64));
  assert.equal(first.pairToken, resumed.pairToken, 'Phone identity survives signaling reconnect');
  store.handleSocketDisconnect(p1);
  assert.equal(store.getSessionById(resumed.sessionId), resumed, 'Stale disconnect cannot close replacement session');
  assert.equal(store.joinBrowserSession(browser, '', 'browser', first.pairToken), resumed);
  assert.throws(() => store.joinBrowserSession(socket(), other.pairingCode, 'stranger', 'c'.repeat(64)),
    e => e.code === 'PAIRING_CODE_INVALID', 'Unknown token never falls back to a different code');
  const server = new Server();
  server.sessionStore.destroy(); server.sessionStore = store;
  assert.throws(() => server.handleClose(socket(), { sessionId: resumed.sessionId }), e => e.code === 'UNAUTHORIZED');
  assert.throws(() => server.handleReady(socket(), { sessionId: resumed.sessionId }), e => e.code === 'UNAUTHORIZED');
  const tcp = new EventEmitter(); tcp.writable = true; tcp.destroy = () => {}; let response;
  tcp.write = s => { response = s; };
  const ws = WsSocket.performHandshake({ headers: { 'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
    'sec-websocket-protocol': 'karcast-v1, pair_token.' + resumed.pairToken } }, tcp);
  assert.equal(ws.pairToken, resumed.pairToken);
  assert(response.includes('Sec-WebSocket-Protocol: karcast-v1'));
  const restart = new SessionStore();
  assert.equal(restart.registerPhoneSession(socket(), 'phone-one', 'a'.repeat(64)).pairToken, resumed.pairToken);
  restart.destroy();
  console.log('PASS: token isolation, unknown bindings, stale sockets, server restart, ownership and handshake');
} finally { store.destroy(); }
