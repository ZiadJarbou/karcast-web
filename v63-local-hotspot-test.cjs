'use strict';
// V63: the page can target the phone's local hotspot server via ?signal=, falls back to the normal
// server relay after 3 failed attempts that never opened, and never falls back once the phone answered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page(search) {
  let now = 1000000; const timers = [], intervals = [], sockets = [];
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { hidden: true, value: '', textContent: '', style: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, getContext() { return { drawImage() {} }; } }); return nodes.get(id); };
  class Socket { static OPEN = 1; constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; } }
  const window = { VideoDecoder: class { configure() {} close() {} decode() {} }, EncodedVideoChunk: class {}, location: { search, hash: '#pair_token=' + 'a'.repeat(64) }, addEventListener() {} };
  const context = { window, document: { getElementById: node }, location: { protocol: 'https:', host: 'staging.karcast.app', hash: window.location.hash }, URLSearchParams, WebSocket: Socket,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Uint8Array, ArrayBuffer, DataView, Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {} };
  context.window.localStorage = context.localStorage;
  vm.runInNewContext(fs.readFileSync(process.env.KARCAST_SOURCE || 'public/app.js', 'utf8'), context);
  return { hooks: window.__KARCAST_TEST_HOOKS__, sockets, timers, advance: ms => { now += ms; } };
}
const LOCAL = 'wss://car.karcast.app:8443/ws';
const query = '?signal=' + encodeURIComponent(LOCAL) + '&transport=relay&present=latest';

// 1. Local URL is used and the per-phone token is offered as a subprotocol.
const a = page(query);
a.hooks.connectAndJoin();
assert.equal(a.sockets[0].url, LOCAL);
assert(a.sockets[0].protocols.includes('pair_token.' + 'a'.repeat(64)), 'token offered to the phone');

// 2. Three attempts that never open -> the next attempt uses the normal server relay.
for (let i = 0; i < 3; i++) { const s = a.sockets.at(-1); s.onclose({ code: 1006 }); a.timers.at(-1).fn(); }
assert.equal(a.sockets.at(-1).url, 'wss://staging.karcast.app/ws', 'falls back to the server relay');
assert.equal(a.hooks.getDiagnostics().localFallbacks, 1);

// 3. Once the phone answered, later drops keep retrying the phone (no fallback).
const b = page(query);
b.hooks.connectAndJoin(); const first = b.sockets[0]; first.readyState = 1; first.onopen();
assert.equal(first.sent[0].type, 'join');
for (let i = 0; i < 5; i++) { const s = b.sockets.at(-1); s.onclose({ code: 1006 }); b.timers.at(-1).fn(); }
assert(b.sockets.every(s => s.url === LOCAL), 'an established local path is retried, not abandoned');
assert.equal(b.hooks.getDiagnostics().localFallbacks, undefined);

// 4. Without ?signal= the page behaves exactly as before.
const c = page('?transport=relay&pair_code=123456');
c.hooks.connectAndJoin();
assert.equal(c.sockets[0].url, 'wss://staging.karcast.app/ws');
console.log('PASS V63 local hotspot: phone signal URL + token, fallback after 3 unopened attempts, no fallback once connected, default unchanged');
