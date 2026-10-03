'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/app.js', 'utf8');

function client(search = '', options = {}) {
  const timers = new Map();
  const sockets = [];
  const peers = [];
  const nodes = new Map();
  const decoders = [];
  let next = 0;
  const timer = (fn, ms) => { timers.set(++next, { fn, ms }); return next; };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, style: {setProperty(name,value) {this[name]=value;}}, classList: { toggle() {} },
      setAttribute() {}, addEventListener() {}, setPointerCapture() {},
      getBoundingClientRect() { return this.rect; }, getContext() { return { drawImage() {} }; },
      play() { return Promise.resolve(); }, readyState: 2, videoWidth: 1280, videoHeight: 720 });
    return nodes.get(id);
  };
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  class Peer {
    constructor() {
      if (options.peerError) throw new Error('WebRTC disabled');
      this.connectionState = this.iceConnectionState = 'new'; peers.push(this);
    }
    createDataChannel() { return { readyState: 'connecting', close() {} }; }
    addTransceiver() { return { receiver: {} }; }
    createOffer() { return Promise.resolve({ sdp: 'offer' }); }
    setLocalDescription() { return Promise.resolve(); }
    getStats() { return Promise.resolve(new Map()); }
    close() { this.closed = true; }
  }
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; decoders.push(this); }
    configure() { if (options.decoderError) throw new Error('H264 unsupported'); }
    decode() { this.callbacks.output({ displayWidth: 1280, displayHeight: 720, close() {} }); }
    close() { this.closed = true; }
  }
  class Chunk {}
  const window = { VideoDecoder: Decoder, EncodedVideoChunk: Chunk, location: { search: search + (search ? '&' : '?') + 'pair_code=123456' }, addEventListener() {} };
  if (options.noRelay) { delete window.VideoDecoder; delete window.EncodedVideoChunk; }
  vm.runInNewContext(source, { window, document: { getElementById: node },
    location: { protocol: 'https:', host: 'app.karcast.app' }, URLSearchParams,
    WebSocket: Socket, RTCPeerConnection: Peer, VideoDecoder: Decoder, EncodedVideoChunk: Chunk,
    Uint8Array, ArrayBuffer, DataView, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, MediaStream: class {},
    setTimeout: timer, setInterval: timer, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) });
  const hooks = window.__KARCAST_TEST_HOOKS__;
  const message = data => sockets.at(-1).onmessage({ data: JSON.stringify(data) });
  const join = () => {
    sockets.at(-1).onopen();
    message({ type: 'joined', sessionId: 'phone' });
    message({ type: 'peer_ready', role: 'phone' });
  };
  hooks.connectAndJoin(); join();
  return { hooks, sockets, peers, decoders, node, join, message, timers,
    run(ms) { const entry = [...timers].reverse().find(([, t]) => t.ms === ms); assert(entry); timers.delete(entry[0]); entry[1].fn(); },
    frame() { const packet = new Uint8Array(17); packet.set([75, 67, 1, 2]); sockets.at(-1).onmessage({ data: packet.buffer }); } };
}

