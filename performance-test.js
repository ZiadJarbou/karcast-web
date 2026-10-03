'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SessionStore, SESSION_TTL_MS } = require('./tools/signal-server/session_store.cjs');

// A long-running drive must still be able to resume its signaling socket.
const store = new SessionStore();
const phone = { send() {} };
const firstBrowser = { send() {} };
const session = store.registerPhoneSession(phone);
store.joinBrowserSession(firstBrowser, session.pairingCode);
session.expiresAt = Date.now() - 1;
store.cleanupExpired();
assert.equal(store.getSessionById(session.sessionId), session);
store.handleSocketDisconnect(firstBrowser);
assert(session.expiresAt > Date.now() + SESSION_TTL_MS - 1000);
store.cleanupExpired();
const nextBrowser = { send() {} };
assert.equal(store.joinBrowserSession(nextBrowser, session.pairingCode), session);
store.handleSocketDisconnect(nextBrowser);
session.expiresAt = Date.now() - 1;
store.cleanupExpired();
assert.equal(store.getSessionById(session.sessionId), undefined, 'Abandoned sessions still expire');
store.destroy();

const nodes = new Map();
let clockMs = Date.now();
class TestDate extends Date { static now() { return clockMs; } }
const timers = new Map();
let nextTimer = 1;
const setTimer = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; };
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { hidden: true, style: {}, classList: { toggle() {} },
    setAttribute() {}, addEventListener() {}, getContext() { return {}; },
    play() { return Promise.resolve(); }, readyState: 2, videoWidth: 1280, videoHeight: 720 });
  return nodes.get(id);
};
const sockets = [];
class Socket {
  static OPEN = 1;
  constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
const peers = [];
class Peer {
  constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.candidates = []; peers.push(this); }
  createDataChannel() { return this.channel = { readyState: 'open', sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} }; }
  addTransceiver() { return { receiver: {} }; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'test' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription(desc) { this.remoteDescription = desc; return Promise.resolve(); }
  addIceCandidate(c) { this.candidates.push(c); return Promise.resolve(); }
  getStats() { return Promise.resolve(this.stats || new Map()); }
  close() { this.closed = true; }
}
const window = { location: { search: '?transport=auto&pair_code=123456' }, addEventListener() {}, VideoDecoder: class {}, EncodedVideoChunk: class {} };
vm.runInNewContext(fs.readFileSync('public/app.js', 'utf8'), {
  window, document: { getElementById: node }, location: { protocol: 'https:', host: 'app.karcast.app' },
  URLSearchParams, WebSocket: Socket, RTCPeerConnection: Peer, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, Date: TestDate,
  MediaStream: class {}, setTimeout: setTimer, clearTimeout: id => timers.delete(id),
  setInterval: setTimer, clearInterval: id => timers.delete(id)
});
const message = msg => sockets.at(-1).onmessage({ data: JSON.stringify(msg) });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const runReconnect = () => {
  const entry = [...timers].find(([, timer]) => timer.ms === 2500);
  assert(entry, 'A signaling reconnect must be scheduled');
  timers.delete(entry[0]); entry[1].fn();
};

