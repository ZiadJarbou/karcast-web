/* Optional KarCast UI capabilities. No video decoder, recovery timer or touch changes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KarCastFeatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  class NotificationQueue {
    constructor(now = () => performance.now(), limit = 4) { this.now = now; this.limit = limit; this.items = []; this.ids = new Set(); }
    push(p) {
      if (!p || p.type !== 'notification' || typeof p.id !== 'string' || p.id.length > 80 || this.ids.has(p.id) ||
          typeof p.app !== 'string' || !p.app || p.app.length > 80 || typeof p.ttlMs !== 'number' || p.ttlMs <= 0 || p.ttlMs > 30000 ||
          (p.sender != null && (typeof p.sender !== 'string' || p.sender.length > 100)) ||
          (p.preview != null && (typeof p.preview !== 'string' || p.preview.length > 240))) return false;
      if (this.items.length >= this.limit) this.items.shift();
      this.items.push({ ...p, expires: this.now() + p.ttlMs }); this.ids.add(p.id);
      if (this.ids.size > 64) this.ids.delete(this.ids.values().next().value);
      return true;
    }
    next() { while (this.items.length) { const p = this.items.shift(); if (p.expires > this.now()) return p; } return null; }
    clear() { this.items = []; this.ids.clear(); }
  }
  function microphoneCapability(env) {
    return { secureContext: env.isSecureContext === true, mediaDevices: !!env.navigator?.mediaDevices,
      getUserMedia: typeof env.navigator?.mediaDevices?.getUserMedia === 'function' };
  }
  class Microphone {
    constructor(env, changed = () => {}) { this.env = env; this.changed = changed; this.stream = null; this.generation = 0; this.busy = false; this.state = 'Microphone Off'; this.result = microphoneCapability(env); }
    set(state, extra = {}) { this.state = state; this.result = { ...this.result, ...extra }; try { this.changed(state, this.result); } catch (_) {} }
    stop() { ++this.generation; this.busy = false; this.stream?.getTracks().forEach(t => { try { t.stop(); } catch (_) {} }); this.stream = null; this.set('Microphone Off'); }
    async request() {
      if (this.busy) { this.stop(); return; }
      if (this.stream) { this.stop(); return; }
      const c = microphoneCapability(this.env); this.result = c;
      if (!c.secureContext || !c.getUserMedia) { this.set('Microphone Unavailable', { reason: "Microphone access isn't available in this browser." }); return; }
      const generation = ++this.generation; this.busy = true; this.set('Allow Microphone');
      try {
        // Caller invokes only from a direct click. No auto prompt or audio output/mixing.
        const stream = await this.env.navigator.mediaDevices.getUserMedia({ audio: true });
        if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
        const tracks = stream.getAudioTracks();
        this.result = { ...this.result, streamReturned:true, audioTrackCount:tracks.length };
        const live = tracks.find(t => t.readyState === 'live' && t.enabled && !t.muted);
        if (!live) { stream.getTracks().forEach(t => t.stop()); this.set('Microphone Unavailable', { reason: 'No live, unmuted audio track returned.', tracks: tracks.map(t => ({ readyState:t.readyState, enabled:t.enabled, muted:t.muted })) }); return; }
        this.stream = stream;
        this.set('Microphone Active', { tracks: tracks.map(t => ({ readyState:t.readyState, enabled:t.enabled, muted:t.muted })) });
        for (const t of tracks) {
          t.addEventListener?.('ended', () => { if (generation === this.generation && this.stream === stream) this.stop(); }, { once:true });
          t.addEventListener?.('mute', () => { if (generation === this.generation && this.stream === stream) this.set('Microphone Unavailable', { reason:'Audio track muted.' }); });
          t.addEventListener?.('unmute', () => { if (generation === this.generation && this.stream === stream && t.readyState === 'live') this.set('Microphone Active'); });
        }
      } catch (e) {
        if (generation !== this.generation) return;
        this.set(e.name === 'NotAllowedError' ? 'Microphone Permission Denied' : 'Microphone Unavailable', { errorName:String(e.name || 'Error'), errorCode:e.code ?? null, errorMessage:String(e.message || '').slice(0,200) });
      } finally { if (generation === this.generation) this.busy = false; }
    }
  }
  function install(env, readState) {
    const doc = env.document, events = [], queue = new NotificationQueue();
    let channel = null, timer = null, dismissTimer = null, current = null, previousUiState = '', trigger = '', lastPresentedMonoMs = -1, lastFrame = 0, generation = null;
    let card, micButton, micState, journal;
    const record = (event, details) => { const p = { monoMs:performance.now(), event, ...details }; events.push(p); if (events.length > 320) events.shift(); if (journal) journal.textContent = JSON.stringify(events, null, 2); };
    const mic = new Microphone(env, (state, result) => { try { micButton.textContent = state === 'Microphone Active' ? 'Turn Microphone Off' : 'Allow Microphone'; micState.textContent = state + (result.reason ? ': '+result.reason : ''); record('microphone', { state, ...result }); } catch (_) {} });
    function dismiss() { clearTimeout(dismissTimer); dismissTimer = null; current = null; if (card) { card.hidden = true; card.replaceChildren(); } showNext(); }
    function showNext() {
      if (current || !card || doc.visibilityState === 'hidden') return;
      current = queue.next(); if (!current) return;
      try {
        card.replaceChildren(); card.hidden = false;
        for (const text of [current.app, current.sender, current.preview, 'Now']) {
          if (!text) continue; const line = doc.createElement('div'); line.textContent = text; card.appendChild(line);
        }
        const view = doc.createElement('button'); view.textContent = 'View'; view.onclick = () => { clearTimeout(dismissTimer); dismissTimer = setTimeout(dismiss, Math.min(10000, current.expires-performance.now())); }; card.appendChild(view);
        const close = doc.createElement('button'); close.textContent = 'Dismiss'; close.onclick = dismiss; card.appendChild(close);
        dismissTimer = setTimeout(dismiss, Math.min(5000, current.expires-performance.now()));
      } catch (_) { current = null; if (card) card.hidden = true; record('notification_ui_error', {}); }
    }
    function pulse() {
      try {
        const s = readState();
        if (s.frames !== lastFrame) { lastFrame = s.frames; lastPresentedMonoMs = typeof s.lastPresentedMonoMs === 'number' ? s.lastPresentedMonoMs : performance.now(); }
        if (channel?.readyState === 'open' && channel.bufferedAmount < 4096) channel.send(JSON.stringify({ type:'presence',generation,
          monoMs:Math.floor(performance.now()), previousUiState, uiState:s.uiState, trigger,
          peer:s.peer, ice:s.ice, dataChannel:s.dataChannel, path:s.path,
          video:s.video, browserBuild:s.browserBuild,layout:s.layout, lastPresentedMonoMs:Math.floor(lastPresentedMonoMs), consuming:doc.visibilityState !== 'hidden' && s.uiState === 'CONNECTED' && s.mediaStarted === true }));
      } catch (_) { record('feature_transport_error', {}); }
    }
    function detach() { clearInterval(timer); timer = null; generation = null; lastFrame = 0; lastPresentedMonoMs = -1; if (channel) { channel.onmessage = channel.onopen = channel.onclose = null; try { channel.close(); } catch (_) {} channel = null; } clearTimeout(dismissTimer); current = null; queue.clear(); if (card) { card.hidden = true; card.replaceChildren(); } mic.stop(); }
    function attach(peer) {
      detach();
      try {
        channel = peer.createDataChannel('karcast-features', { ordered:false, maxRetransmits:0 });
        channel.onopen = pulse;
        channel.onmessage = e => { try { if (typeof e.data !== 'string' || e.data.length > 2048) return; const p = JSON.parse(e.data); if (p?.type === 'feature_ready' && Number.isSafeInteger(p.generation)) { generation = p.generation; record('session_generation',{generation}); pulse(); return; } if (queue.push(p)) showNext(); } catch (_) { record('notification_payload_rejected', {}); } };
        timer = setInterval(pulse, 5000);
      } catch (_) { record('optional_channel_unavailable', {}); }
    }
    try {
      const controls = doc.createElement('div'); controls.id = 'karcast-feature-controls';
      micButton = doc.createElement('button'); micButton.textContent = 'Allow Microphone'; micButton.onclick = () => mic.request();
      micState = doc.createElement('span'); micState.textContent = 'Microphone Off'; controls.append(micButton, micState);
      const details = doc.createElement('details'); const summary = doc.createElement('summary'); summary.textContent = 'Startup & microphone diagnostics';
      journal = doc.createElement('pre'); details.append(summary,journal); controls.appendChild(details); doc.body.appendChild(controls);
      doc.body.classList?.add('karcast-controls-reserved');
      card = doc.createElement('aside'); card.id = 'karcast-notification'; card.setAttribute('aria-live','polite'); card.hidden = true; doc.body.appendChild(card);
      record('microphone_capability', microphoneCapability(env));
      doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') { mic.stop(); queue.clear(); clearTimeout(dismissTimer); current = null; card.hidden = true; card.replaceChildren(); } pulse(); });
      env.addEventListener('pagehide', () => { try { if (channel?.readyState === 'open') channel.send(JSON.stringify({type:'presence', consuming:false})); } catch (_) {} detach(); });
    } catch (_) { /* Optional UI cannot fail core startup. */ }
    return { attach, detach, transition(previous, next, reason) { try { previousUiState=previous; trigger=reason; record('ui_transition',{previous,next,trigger:reason,triggerStack:String(new Error().stack || '').split('\n').slice(1,5),...readState()}); pulse(); } catch (_) {} }, events, microphone:mic };
  }
  return { NotificationQueue, microphoneCapability, Microphone, install };
});
