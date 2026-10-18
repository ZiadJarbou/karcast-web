'use strict';
// V65 (amendment A1): with a phone signal URL the page never falls back to the server relay unless the
// link opts in with &fallback=relay; it keeps retrying the phone and asks the driver to join the hotspot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page(search) {
  let now = 1000000; const timers = [], sockets = [];
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { hidden: true, value: '', textContent: '', style: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, getContext() { return { drawImage() {} }; } }); return nodes.get(id); };
  class Socket { static OPEN = 1; constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; } }
  const window = { VideoDecoder: class { configure() {} close() {} decode() {} }, EncodedVideoChunk: class {}, location: { search, hash: '#pair_token=' + 'a'.repeat(64) }, addEventListener() {} };
  const context = { window, document: { getElementById: node }, location: { protocol: 'https:', host: 'staging.karcast.app', hash: window.location.hash }, URLSearchParams, WebSocket: Socket,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Uint8Array, ArrayBuffer, DataView, Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  context.window.localStorage = context.localStorage;
  vm.runInNewContext(fs.readFileSync(process.env.KARCAST_SOURCE || 'public/app.js', 'utf8'), context);
  return { hooks: window.__KARCAST_TEST_HOOKS__, sockets, timers, message: node('message-box') };
}
const LOCAL = 'wss://car.karcast.app:8443/ws';
const query = '?signal=' + encodeURIComponent(LOCAL) + '&transport=relay&present=latest';
// Same unopened-attempt simulation as the V63 test (close without open).
const fail = p => { const s = p.sockets.at(-1); s.onclose({ code: 1006 }); p.timers.at(-1).fn(); };

// 1. Default: many unopened attempts never leave the phone, and the page asks for the hotspot.
const a = page(query);
a.hooks.connectAndJoin();
for (let i = 0; i < 8; i++) fail(a);
assert(a.sockets.length >= 9, 'kept retrying');
assert(a.sockets.every(s => s.url === LOCAL), 'never falls back to the server relay without opt-in');
assert.equal(a.hooks.getDiagnostics().localFallbacks, undefined);
assert(a.hooks.getDiagnostics().localOnlyWaits >= 1, 'local-only wait recorded');
assert.match(a.message.textContent, /phone hotspot/, 'driver is told to join the phone hotspot');

// 2. Opt-in keeps the V63 fallback after three unopened attempts.
const b = page(query + '&fallback=relay');
b.hooks.connectAndJoin();
for (let i = 0; i < 3; i++) fail(b);
assert.equal(b.sockets.at(-1).url, 'wss://staging.karcast.app/ws');
assert.equal(b.hooks.getDiagnostics().localFallbacks, 1);

// 3. Without ?signal= nothing changes.
const c = page('?transport=relay&pair_code=123456');
c.hooks.connectAndJoin();
assert.equal(c.sockets[0].url, 'wss://staging.karcast.app/ws');
console.log('PASS V65 local only: no server fallback without &fallback=relay, hotspot hint shown, opt-in fallback and default unchanged');
