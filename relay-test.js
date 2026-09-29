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
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { hidden: true, style: {}, classList: { toggle() {} },
    setAttribute() {}, getContext() { return { drawImage() {} }; } });
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
  constructor(callbacks) { output = callbacks.output; }
  configure() {}
  close() {}
  decode() {}
}
const window = { VideoDecoder: Decoder, location: { search: '' }, addEventListener() {} };
const context = { window, document: { getElementById: node }, location: { protocol: 'https:', host: 'app.karcast.app' },
  URLSearchParams, WebSocket: Socket, VideoDecoder: Decoder, Uint8Array, ArrayBuffer, DataView,
  setTimeout: (fn, ms) => { timers.push(fn); delays.push(ms); return timers.length; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
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
window.__KARCAST_TEST_HOOKS__.cleanupWebRTC();
assert.equal(node('relayCanvas').hidden, true);
console.log('PASS: fragmented video, relay-only startup, first-frame state, and cleanup');
