/* Optional KarCast UI capabilities. No video decoder, recovery timer or touch changes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KarCastFeatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
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
    // V80 (CR-20261021-REMOVE-NOTIFICATIONS C): no notification card or queue; the channel carries presence only.
    const doc = env.document, events = [];
    let channel = null, timer = null, previousUiState = '', trigger = '', lastPresentedMonoMs = -1, lastFrame = 0, generation = null;
    let journal;
    const record = (event, details) => { const p = { monoMs:performance.now(), event, ...details }; events.push(p); if (events.length > 320) events.shift(); if (journal) journal.textContent = JSON.stringify(events, null, 2); };
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
    function detach() { clearInterval(timer); timer = null; generation = null; lastFrame = 0; lastPresentedMonoMs = -1; if (channel) { channel.onmessage = channel.onopen = channel.onclose = null; try { channel.close(); } catch (_) {} channel = null; } }
    function attach(peer) {
      detach();
      try {
        channel = peer.createDataChannel('karcast-features', { ordered:false, maxRetransmits:0 });
        channel.onopen = pulse;
        channel.onmessage = e => { try { if (typeof e.data !== 'string' || e.data.length > 2048) return; const p = JSON.parse(e.data); if (p?.type === 'feature_ready' && Number.isSafeInteger(p.generation)) { generation = p.generation; record('session_generation',{generation}); pulse(); return; } } catch (_) { record('feature_payload_rejected', {}); } };
        timer = setInterval(pulse, 5000);
      } catch (_) { record('optional_channel_unavailable', {}); }
    }
    try {
      // V75 (CR-20261020-REMOVE-PAGE-MIC-BAR A/B): no microphone bar; Android Auto voice uses the phone's microphone
      // (V74). The journal still records; its panel is a small corner toggle shown only with &diag=1.
      if (diagnosticsRequested(env)) {
        const details = doc.createElement('details'); details.id = 'karcast-diagnostics';
        const summary = doc.createElement('summary'); summary.textContent = 'Startup diagnostics';
        journal = doc.createElement('pre'); details.append(summary, journal); doc.body.appendChild(details);
        journal.textContent = JSON.stringify(events, null, 2);
      }
      doc.addEventListener('visibilitychange', () => { pulse(); });
      env.addEventListener('pagehide', () => { try { if (channel?.readyState === 'open') channel.send(JSON.stringify({type:'presence', consuming:false})); } catch (_) {} detach(); });
    } catch (_) { /* Optional UI cannot fail core startup. */ }
    // V71 (CR-20261019-LOCAL-LINK-DIAGNOSTICS C): app.js notes phone attempts and the /health probe here.
    const note = (event, details) => { try { if (typeof event === 'string' && event.length <= 40) record(event, details && typeof details === 'object' ? details : {}); } catch (_) {} };
    return { attach, detach, note, transition(previous, next, reason) { try { previousUiState=previous; trigger=reason; record('ui_transition',{previous,next,trigger:reason,triggerStack:String(new Error().stack || '').split('\n').slice(1,5),...readState()}); pulse(); } catch (_) {} }, events };
  }
  /** V75 B: the diagnostics panel is opt-in through the page link (&diag=1); default driving shows nothing. */
  function diagnosticsRequested(env) {
    try { return new URLSearchParams(env.location?.search || '').get('diag') === '1'; } catch (_) { return false; }
  }
  return { microphoneCapability, Microphone, install, diagnosticsRequested };
});
