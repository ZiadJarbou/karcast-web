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
let currentDecoder;let decodes=[];let closedDecoders=0;
class Socket {
  static OPEN = 1;
  constructor() { this.readyState = 1; this.sent = []; browserSocket = this; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
}
class Decoder {
  constructor(callbacks) { output = callbacks.output; this.decodeQueueSize = 0;currentDecoder=this; }
  configure() {}
  close() {closedDecoders++;}
  decode(unit) {decodes.push(unit);}
}
const window = { VideoDecoder: Decoder, EncodedVideoChunk: class {}, location: { search: '?transport=relay&pair_code=123456' }, addEventListener() {} };
const context = { window, document: { getElementById: node }, location: { protocol: 'https:', host: 'app.karcast.app' },
  URLSearchParams, WebSocket: Socket, VideoDecoder: Decoder, Uint8Array, ArrayBuffer, DataView, Date: TestDate,
  setTimeout: (fn, ms) => { timers.push(fn); delays.push(ms); return timers.length; }, clearTimeout() {},
  setInterval(fn, ms) { intervals.push({fn, ms}); return intervals.length; }, clearInterval() {},
  RTCPeerConnection: function () { throw new Error('Relay must not start WebRTC'); } };
vm.runInNewContext(fs.readFileSync('public/app.js', 'utf8'), context);

context.EncodedVideoChunk=class {constructor(unit){Object.assign(this,unit);}};
const hooks=window.__KARCAST_TEST_HOOKS__;
hooks.connectAndJoin();browserSocket.onopen();
browserSocket.onmessage({data:JSON.stringify({type:'joined',sessionId:'freshness'})});
browserSocket.onmessage({data:JSON.stringify({type:'peer_ready',role:'phone'})});
function frame(key,time=0){const b=new Uint8Array(17);b.set([75,67,1,key?2:0]);const v=new DataView(b.buffer);v.setUint32(4,Math.floor(time/4294967296));v.setUint32(8,time>>>0);browserSocket.onmessage({data:b.buffer});}
const picture=()=>({displayWidth:1280,displayHeight:720,close(){this.closed=true;}});
frame(true);output(picture());assert.equal(hooks.getUIState(),'CONNECTED');
clockMs+=2000;frame(true);output(picture()); // steady state after bounded reference bootstrap
for(let i=0;i<100;i++)frame(false);
assert.equal(hooks.getDiagnostics().pendingVideoFrames,100,'A fresh burst preserves its reference chain while decode is delayed');
assert.equal(decodes.length,10,'Only eight additional pictures enter the decoder after the two outputs');
assert(hooks.getDiagnostics().videoQueueBytes<=20*1024*1024);
const staleOutput=output;clockMs+=251;frame(false);
assert(closedDecoders>0);assert.equal(hooks.getDiagnostics().pendingVideoFrames,0);
assert(hooks.getDiagnostics().staleVideoDrops>0,'The freshness deadline retires the delayed burst');
const decodedBefore=decodes.length;frame(false);assert.equal(decodes.length,decodedBefore,'Deltas wait for IDR');
const old=picture();staleOutput(old);assert(old.closed,'Retired output closes');
frame(true);output(picture());assert.equal(hooks.getUIState(),'CONNECTED');assert.equal(browserSocket.readyState,Socket.OPEN);
clockMs=100000;hooks.cleanupWebRTC();frame(true,100000000);output(picture());
clockMs+=2000;frame(false,102000000);output(picture());
clockMs+=1000;const before=decodes.length;const beforePresented=hooks.getDiagnostics().presentedFrames;frame(false,102100000);assert.equal(decodes.length,before+1,'Approved reference-only catch-up decodes a 900ms reference');output(picture());assert.equal(hooks.getDiagnostics().presentedFrames,beforePresented,'A 900ms reference is NEVER displayed');frame(false,103000000);output(picture());assert.equal(hooks.getDiagnostics().presentedFrames,beforePresented+1,'Fresh continuation preserves the healthy reference chain');
frame(true,103000000);output(picture());assert(hooks.getDiagnostics().frameAgeMs<=250);
console.log('PASS: bounded age, reference retirement, late disposal, transport backlog, healthy pairing');