(async () => {
  const hooks = window.__KARCAST_TEST_HOOKS__;
  hooks.connectAndJoin();
  sockets.at(-1).onopen();
  message({ type: 'joined', sessionId: 'same-phone' });
  message({ type: 'peer_ready', role: 'phone' });
  await flush();
  const peer = peers[0];
  message({ type: 'candidate', candidate: { candidate: 'early' } });
  assert.equal(peer.candidates.length, 0);
  message({ type: 'answer', sdp: 'answer' });
  await flush();
  assert.equal(peer.candidates[0].candidate, 'early', 'ICE arriving before SDP is retained');
  peer.connectionState = peer.iceConnectionState = 'connected';
  peer.onconnectionstatechange();
  assert([...timers.values()].some(t => t.ms === 90000), 'Connected transport still needs a first-frame deadline');
  peer.channel.onopen();
  assert(peer.channel.sent.some(m => m.type === 'request_keyframe'), 'Joining a static screen requests a current picture');
  peer.ontrack({ track: {} });
  node('remoteVideo').onplaying();
  assert.equal(hooks.getUIState(), 'CONNECTED');
  assert.equal(node('pairing-overlay').hidden, true, 'Native Android Auto is unobstructed as soon as video starts');
  assert.equal(node('connection-pill').hidden, true, 'Normal driving view has no KarCast badge over the map');

  const oldSocket = sockets.at(-1);
  const staleClose = oldSocket.onclose;
  oldSocket.onclose({ code: 1006, reason: 'proxy timeout' });
  runReconnect();
  const resumedSocket = sockets.at(-1);
  resumedSocket.onopen();
  assert(resumedSocket.sent.some(m => m.type === 'join'), 'Background reconnect must rejoin');
  message({ type: 'joined', sessionId: 'same-phone' });
  message({ type: 'peer_ready', role: 'phone' });
  await flush();
  assert.equal(peers.length, 1, 'Signaling reconnect must preserve the live peer');
  assert.equal(peer.closed, undefined);
  assert.equal(hooks.getUIState(), 'CONNECTED');
  staleClose({ code: 1006 });
  assert.equal(hooks.getDiagnostics().signalingState, 'open');
  assert([...timers.values()].some(t => t.ms === 10000), 'Resumed signaling has a heartbeat');

  peer.channel.onmessage({ data: JSON.stringify({ type: 'media_status', state: 'projecting', sourceFrames: 100 }) });
  resumedSocket.onclose({ code: 1006, reason: 'phone registration renewed' });
  runReconnect(); sockets.at(-1).onopen();
  message({ type: 'joined', sessionId: 'renewed-same-phone' });
  message({ type: 'peer_ready', role: 'phone' }); await flush();
  assert.equal(peers.length, 1, 'A renewed session ID with live phone status preserves media');
  assert.equal(peer.closed, undefined);
  assert.equal(hooks.getUIState(), 'CONNECTED');
  clockMs += 7000; // The old phone is no longer reporting status after a real restart.

  message({ type: 'closed', reason: 'Phone disconnected from signaling relay' });
  assert.equal(peer.closed, undefined, 'An internet interruption need not stop local video');
  runReconnect();
  sockets.at(-1).onopen();
  message({ type: 'joined', sessionId: 'restarted-phone' });
  message({ type: 'peer_ready', role: 'phone' });
  await flush();
  assert.equal(peer.closed, true, 'A new phone session must replace the old peer');
  assert.equal(peers.length, 2);
  const next = peers[1];
  next.connectionState = next.iceConnectionState = 'connected';
  next.onconnectionstatechange();
  next.ontrack({ track: {} });
  node('remoteVideo').onplaying();
  next.stats = new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 5, bytesReceived: 1000 }]]);
  const healthCheck = [...timers.values()].filter(t => t.ms === 1000).at(-1).fn;
  await healthCheck();
  clockMs += 60000;
  await healthCheck();
  assert.equal(hooks.getUIState(), 'CONNECTED', 'Static video must not trigger the WebRTC watchdog');
  next.channel.onmessage({ data: JSON.stringify({ type: 'media_status', state: 'projecting', sourceFrames: 100 }) });
  await healthCheck();
  assert(next.channel.sent.some(m => m.type === 'request_keyframe'), 'A moving source with a stuck decoder requests recovery');
  assert.equal(hooks.getUIState(), 'CONNECTED', 'Recovery gets a grace period after a static screen');
  clockMs += 12000;
  next.stats = new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 5, bytesReceived: 2000 }]]);
  next.channel.onmessage({ data: JSON.stringify({ type: 'media_status', state: 'projecting', sourceFrames: 200 }) });
  await healthCheck();
  assert.equal(hooks.getUIState(), 'CONNECTED', 'Persistent stalls preserve the peer');
  assert.equal(next.closed, undefined);
  const videoNode = node('remoteVideo');
  let presentedCallback;
  videoNode.requestVideoFrameCallback = cb => { presentedCallback = cb; return 1; };
  videoNode.cancelVideoFrameCallback = () => {};
  videoNode.getVideoPlaybackQuality = () => ({ totalVideoFrames: 10, droppedVideoFrames: 0 });
  hooks.cleanupWebRTC();
  hooks.connectAndJoin(); sockets.at(-1).onopen();
  message({ type: 'joined', sessionId: 'restarted-phone' });
  message({ type: 'peer_ready', role: 'phone' }); await flush();
  const presentationPeer = peers.at(-1);
  presentationPeer.connectionState = presentationPeer.iceConnectionState = 'connected';
  presentationPeer.onconnectionstatechange();
  presentationPeer.ontrack({ track: {} });
  videoNode.onplaying();
  const presentationHealth = [...timers.values()].filter(t => t.ms === 1000).at(-1).fn;
  const requestsBefore = presentationPeer.channel.sent.filter(m => m.type === 'request_keyframe').length;
  for (const [advanceMs, frames] of [[0, 10], [2100, 20]]) {
    clockMs += advanceMs;
    presentationPeer.stats = new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: frames, bytesReceived: frames * 100 }]]);
    await presentationHealth();
  }
  assert.equal(hooks.getUIState(), 'CONNECTED', 'Presentation stalls preserve the transport');
  assert(presentationPeer.channel.sent.filter(m => m.type === 'request_keyframe').length > requestsBefore, 'Incoming packets with no rendered callback request a keyframe after 2 seconds');
  assert.equal(presentationPeer.closed, undefined);
  presentedCallback();
  clockMs += 500;
  await presentationHealth();
  assert.equal(hooks.getDiagnostics().presentationQuietMs, 500);
  // Transport starvation differs from stalled presentation: the phone keeps
  // reporting new AA frames, but both RTP bytes and decoded frames stop.
  clockMs += 2100;
  presentationPeer.channel.onmessage({ data: JSON.stringify({ type: 'media_status', state: 'projecting', sourceFrames: 1000 }) });
  await presentationHealth();
  assert.equal(presentationPeer.closed, undefined, 'Brief starvation first requests a refresh');
  const bindingSocket = sockets.at(-1);
  clockMs += 9000;
  presentationPeer.channel.onmessage({ data: JSON.stringify({ type: 'media_status', state: 'projecting', sourceFrames: 1200 }) });
  await presentationHealth();
  assert.equal(presentationPeer.closed, true, 'Sustained transport starvation falls back to secure relay');
  assert.equal(sockets.at(-1), bindingSocket, 'Fallback preserves the pairing socket');
  assert.equal(bindingSocket.readyState, Socket.OPEN);
  assert(bindingSocket.sent.some(m => m.type === 'relay_start'), 'Fallback asks the same phone for original H264 relay');
  hooks.cleanupWebRTC();
  presentedCallback(); // Stale callbacks must not reschedule against a closed peer.
  console.log('PASS: session expiry, early ICE, first-frame refresh, signaling recovery, and phone restart');
})().catch(error => { console.error(error); process.exitCode = 1; });
