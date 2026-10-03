'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const WsSocket = require('./tools/signal-server/ws_frame.cjs');
const socket = new EventEmitter();
socket.writable = true;
socket.write = () => true;
socket.destroy = () => {};
const receiver = new WsSocket(socket);
const received = [];
receiver.on('binary', b => received.push(b));
receiver.handleData(Buffer.from([2, 3, 75, 67, 1]));
assert.equal(received.length, 0);
receiver.handleData(Buffer.from([0x89, 1, 42]));
receiver.handleData(Buffer.from([0x80, 2, 7, 8]));
assert.deepEqual(received, [Buffer.from([75, 67, 1, 7, 8])]);

const nodes = new Map();
const timers = [];
const delays = [];
const intervals = [];
let clockMs = Date.now();
class TestDate extends Date { static now() { return clockMs; } }
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { hidden: true, style: {}, classList: { toggle() {} },
    setAttribute() {}, events: {}, addEventListener(type, callback) { this.events[type] = callback; },
    getContext() { return { drawImage() {} }; } });
  return nodes.get(id);
};
let browserSocket;
let output;
class Socket {
  static OPEN = 1;
  constructor() { this.readyState = 1; this.sent = []; browserSocket = this; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
}
class Decoder {
  constructor(callbacks) { output = callbacks.output; this.decodeQueueSize = 0; }
  configure() {}
  close() {}
  decode() {}
}
const window = { VideoDecoder: Decoder, EncodedVideoChunk: class {}, location: { search: '?transport=relay&pair_code=123456' }, addEventListener() {} };
const context = { window, document: { getElementById: node }, location: { protocol: 'https:', host: 'app.karcast.app' },
  URLSearchParams, WebSocket: Socket, VideoDecoder: Decoder, Uint8Array, ArrayBuffer, DataView, Date: TestDate,
  setTimeout: (fn, ms) => { timers.push(fn); delays.push(ms); return timers.length; }, clearTimeout() {},
  setInterval(fn, ms) { intervals.push({fn, ms}); return intervals.length; }, clearInterval() {},
  RTCPeerConnection: function () { throw new Error('Relay must not start WebRTC'); } };
vm.runInNewContext(fs.readFileSync('public/app.js', 'utf8'), context);
window.__KARCAST_TEST_HOOKS__.connectAndJoin();
browserSocket.onopen();
browserSocket.onmessage({ data: JSON.stringify({ type: 'joined', sessionId: 'test' }) });
browserSocket.onmessage({ data: JSON.stringify({ type: 'peer_ready', role: 'phone' }) });
assert(browserSocket.sent.some(m => m.type === 'relay_start'));
assert(delays.includes(90000), 'Relay startup must allow time for the next AA keyframe');
assert(!browserSocket.sent.some(m => m.type === 'offer'));
const key = new Uint8Array(17); key.set([75, 67, 1, 2]);
context.EncodedVideoChunk = class {};
browserSocket.onmessage({ data: key.buffer });
output({ displayWidth: 1280, displayHeight: 720, close() {} });
const afterFirstFrame = timers.length;
output({ displayWidth: 1280, displayHeight: 720, close() {} });
assert.equal(timers.length, afterFirstFrame, 'Frames must not repeatedly schedule overlay dismissal');
assert.equal(window.__KARCAST_TEST_HOOKS__.getUIState(), 'CONNECTED');
clockMs += 60000;
intervals.find(timer => timer.ms === 1000).fn();
assert.equal(window.__KARCAST_TEST_HOOKS__.getUIState(), 'CONNECTED', 'An unchanged AA screen must not cause reconnect');
window.__KARCAST_TEST_HOOKS__.cleanupWebRTC();
assert.equal(node('relayCanvas').hidden, true);
const beforeTakeover = timers.length;
browserSocket.onmessage({ data: JSON.stringify({ type: 'closed', reason: 'Another vehicle browser connected' }) });
assert.equal(browserSocket.onclose, null, 'A displaced browser must not take the session back');
assert.equal(timers.length, beforeTakeover, 'A displaced browser must not schedule reconnect');
window.__KARCAST_TEST_HOOKS__.connectAndJoin();
assert.equal(delays[delays.length - 1], 30000, 'Unpaired sockets need a deadline');
const staleError = browserSocket.onerror;
window.__KARCAST_TEST_HOOKS__.connectAndJoin();
staleError();
assert.equal(window.__KARCAST_TEST_HOOKS__.getDiagnostics().signalingState, 'connecting');
browserSocket.onclose({code: 1006, reason: ''});
assert.equal(delays[delays.length - 1], 5000);
timers[timers.length - 1]();
for (let attempt = 0; attempt < 8; attempt++) {
  const beforeFailure = timers.length;
  browserSocket.onerror();
  assert.equal(window.__KARCAST_TEST_HOOKS__.getUIState(), 'PHONE_NOT_AVAILABLE');
  assert.equal(timers.length, beforeFailure + 1, 'An absent phone must not permanently stop retries');
  assert(delays[delays.length - 1] <= 10000, 'Retries must remain paced');
  timers[timers.length - 1]();
}
browserSocket.onopen();
browserSocket.onmessage({ data: JSON.stringify({ type: 'joined', sessionId: 'restarted-phone' }) });
assert(browserSocket.sent.some(m => m.type === 'relay_start' && m.sessionId === 'restarted-phone'));
browserSocket.onmessage({ data: key.buffer });
output({ displayWidth: 1280, displayHeight: 720, close() {} });
assert.equal(window.__KARCAST_TEST_HOOKS__.getUIState(), 'CONNECTED', 'Phone Start must recover the existing page');
browserSocket.onmessage({ data: JSON.stringify({ type: 'closed', reason: 'Phone disconnected' }) });
timers[timers.length - 1]();
browserSocket.onopen();
const beforeUnavailable = timers.length;
browserSocket.onmessage({ data: JSON.stringify({ type: 'error', code: 'SESSION_NOT_FOUND' }) });
assert.equal(timers.length, beforeUnavailable + 1, 'Missing sessions must schedule a new join');
timers[timers.length - 1]();
browserSocket.onopen();
browserSocket.onmessage({ data: JSON.stringify({ type: 'joined', sessionId: 'next-phone' }) });
browserSocket.onmessage({ data: key.buffer });
output({ displayWidth: 1280, displayHeight: 720, close() {} });
assert.equal(window.__KARCAST_TEST_HOOKS__.getUIState(), 'CONNECTED');
assert.equal(window.__KARCAST_TEST_HOOKS__.getDiagnostics().lastSocketCloseCode, 1006);
console.log('PASS: relay frames, takeover, stale sockets, sustained retries, and phone Stop/Start reconnection');
