'use strict';
// V69 (CR-20261018-STARTUP-SPEED B + A guard): a page pointed at the phone re-finds a stopped/restarted
// phone quickly (2.5 s connect timeout, <=1.5 s back-off), retries when the car screen shows the page
// again, and an opted-in server fallback with no video returns to the phone. Internet timings unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page(search) {
  const clock = { now: 1000000 }; const timers = [], sockets = [], docListeners = {};
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { hidden: true, value: '', textContent: '', style: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, getContext() { return { drawImage() {} }; } }); return nodes.get(id); };
  class Socket { static OPEN = 1; constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; } }
  const window = { VideoDecoder: class { configure() {} close() {} decode() {} }, EncodedVideoChunk: class {}, location: { search, hash: '#pair_token=' + 'a'.repeat(64) }, addEventListener() {} };
  const document = { hidden: false, getElementById: node, addEventListener(type, fn) { docListeners[type] = fn; } };
  const context = { window, document, location: { protocol: 'https:', host: 'staging.karcast.app', hash: window.location.hash }, URLSearchParams, WebSocket: Socket,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Uint8Array, ArrayBuffer, DataView, Date: class extends Date { static now() { return clock.now; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  context.window.localStorage = context.localStorage;
  vm.runInNewContext(fs.readFileSync(process.env.KARCAST_SOURCE || 'public/app.js', 'utf8'), context);
  return { hooks: window.__KARCAST_TEST_HOOKS__, sockets, timers, clock, document, docListeners };
}
const LOCAL = 'wss://car.karcast.app:8443/ws';
const query = '?signal=' + encodeURIComponent(LOCAL) + '&transport=relay&present=latest';
const closeLast = p => p.sockets.at(-1).onclose({ code: 1006 });

// 1. Phone URL: back-off after unopened closes never exceeds 1.5 s (V61 internet cap is 5 s).
const a = page(query);
a.hooks.connectAndJoin();
const delays = [];
for (let i = 0; i < 8; i++) { closeLast(a); delays.push(a.timers.at(-1).ms); a.timers.at(-1).fn(); }
assert(delays.every(ms => ms <= 1500), 'local back-off capped at 1.5 s: ' + delays);
assert(a.sockets.every(s => s.url === LOCAL), 'still never leaves the phone without opt-in');

// 2. Phone URL: a hanging connect is abandoned after 2.5 s (not 6 s) and retried immediately.
const b = page(query);
b.hooks.connectAndJoin();
const before = b.sockets.length;
b.clock.now += 2000; b.hooks.checkSignalingLiveness(b.clock.now);
assert.equal(b.sockets.length, before, 'no retry before 2.5 s');
b.clock.now += 600; b.hooks.checkSignalingLiveness(b.clock.now);
assert.equal(b.sockets.length, before + 1, 'retried right after the local connect timeout');
assert.equal(b.hooks.getDiagnostics().lastFastRejoinReason, 'signaling connect timeout');

// 3. Internet signaling keeps the V61 timings (6 s connect timeout, back-off up to 5 s).
const c = page('?transport=relay&pair_code=123456');
c.hooks.connectAndJoin();
c.clock.now += 3000; c.hooks.checkSignalingLiveness(c.clock.now);
assert.equal(c.sockets.length, 1, 'internet connect not abandoned at 3 s');
for (let i = 0; i < 3; i++) { closeLast(c); c.timers.at(-1).fn(); }
closeLast(c); assert.equal(c.timers.at(-1).ms, 5000, 'internet back-off still reaches 5 s');

// 4. Page shown again on the car screen: immediate retry of the phone.
const d = page(query);
d.hooks.connectAndJoin(); closeLast(d);
const pending = d.sockets.length;
d.docListeners.visibilitychange();
assert.equal(d.sockets.length, pending + 1, 'visible page retries the phone at once');
assert.equal(d.hooks.getDiagnostics().lastFastRejoinReason, 'page visible');
d.document.hidden = true; const hiddenCount = d.sockets.length; d.docListeners.visibilitychange();
assert.equal(d.sockets.length, hiddenCount, 'hidden page does not retry');

// 5. Opted-in fallback with no video goes back to the phone after 15 s.
const e = page(query + '&fallback=relay');
e.hooks.connectAndJoin();
for (let i = 0; i < 3; i++) { closeLast(e); e.timers.at(-1).fn(); }
assert.equal(e.hooks.getSignalUrl(), 'wss://staging.karcast.app/ws', 'V63/V65 opt-in fallback kept');
e.clock.now += 14000; assert.equal(e.hooks.maybeReturnToPhone(e.clock.now), false);
e.clock.now += 1500; assert.equal(e.hooks.maybeReturnToPhone(e.clock.now), true);
assert.equal(e.hooks.getSignalUrl(), LOCAL, 'returned to the phone');
assert.equal(e.hooks.getDiagnostics().localReturns, 1);
console.log('PASS V69 local reconnect: 2.5 s local connect timeout, <=1.5 s back-off, visibility retry, fallback returns to phone, internet timings unchanged');
