'use strict';
const crypto = require('node:crypto');
const RelayFreshness = require('./relay-freshness.cjs');
const {createMessage} = require('./tools/signal-server/protocol.cjs');

/** Capabilities are one-use, role/control-generation bound, and never URLs. */
class SplitMedia {
  constructor(store, now = Date.now) {
    this.store = store; this.now = now;
    this.states = new Map(); this.tokens = new Map(); this.owners = new WeakMap();
  }
  current(state) {
    const s = this.store.getSessionById(state.id);
    return s && s.phoneSocket === state.phone && s.browserSocket === state.browser;
  }
  retire(state) {
    if (this.states.get(state.id) !== state) return;
    this.states.delete(state.id);
    for (const role of ['phone', 'browser']) {
      this.tokens.delete(state[role + 'Token']);
      state[role + 'Media']?.close(1000, 'Media generation retired');
    }
  }
  prune() {
    for (const s of this.states.values()) if (!this.current(s)) this.retire(s);
    for (const [token, grant] of this.tokens) if (grant.expires <= this.now()) this.tokens.delete(token);
  }
  request(control, msg) {
    this.prune();
    const session = this.store.getSessionBySocket(control);
    if (!session || msg.sessionId !== session.sessionId) throw new Error('Unpaired media request');
    const role = session.phoneSocket === control ? 'phone' : 'browser';
    if (msg.type === 'split_start') {
      if (role !== 'browser' || !session.phoneSocket?.splitMediaCapable) {
        control.send(createMessage('split_unavailable', {sessionId:session.sessionId})); return;
      }
      this.retire(this.states.get(session.sessionId) || {});
      const state = {id:session.sessionId, phone:session.phoneSocket, browser:control,
        generation:crypto.randomBytes(16).toString('hex'), freshness:new RelayFreshness()};
      this.states.set(state.id, state);
      this.issue(state, 'phone'); this.issue(state, 'browser');
    } else {
      const state = this.states.get(session.sessionId);
      if (!state || !this.current(state)) throw new Error('No split generation');
      this.issue(state, role);
    }
  }
  issue(state, role) {
    this.tokens.delete(state[role + 'Token']);
    const old = state[role + 'Media'];
    state[role + 'Media'] = null;
    old?.close(1000, 'Media replaced');
    const token = crypto.randomBytes(32).toString('hex');
    state[role + 'Token'] = token;
    const expires = this.now() + 10000;
    this.tokens.set(token, {state, role, expires});
    state[role].send(createMessage('split_capability', {sessionId:state.id,
      role, capability:token, generation:state.generation, expiresAt:expires}));
  }
  authorize(req) {
    this.prune();
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s=>s.trim());
    const p = protocols.find(s=>/^media_cap\.[a-f0-9]{64}$/.test(s));
    const token = p?.slice(10), grant = this.tokens.get(token);
    if (!grant || grant.expires <= this.now() || !this.current(grant.state)) return null;
    this.tokens.delete(token);
    return grant;
  }
  bind(socket, grant) {
    const {state, role} = grant;
    if (grant.bound || grant.expires <= this.now() || !this.current(state) || this.states.get(state.id) !== state) { socket.close(); return false; }
    grant.bound = true;
    state[role + 'Media'] = socket; this.owners.set(socket, grant);
    socket.on('binary', data => this.forward(socket, data));
    socket.on('message', () => socket.close(1008, 'Media is binary only'));
    socket.on('close', () => {
      if (state[role + 'Media'] === socket) state[role + 'Media'] = null;
    });
    if (state.phoneMedia && state.browserMedia) state.phone.send(createMessage('request_keyframe', {sessionId:state.id}));
    return true;
  }
  forward(socket, data) {
    const grant = this.owners.get(socket);
    if (!grant) return false;
    const {state, role} = grant;
    if (!this.current(state) || this.states.get(state.id) !== state) { this.retire(state); return false; }
    if (role !== 'phone') { socket.close(1008, 'Wrong media role'); return false; }
    if (state.phoneMedia !== socket || !state.browserMedia) return false;
    // Refresh goes through phone CONTROL, never the busy media socket.
    return state.freshness.forward(state.browserMedia, state.phone, state.id, data);
  }
  active(control) {
    const s = this.store.getSessionBySocket(control), state = s && this.states.get(s.sessionId);
    return !!state && this.current(state);
  }
  controlClosed(control) {
    for (const s of this.states.values()) if (s.phone === control || s.browser === control) this.retire(s);
  }
  legacy(control) { const s=this.store.getSessionBySocket(control); if(s) this.retire(this.states.get(s.sessionId)||{}); }
}
module.exports = SplitMedia;