(async () => {
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const blocked = client();
  await flush();
  const socket = blocked.sockets[0];
  blocked.peers[0].ontrack({ track: {} });
  const progress = blocked.node('connection-progress-fill').style.width;
  blocked.run(15000);
  assert.equal(blocked.node('connection-progress-fill').style.width, progress, 'Fallback does not reset progress to zero');
  assert.equal(blocked.sockets.length, 1, 'Fallback keeps the pairing socket');
  assert.equal(blocked.peers[0].closed, true);
  assert.equal(socket.sent.filter(m => m.type === 'relay_start').length, 1);
  assert.equal(blocked.hooks.getUIState(), 'ESTABLISHING_SECURE_CONNECTION');
  assert.match(blocked.hooks.getDiagnostics().fallbackReason, /15 seconds/);
  blocked.frame();
  assert.equal(blocked.hooks.getUIState(), 'CONNECTED');
  assert.equal(blocked.hooks.getDiagnostics().connectionPath, 'secure-relay');
  socket.onclose({ code: 1006 });
  blocked.run(2500); blocked.join(); await flush();
  assert.equal(blocked.peers.length, 1, 'Rejoining does not retry the blocked direct route');
  assert(blocked.sockets.at(-1).sent.some(m => m.type === 'relay_start'));

  const working = client(); await flush();
  working.peers[0].ontrack({ track: {} });
  assert.equal(working.node('dockVideo').srcObject, working.node('remoteVideo').srcObject,
    'The dock reuses the received video track instead of opening another transport');
  working.node('remoteVideo').onplaying();
  assert.equal([...working.timers.values()].filter(t => t.ms === 15000).length, 1, 'First frame leaves only the signaling heartbeat');
  assert(!working.sockets[0].sent.some(m => m.type === 'relay_start'));
  assert.equal(working.peers[0].closed, undefined);

  // The former top/bottom letterbox areas now belong to the native screen.
  // Exercise real pointer handlers through the relay, including after resize.
  const video = working.node('remoteVideo');
  working.node('relayCanvas').hidden = true;
  video.hidden = false;
  const tap = (target, x, y) => {
    const event = { clientX:x, clientY:y, pointerId:1, button:0, preventDefault() {} };
    target.onpointerdown(event); target.onpointerup(event);
    return working.sockets.at(-1).sent.filter(m => m.type === 'relay_touch').at(-1);
  };
  for (const [width, height] of [[930,720], [1280,720], [1600,600], [600,900]]) {
    working.node('stream-container').rect = {left:10,top:20,width,height};
    const dockHeight = Math.min(width / 10, height * 0.4);
    const contentHeight = height - dockHeight;
    for (const y of [0.01, 0.5, 0.99]) {
      const sourceY = y * 720;
      const displayY = sourceY <= 592 ? sourceY / 592 * contentHeight
        : contentHeight + (sourceY - 592) / 128 * dockHeight;
      const target = sourceY <= 592 ? video : working.node('dockVideo');
      const touch = tap(target, 10 + width * 0.5, 20 + displayY);
      assert.equal(touch.action, 'up');
      assert(Math.abs(touch.x - 0.5) < 1e-10);
      assert(Math.abs(touch.y - y) < 1e-10, 'Full-height map and bottom dock map to native coordinates after resize');
    }
  }
  const canvas = working.node('relayCanvas');
  canvas.hidden = false; canvas.width = 1280; canvas.height = 720;
  working.node('stream-container').rect = {left:0,top:0,width:930,height:720};
  const dockTouch = tap(working.node('relayDockCanvas'), 465, 627 + (712.8 - 592) / 128 * 93);
  assert(Math.abs(dockTouch.y - 0.99) < 1e-10, 'Relay canvas uses the same full-height touch mapping');
  const beforeOutside = working.sockets.at(-1).sent.length;
  canvas.onpointerdown({clientX:465,clientY:721,pointerId:1,button:0,preventDefault() {}});
  assert.equal(working.sockets.at(-1).sent.length, beforeOutside, 'Outside taps are rejected');
  working.hooks.cleanupWebRTC();
  assert.equal(working.node('dockVideo').srcObject, null, 'Cleanup releases the dock track');
  assert.equal(working.node('relayDockCanvas').hidden, true, 'Cleanup hides the relay dock');

  const failed = client(); await flush();
  const stale = failed.peers[0].onconnectionstatechange;
  failed.peers[0].connectionState = 'failed'; stale(); stale();
  assert.equal(failed.sockets[0].sent.filter(m => m.type === 'relay_start').length, 1, 'Late callbacks cannot restart fallback');
  assert.match(failed.hooks.getDiagnostics().fallbackReason, /Peer/);

  const disabled = client('?transport=webrtc'); await flush();
  assert.equal([...disabled.timers.values()].filter(t => t.ms === 15000).length, 1);
  const unsupported = client('', { noRelay: true }); await flush();
  assert.equal([...unsupported.timers.values()].filter(t => t.ms === 15000).length, 1);
  const unavailable = client('', { peerError: true });
  assert(unavailable.sockets[0].sent.some(m => m.type === 'relay_start'));
  const badDecoder = client('?transport=relay', { decoderError: true });
  badDecoder.frame(); badDecoder.frame();
  assert.equal(badDecoder.decoders.length, 1, 'Unsupported decoding fails once instead of looping');
  assert.equal(badDecoder.hooks.getUIState(), 'CONNECTION_FAILED');
  assert.equal(badDecoder.hooks.getDiagnostics().relayDecoderError, 'H264 unsupported');
  assert(![...badDecoder.timers.values()].some(t => t.ms === 90000));
  console.log('PASS: Tesla first-frame fallback, immediate failure, relay reconnect, direct success, and unsupported decoder');
})().catch(error => { console.error(error); process.exitCode = 1; });
