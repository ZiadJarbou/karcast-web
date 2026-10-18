/**
 * KarCast Vehicle Browser Client (https://app.karcast.app)
 * Version: 2.0
 *
 * Public entry point for Tesla and vehicle browsers.
 * Bootstraps WebRTC signaling via wss://app.karcast.app/ws.
 * Original H264 uses a reliable local data channel; secure relay is a fallback.
 */

(function () {
  'use strict';

  const PROTOCOL_VERSION = '1.0';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const DEFAULT_SIGNAL_URL = `${protocol}//${location.host}/ws`;
  const urlParams = new URLSearchParams(window.location.search);
  // V63: ?signal= may point at the phone itself on its hotspot (local transport). If the phone
  // cannot be reached there LOCAL_FALLBACK_AFTER times in a row before any open, use the normal
  // server relay instead (car not on the phone hotspot, or local mode not active on the phone).
  const REQUESTED_SIGNAL_URL = window.KARCAST_SIGNAL_URL || urlParams.get('signal') || DEFAULT_SIGNAL_URL;
  let SIGNAL_URL = REQUESTED_SIGNAL_URL;
  const LOCAL_SIGNAL = SIGNAL_URL !== DEFAULT_SIGNAL_URL && !window.KARCAST_SIGNAL_URL;
  const LOCAL_FALLBACK_AFTER = 3;
  // V65 (amendment A1): the server relay costs mobile data twice, so falling back to it is opt-in
  // (&fallback=relay). Otherwise the page keeps retrying the phone and asks for the hotspot.
  const LOCAL_FALLBACK_ALLOWED = (urlParams.get('fallback') || '').toLowerCase() === 'relay';
  const LOCAL_ONLY_MESSAGE = 'Connect the car to the phone hotspot, then keep this page open.';
  let localSignalFailures = 0, localSignalOpened = false, localOnlyHint = false;
  function noteLocalSignalFailure() {
    if (!LOCAL_SIGNAL || SIGNAL_URL !== REQUESTED_SIGNAL_URL || localSignalOpened) return;
    if (++localSignalFailures < LOCAL_FALLBACK_AFTER) return;
    if (!LOCAL_FALLBACK_ALLOWED) {
      localOnlyHint = true;
      diagnostics.localOnlyWaits = (diagnostics.localOnlyWaits || 0) + 1;
      if (messageBox) { messageBox.textContent = LOCAL_ONLY_MESSAGE; messageBox.hidden = false; }
      return;
    }
    SIGNAL_URL = DEFAULT_SIGNAL_URL;
    diagnostics.localFallbacks = (diagnostics.localFallbacks || 0) + 1;
  }
  const SHOW_METRICS = urlParams.get('metrics') === '1';
  const requestedTransport = (urlParams.get('transport') || '').toLowerCase();
  // V60 change request A, opt-in for field comparison: present=latest shows the
  // newest decoded picture instead of freezing, re-baselines transit per window
  // and retires backlog only beyond LIVE_BACKLOG_LIMIT_MS. Default unchanged.
  const PRESENT_LATEST = (urlParams.get('present') || '').toLowerCase() === 'latest';
  const RELAY_AVAILABLE = !!window.VideoDecoder && !!window.EncodedVideoChunk;
  let splitSelected = RELAY_AVAILABLE && requestedTransport === 'ws-split';
  let splitClient = null;
  let useRelay = RELAY_AVAILABLE && (requestedTransport === 'relay' || splitSelected);
  const USE_RAW_VIDEO = RELAY_AVAILABLE && !['relay', 'ws-split', 'webrtc', 'auto'].includes(requestedTransport);
  const AUTO_RELAY = RELAY_AVAILABLE && requestedTransport !== 'webrtc';
  const DIRECT_START_TIMEOUT_MS = 15000;

  // UI Elements
  const overlay = document.getElementById('pairing-overlay');
  const messageBox = document.getElementById('message-box');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const connectionPill = document.getElementById('connection-pill');
  const remoteVideo = document.getElementById('remoteVideo');
  const dockVideo = document.getElementById('dockVideo');
  const streamContainer = document.getElementById('stream-container');
  const relayCanvas = document.getElementById('relayCanvas');
  const relayContext = relayCanvas ? relayCanvas.getContext('2d', { alpha: false }) : null;
  const relayDockCanvas = document.getElementById('relayDockCanvas');
  const relayDockContext = relayDockCanvas ? relayDockCanvas.getContext('2d', { alpha: false }) : null;
  // Older APKs use a 128px dock. New APKs announce their native visible rectangle.
  const DOCK_SHARE = 128 / 720;
  let videoLayout = null;
  const nativeScene = () => videoLayout?.schema === 2;
  function browserViewport() {
    const r = streamContainer?.getBoundingClientRect?.();
    const width = Math.round(r?.width || 0), height = Math.round(r?.height || 0);
    return {schema:2,width,height};
  }
  const dockShare = () => videoLayout ? videoLayout.dockHeight / videoLayout.visibleHeight : DOCK_SHARE;
  function applyVideoLayout(layout) {
    if (layout?.schema === 2) {
      if (!['width','height','left','top','visibleWidth','visibleHeight'].every(k => Number.isInteger(layout[k])) ||
          layout.width !== 1280 || layout.height !== 720 || layout.left < 0 || layout.top < 0 ||
          layout.visibleWidth < 320 || layout.visibleHeight < 240 ||
          layout.left*2+layout.visibleWidth !== layout.width || layout.top*2+layout.visibleHeight !== layout.height ||
          layout.visibleWidth%2 || layout.visibleHeight%2) return;
      if (videoLayout && ['width','height','left','top','visibleWidth','visibleHeight','schema'].some(k => videoLayout[k] !== layout[k])) return;
      videoLayout = Object.assign({},layout);
      updatePresentationLayout(); return;
    }
    if (videoLayout?.schema === 2 || (layout?.schema !== undefined && layout.schema !== 1)) return;
    if (!layout || !['width','height','left','top','visibleWidth','visibleHeight','dockHeight'].every(k => Number.isInteger(layout[k]))) return;
    if (layout.width > 3840 || layout.height > 2160 || layout.left < 0 || layout.top !== 0 ||
        layout.visibleWidth < 320 || layout.visibleHeight < 240 || layout.dockHeight < 32 ||
        layout.dockHeight > layout.visibleHeight / 3 || layout.left + layout.visibleWidth > layout.width ||
        layout.visibleHeight !== layout.height || layout.left * 2 + layout.visibleWidth !== layout.width) return;
    videoLayout = layout;
    updatePresentationLayout();
  }
  const metricsPanel = document.getElementById('metrics-panel');

  const cardHeading = document.getElementById('card-heading');
  const cardSubtitle = document.getElementById('card-subtitle');
  const waitingSteps = document.getElementById('waiting-steps');
  const progressTimeline = document.getElementById('progress-timeline');
  const statusPanelTitle = document.getElementById('status-panel-title');
  const statusPanelSub = document.getElementById('status-panel-sub');
  const connectionProgressTrack = document.getElementById('connection-progress-track');
  const connectionProgressFill = document.getElementById('connection-progress-fill');
  const connectionProgressValue = document.getElementById('connection-progress-value');

  const circleStep1 = document.getElementById('circle-step-1');
  const badgeStep1 = document.getElementById('badge-step-1');
  const circleStep2 = document.getElementById('circle-step-2');
  const badgeStep2 = document.getElementById('badge-step-2');
  const circleStep3 = document.getElementById('circle-step-3');
  const titleStep3 = document.getElementById('title-step-3');
  const badgeStep3 = document.getElementById('badge-step-3');

  // Application State
  let state = 'READY'; // READY, PAIRING, ESTABLISHING_SECURE_CONNECTION, CONNECTED, RECONNECTING, FAILED
  let pairingCode = urlParams.get('pair_code') || '';
  let pairToken = '';
  const validPairToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
  function savePairToken(token) {
    if (!validPairToken(token)) return;
    pairToken = token;
    try { window.localStorage.setItem('karcast_pair_token', token); } catch (_) {}
  }
  try { savePairToken(window.localStorage.getItem('karcast_pair_token')); } catch (_) {}
  const linkToken = new URLSearchParams((window.location.hash || '').slice(1)).get('pair_token');
  if (validPairToken(linkToken)) {
    savePairToken(linkToken);
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) {}
  }
  const pairForm = document.getElementById('pair-form');
  const pairInput = document.getElementById('pair-code');
  if (pairForm) pairForm.addEventListener('submit', event => {
    event.preventDefault();
    const code = (pairInput.value || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return;
    pairToken = ''; pairingCode = code;
    try { window.localStorage.removeItem('karcast_pair_token'); } catch (_) {}
    connectAndJoin();
  });
  let sessionId = null;
  let ws = null;
  let pc = null;
  let dc = null;
  let heartbeatTimer = null;
  // V61 signaling liveness. A WebSocket on a vanished network can stay "open"
  // for minutes; the V61 server sends a liveness heartbeat every ~2.5s, so
  // silence beyond SIGNAL_DEAD_MS means the path is dead. Enforced only after
  // the server has shown it sends liveness heartbeats (older servers do not).
  const SIGNAL_RETRY_CAP_MS = 5000, SIGNAL_DEAD_MS = 8000, SIGNAL_CONNECT_TIMEOUT_MS = 6000;
  let wsStartedAt = 0, lastServerMessageAt = 0, serverSendsLiveness = false;
  function fastRejoin(reason) {
    diagnostics.fastRejoins = (diagnostics.fastRejoins || 0) + 1;
    diagnostics.lastFastRejoinReason = reason;
    clearTimeout(reconnectTimer);
    retireSignalingSocket();
    connectAndJoin(hasConnectedPeerTransport());
  }
  function checkSignalingLiveness(now) {
    if (!ws) return;
    if (ws.readyState === 0 && wsStartedAt && now - wsStartedAt > SIGNAL_CONNECT_TIMEOUT_MS) { noteLocalSignalFailure(); fastRejoin('signaling connect timeout'); return; }
    if (ws.readyState === 1 && serverSendsLiveness && lastServerMessageAt && now - lastServerMessageAt > SIGNAL_DEAD_MS) fastRejoin('signaling silent');
  }
  let connectionWatchdogTimer = null;
  let reconnectTimer = null;
  let disconnectGraceTimer = null;
  let connectAttempt = 0;
  let mediaStarted = false;
  let progressValue = 0;
  let progressCeiling = 0;
  let progressTimer = null;
  let seq = 0;
  let pressedPointer = null;
  let lastPoint = { x: 0, y: 0 };
  let relayDecoder = null;
  let videoChannel = null;
  let rawFrame = null;
  let relayDecoderFailed = false;
  let transportFallbackTimer = null;
  let relayConfig = [];
  let relayHasKeyframe = false;
  let lastPresentedFrameAt = 0;
  let lastPresentedMonotonicMs = -1;
  let relayReceivedAt = 0;
  let relayRefreshAt = 0;
  let relayDecoderGeneration = 0;
  let relayDecoderPresented = false;
  let relayDecoderStartedAt = 0;
  let relayInputQueue = [];
  let relayInputBytes = 0;
  let relayInFlight = [];
  // Source clocks differ from the browser clock. Minimum transit offset measures
  // growth above the best observed path, without assuming synchronized clocks.
  let rawTransitFloor = null;
  let rawLastTimestamp = 0;
  // Replayed/duplicate pictures are transport activity, not live source progress.
  // They must not consume the existing quiet-source clock recalibration.
  let rawSourceReceivedAt = 0;
  // Freshness keeps a session-wide high-water mark. Duplicate suppression
  // belongs to the current decoder's reference chain, which may be replayed.
  let rawDecodeLastTimestamp = 0;
  const LIVE_VIDEO_BUDGET_MS = 250;
  // V60: a late picture is skipped only while something newer can replace it.
  // After this long without presentation the newest decoded picture is drawn
  // even when late: a late image is better than a frozen screen.
  const MAX_PRESENTATION_GAP_MS = 1000;
  // Queued, undecoded work is retired only when this far behind; retirement
  // always requests a new reference chain in the same step.
  const LIVE_BACKLOG_LIMIT_MS = PRESENT_LATEST ? 3000 : LIVE_VIDEO_BUDGET_MS;
  // The transit baseline is the minimum over the last two 5s windows, so a
  // lasting path-delay increase re-baselines instead of aging every frame.
  const TRANSIT_WINDOW_MS = 5000;
  let transitWindowStart = 0, transitWindowMin = null, transitPreviousMin = null;
  function observeTransit(transit, nowMs) {
    if (!transitWindowStart || nowMs - transitWindowStart >= TRANSIT_WINDOW_MS) {
      transitPreviousMin = transitWindowMin; transitWindowMin = null; transitWindowStart = nowMs;
    }
    transitWindowMin = transitWindowMin === null ? transit : Math.min(transitWindowMin, transit);
    return transitPreviousMin === null ? transitWindowMin : Math.min(transitPreviousMin, transitWindowMin);
  }
  function resetTransitWindow() { transitWindowStart = 0; transitWindowMin = transitPreviousMin = null; }
  const RAW_REFERENCE_BOOTSTRAP_MS = 2000;
  let rawReferenceDeadline = null;
  let rawReferenceCatchup = false;
  let rawFailedReferenceNotified = false;
  function noteExpiredReferenceRecovery() {
    // Report actual failure of the existing fixed deadline, once, without
    // extending decoder work or starting another cached-reference episode.
    if (!useRelay || rawFailedReferenceNotified || state !== 'CONNECTED' ||
        rawReferenceDeadline === null || rawNow() < rawReferenceDeadline ||
        !diagnostics.presentedFrames ||
        (diagnostics.lastFrameReceivedAt || 0) - (diagnostics.lastFramePresentedAt || 0) < 2000) return;
    rawFailedReferenceNotified = true;
    diagnostics.referenceRecoveryFailed = 1;
    requestVideoRefresh();
  }
  function bootstrappingReferences() {
    noteExpiredReferenceRecovery();
    return rawReferenceDeadline !== null && rawNow() < rawReferenceDeadline;
  }
  function rawNow() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
  function rawFrameAge(unit) {
    // Freeze the transit estimate when admitted. A cached GOP can arrive in a
    // burst: later PTS lowers the clock offset, but must not retroactively age
    // the IDR already decoding and destroy its entire reference chain.
    return Math.max(0, rawNow() - unit.arrivedAt) + (unit.transitAgeMs || 0);
  }
  function collapseStaleVideo(reason) {
    // Dropping encoded deltas invalidates references. Retire this decoder and
    // wait for an IDR, retaining SPS/PPS. Never reconnect AA or the peer here.
    // V60: retirement and its keyframe request are one step. While the refresh
    // cooldown blocks the request, keep the working decoder instead of waiting
    // for Android Auto's next natural IDR (field: ~60s frozen).
    // Default policy keeps V59 retirement; its watchdog re-requests after cooldown.
    if (PRESENT_LATEST && !refreshAllowed()) { diagnostics.retirementsDeferred = (diagnostics.retirementsDeferred || 0) + 1; return false; }
    diagnostics.staleVideoDrops = (diagnostics.staleVideoDrops || 0) + relayInputQueue.length + relayInFlight.length;
    clearRawDecoderWork();
    // An accepted paced retirement owns a fresh bounded reference episode.
    recoverRawVideo(reason, false, reason === 'Transport exceeded live video budget' ? 'immediate' : false);
    return true;
  }
  let relayPumping = false;
  let rawMissingSince = 0;
  let rawSourceBaseline = 0;
  let rawPresentationStallAt = 0;
  let rawPresentationSourceBaseline = 0;
  let lastDecodedFrameAt = 0;
  let presentationRecoveryAt = 0;
  let decodedSincePresentation = 0;
  const MAX_DECODE_IN_FLIGHT = 8;
  const MAX_VIDEO_QUEUE_BYTES = 20 * 1024 * 1024;
  const MAX_VIDEO_QUEUE_FRAMES = 4096;
  let pendingCandidates = [];
  let signalingOnlyReconnect = false;
  let firstFrameTimer = null;
  let connectionStartedAt = 0;
  let mediaHealthTimer = null;
  let renderedFrameAt = 0;
  let renderedCallback = null;
  let renderGeneration = 0;
  let phoneProgressAt = 0;
  let phoneSourceFrames = 0;
  let phoneStatusAt = 0;
  // AA can take about a minute to send another IDR after a browser joins late.
  const CONNECTION_TIMEOUT_MS = 90000;

  function renderProgress() {
    const value = Math.max(0, Math.min(100, Math.round(progressValue)));
    if (connectionProgressValue) connectionProgressValue.textContent = `${value}%`;
    if (connectionProgressFill) connectionProgressFill.style.width = `${value}%`;
    if (connectionProgressTrack) connectionProgressTrack.setAttribute('aria-valuenow', String(value));
  }

  function ensureProgressTimer() {
    if (progressTimer) return;
    progressTimer = setInterval(() => {
      if (progressValue >= progressCeiling) return;
      progressValue = Math.min(progressCeiling, progressValue + 1);
      renderProgress();
    }, 650);
  }

  function setProgressMilestone(value, ceiling = value) {
    progressValue = Math.max(progressValue, value);
    progressCeiling = Math.max(progressCeiling, ceiling);
    renderProgress();
    ensureProgressTimer();
  }

  function resetProgress() {
    progressValue = 0;
    progressCeiling = 0;
    renderProgress();
    ensureProgressTimer();
  }

  // Diagnostic histogram: fixed 26 buckets, 10ms upper bounds, no frame payloads.
  const frameAgeBuckets = new Array(26).fill(0);
  function recordFrameAge(age) {
    frameAgeBuckets[Math.min(25, Math.max(0, Math.ceil(age / 10)))]++;
    const count = frameAgeBuckets.reduce((a,b)=>a+b,0);
    diagnostics.frameAgeSamples = count;
    for (const p of [50,95,99]) {
      let cumulative=0;
      for (let i=0;i<26;i++) { cumulative+=frameAgeBuckets[i]; if (cumulative>=Math.ceil(count*p/100)) {diagnostics["frameAgeP"+p+"Ms"]=i*10; break;} }
    }
  }
  // Diagnostics & Metrics
  const diagnostics = {
    inputCapabilities: {pointer:true, drag:true, swipe:true, longPress:true, text:false,
      keyboard:false, nativeBack:false, nativeMedia:false, appLaunch:false, multiTouch:false},
    DIRECT_REQUESTED: ["relay", "ws-split"].includes(requestedTransport) ? 0 : 1,
    DIRECT_ATTEMPT_STARTED: 0, DIRECT_ICE_STATE: 0, DIRECT_FAILURE_REASON: 0, DIRECT_TIMEOUT: 0,
    FALLBACK_TO_RELAY_REASON: 0, FINAL_TRANSPORT: 0,
    diagnosticsBuildId: 'fieldlog-v65-taadavpn1-20261016-01',
    presentLatest: PRESENT_LATEST ? 1 : 0,
    recoveryRequests: 0,
    relayStalls: 0,
    signalingReconnects: 0,
    relayAvailable: RELAY_AVAILABLE,
    connectionPath: 'unknown',
    localCandidateType: 'none',
    remoteCandidateType: 'none',
    localCandidateAddress: 'none',
    remoteCandidateAddress: 'none',
    protocol: 'udp',
    candidatePairRttMs: null,
    signalingState: 'closed',
    peerConnectionState: 'closed',
    dataChannelState: 'closed',
    presentedFrames: 0,
    rttMs: null,
    packetsLost: 0,
    fps: 0
  };

  const optionalFeatures = (() => {
    try { return window.KarCastFeatures?.install(window, () => ({ uiState:state, mediaStarted,
      peer:diagnostics.peerConnectionState, ice:diagnostics.iceConnectionState,
      dataChannel:diagnostics.dataChannelState, path:diagnostics.connectionPath,
      frames:diagnostics.presentedFrames || diagnostics.framesDecoded || 0,
      lastPresentedMonoMs:lastPresentedMonotonicMs, browserBuild:diagnostics.diagnosticsBuildId,layout:videoLayout,
      video:Object.fromEntries(["splitRecoverySourceBaselineUs","splitFirstSourceNewDecodedAt","splitFirstSourceNewPresentedAt","lastReceivedIdrSourceUs","lastPresentedSourceUs","lastFrameReceivedAt","lastFrameDecodedAt","lastFramePresentedAt","presentationRecoveries","presentationSurfaceErrors","DIRECT_REQUESTED","DIRECT_ATTEMPT_STARTED","DIRECT_ICE_STATE","DIRECT_FAILURE_REASON","DIRECT_TIMEOUT","FALLBACK_TO_RELAY_REASON","FINAL_TRANSPORT","presentedFrames","framesDecoded","firstFrameMs","frameAgeMs","pendingVideoFrames","videoQueueBytes","decodeQueueSize","staleVideoDrops","recoveryRequests","relayStalls","signalingReconnects","connectionAttempts","frameAgeSamples","frameAgeP50Ms","frameAgeP95Ms","frameAgeP99Ms","DIRECT_LOCAL_HOST","DIRECT_LOCAL_MDNS","DIRECT_LOCAL_SRFLX","DIRECT_LOCAL_RELAY","DIRECT_REMOTE_HOST","DIRECT_REMOTE_MDNS","DIRECT_PAIRS_TOTAL","DIRECT_PAIRS_FAILED","latePresentations","retirementsDeferred","transitAgeMs","presentLatest","fastRejoins"].filter(k=>Number.isFinite(diagnostics[k])).map(k=>[k,diagnostics[k]])),
      aa:diagnostics.androidAutoState, signaling:ws?.readyState === WebSocket.OPEN ? 'OPEN' : 'NOT_OPEN' })); }
    catch (_) { return null; }
  })();
  function optionalFeature(method, ...args) { try { optionalFeatures?.[method](...args); } catch (_) {} }
  function setUIState(newState, userMessage = '', isError = false) {
    // V65: until the phone has answered once, every waiting state keeps the hotspot hint visible.
    if (!userMessage && localOnlyHint && !localSignalOpened) userMessage = LOCAL_ONLY_MESSAGE;
    const previousState = state;
    state = newState;
    optionalFeature('transition', previousState, newState, userMessage || newState);
    if (messageBox) {
      messageBox.textContent = userMessage;
      messageBox.hidden = !userMessage;
      messageBox.classList.toggle('error', isError);
    }

    switch (newState) {
      case 'READY':
      case 'RECONNECTING':
      case 'INVALID_CODE':
      case 'CODE_EXPIRED':
      case 'PHONE_NOT_AVAILABLE':
      case 'CONNECTION_FAILED':
        if (newState !== 'READY') resetProgress();
        statusText.textContent = 'Waiting for phone...';
        statusDot.className = 'status-dot connecting';
        overlay.hidden = false;
        connectionPill.hidden = true;

        if (cardHeading) cardHeading.textContent = 'Connect your vehicle';
        if (cardSubtitle) cardSubtitle.textContent = 'Follow these steps on your phone.';

        if (waitingSteps) waitingSteps.hidden = false;
        if (progressTimeline) progressTimeline.hidden = true;

        if (statusPanelTitle) statusPanelTitle.textContent = 'Waiting for your phone…';
        if (statusPanelSub) statusPanelSub.textContent = 'This screen will connect automatically.';
        break;

      case 'PAIRING':
        setProgressMilestone(5, 18);
        statusText.textContent = 'Looking for phone...';
        statusDot.className = 'status-dot connecting';
        overlay.hidden = false;
        connectionPill.hidden = true;

        if (cardHeading) cardHeading.textContent = 'Connect your vehicle';
        if (cardSubtitle) cardSubtitle.textContent = 'Follow these steps on your phone.';
        if (waitingSteps) waitingSteps.hidden = false;
        if (progressTimeline) progressTimeline.hidden = true;
        if (statusPanelTitle) statusPanelTitle.textContent = 'Looking for your phone…';
        if (statusPanelSub) statusPanelSub.textContent = 'Keep KarCast open after tapping Start Connection.';
        break;

      case 'ESTABLISHING_SECURE_CONNECTION':
        setProgressMilestone(30, 42);
        statusText.textContent = 'Connecting...';
        statusDot.className = 'status-dot connecting';
        overlay.hidden = false;
        connectionPill.hidden = true;

        if (cardHeading) cardHeading.textContent = 'Connecting your vehicle';
        if (cardSubtitle) cardSubtitle.textContent = 'Preparing Android Auto for your screen.';

        if (waitingSteps) waitingSteps.hidden = true;
        if (progressTimeline) progressTimeline.hidden = false;

        // Stage 1: Phone connected (Done)
        if (circleStep1) {
          circleStep1.className = 'timeline-circle completed';
          circleStep1.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        }
        if (badgeStep1) {
          badgeStep1.className = 'status-done';
          badgeStep1.textContent = 'Done';
        }

        // Stage 2: Starting Android Auto (In progress)
        if (circleStep2) {
          circleStep2.className = 'timeline-circle active';
          circleStep2.innerHTML = '<div class="spinner-ring"></div>';
        }
        if (badgeStep2) {
          badgeStep2.className = 'status-badge-progress';
          badgeStep2.textContent = 'In progress';
        }

        // Stage 3: Ready to drive (Up next)
        if (circleStep3) {
          circleStep3.className = 'timeline-circle pending';
          circleStep3.textContent = '3';
        }
        if (titleStep3) titleStep3.className = 'step-title muted';
        if (badgeStep3) {
          badgeStep3.className = 'status-muted';
          badgeStep3.textContent = 'Up next';
        }

        if (statusPanelTitle) statusPanelTitle.textContent = 'Setting things up…';
        if (statusPanelSub) statusPanelSub.textContent = 'Android Auto will appear here automatically.';
        break;

      case 'CONNECTED':
        setProgressMilestone(100);
        statusText.textContent = diagnostics.connectionPath === 'local-direct' ? 'Connected • Local Hotspot' : 'Connected';
        statusDot.className = 'status-dot connected';
        overlay.hidden = true;
        connectionPill.hidden = !SHOW_METRICS;

        if (cardHeading) cardHeading.textContent = 'Vehicle Connected';
        if (cardSubtitle) cardSubtitle.textContent = 'Android Auto is active.';

        if (waitingSteps) waitingSteps.hidden = true;
        if (progressTimeline) progressTimeline.hidden = false;

        // Stage 1, 2 & 3 All Done
        if (circleStep1) {
          circleStep1.className = 'timeline-circle completed';
          circleStep1.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        }
        if (circleStep2) {
          circleStep2.className = 'timeline-circle completed';
          circleStep2.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        }
        if (badgeStep2) {
          badgeStep2.className = 'status-done';
          badgeStep2.textContent = 'Done';
        }

        if (circleStep3) {
          circleStep3.className = 'timeline-circle completed';
          circleStep3.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        }
        if (titleStep3) titleStep3.className = 'step-title';
        if (badgeStep3) {
          badgeStep3.className = 'status-done';
          badgeStep3.textContent = 'Done';
        }

        if (statusPanelTitle) statusPanelTitle.textContent = 'Connected & Streaming Live!';
        if (statusPanelSub) statusPanelSub.textContent = 'Android Auto is streaming to your browser.';

        setTimeout(() => {
          if (state === 'CONNECTED') {
            overlay.hidden = true;
          }
        }, 1200);
        break;
    }
    renderDiagnostics();
  }

  // 2. Public Signaling Client
  function connectAndJoin(preserveMedia = false) {
    signalingOnlyReconnect = preserveMedia && hasConnectedPeerTransport();
    if (!pairToken && !/^\d{6}$/.test(pairingCode)) {
      if (pairForm) pairForm.hidden = false;
      if (cardSubtitle) cardSubtitle.textContent = 'Enter the pairing code from KarCast on your phone, or open its copied pairing link.';
      return;
    }
    if (pairForm) pairForm.hidden = true;
    retireSignalingSocket();
    connectAttempt++;

    if (!signalingOnlyReconnect) {
      connectionStartedAt = Date.now();
      resetProgress();
      setUIState('PAIRING');
      cleanupWebRTC();
    }
    clearTimeout(reconnectTimer);
    clearConnectionWatchdog();

    try {
      ws = new WebSocket(SIGNAL_URL, pairToken ? ['karcast-v1', 'pair_token.' + pairToken] : ['karcast-v1']);
      ws.binaryType = 'arraybuffer';
      wsStartedAt = Date.now(); lastServerMessageAt = 0;
      diagnostics.signalingState = 'connecting';
      diagnostics.connectionAttempts = connectAttempt;
    } catch (err) {
      if (!signalingOnlyReconnect) setUIState('CONNECTION_FAILED');
      scheduleReconnect(signalingOnlyReconnect);
      return;
    }

    const socket = ws;
    if (!signalingOnlyReconnect) armConnectionWatchdog(30000);

    ws.onopen = () => {
      if (ws !== socket) return;
      if (SIGNAL_URL === REQUESTED_SIGNAL_URL) { localSignalOpened = true; localSignalFailures = 0; }
      if (!signalingOnlyReconnect) setProgressMilestone(12, 22);
      diagnostics.signalingState = 'open';
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: 'heartbeat',
            messageId: 'ping_' + Date.now(),
            timestamp: Date.now()
          }));
          // Existing paired relay-status control carries numeric diagnostics only.
          if (useRelay && sessionId && ws.bufferedAmount < 4096) ws.send(JSON.stringify({
            version:PROTOCOL_VERSION,type:'relay_status',sessionId,messageId:'field_'+Date.now(),timestamp:Date.now(),
            fieldMetrics:{browserBuild:diagnostics.diagnosticsBuildId,layout:videoLayout,path:splitSelected?'secure-split-media':'secure-relay',consuming:state==='CONNECTED',video:Object.fromEntries(['lastReceivedIdrSourceUs','lastPresentedSourceUs','lastFrameReceivedAt','lastFrameDecodedAt','lastFramePresentedAt','presentationRecoveries','presentationSurfaceErrors','DIRECT_REQUESTED','DIRECT_ATTEMPT_STARTED','DIRECT_ICE_STATE','DIRECT_FAILURE_REASON','DIRECT_TIMEOUT','FALLBACK_TO_RELAY_REASON','FINAL_TRANSPORT','presentedFrames','framesDecoded','firstFrameMs','frameAgeMs','pendingVideoFrames','videoQueueBytes','decodeQueueSize','staleVideoDrops','recoveryRequests','relayStalls','signalingReconnects','connectionAttempts','frameAgeSamples','frameAgeP50Ms','frameAgeP95Ms','frameAgeP99Ms','DIRECT_LOCAL_HOST','DIRECT_LOCAL_MDNS','DIRECT_LOCAL_SRFLX','DIRECT_LOCAL_RELAY','DIRECT_REMOTE_HOST','DIRECT_REMOTE_MDNS','DIRECT_PAIRS_TOTAL','DIRECT_PAIRS_FAILED','latePresentations','retirementsDeferred','transitAgeMs','presentLatest','fastRejoins'].filter(k=>Number.isFinite(diagnostics[k])).map(k=>[k,diagnostics[k]]))}
          }));
        }
      }, 10000);

      ws.send(JSON.stringify({
        version: PROTOCOL_VERSION,
        type: 'join',
        pairingCode: pairingCode,
        pair_token: pairToken,
        viewport: browserViewport(),
        messageId: 'join_' + Date.now(),
        timestamp: Date.now()
      }));
    };

    ws.onmessage = (event) => {
      if (ws !== socket) return;
      lastServerMessageAt = Date.now();
      if (typeof event.data !== 'string') {
        if (splitSelected) return;
        handleRelayFrame(event.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) { return; }
      if (msg && msg.type === 'heartbeat' && msg.serverLiveness) { serverSendsLiveness = true; return; }

      handleSignalingMessage(msg);
    };

    ws.onerror = () => {
      if (ws !== socket) return;
      diagnostics.signalingState = 'error';
      if (!hasConnectedPeerTransport()) {
        setUIState('PHONE_NOT_AVAILABLE');
        scheduleReconnect();
      } else scheduleReconnect(true);
    };

    ws.onclose = event => {
      if (ws === socket) noteLocalSignalFailure();
      if (ws !== socket) return;
      stopSplitMedia();
      diagnostics.signalingState = 'closed';
      diagnostics.lastSocketCloseCode = event.code;
      diagnostics.lastSocketCloseReason = event.reason || '';
      diagnostics.signalingReconnects++;
      clearInterval(heartbeatTimer);

      if (hasConnectedPeerTransport()) {
        scheduleReconnect(true);
      } else {
        scheduleReconnect();
      }
    };
  }

  function retireSignalingSocket() {
    stopSplitMedia();
    if (!ws) return;
    const socket = ws;
    ws = null;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(); } catch (_) {}
  }

  function hasConnectedPeerTransport() {
    if (!pc) return false;
    return pc.connectionState === 'connected' ||
      pc.iceConnectionState === 'connected' ||
      pc.iceConnectionState === 'completed';
  }

  function scheduleReconnect(preserveMedia = false) {
    clearConnectionWatchdog();
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    retireSignalingSocket();
    // Keep the vehicle page available across phone Stop/Start cycles.
    // V61: cap at 5s (was 10s) so a recovered network is used within seconds.
    const delay = Math.min(SIGNAL_RETRY_CAP_MS, 2500 * Math.max(1, connectAttempt));
    reconnectTimer = setTimeout(() => connectAndJoin(preserveMedia), delay);
  }

  function armConnectionWatchdog(timeoutMs = CONNECTION_TIMEOUT_MS) {
    clearConnectionWatchdog();
    connectionWatchdogTimer = setTimeout(() => {
      if (state === 'CONNECTED') return;
      if (tryRelayFallback('Direct video startup timed out')) return;
      cleanupWebRTC();
      scheduleReconnect();
    }, timeoutMs);
  }

  function clearConnectionWatchdog() {
    clearTimeout(connectionWatchdogTimer);
    connectionWatchdogTimer = null;
  }

  function markMediaConnected() {
    if (!pc || remoteVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !remoteVideo.videoWidth) {
      return;
    }
    if (dockVideo?.paused) dockVideo.play().catch(() => {});
    if (!mediaStarted) diagnostics.firstFrameMs = Date.now() - connectionStartedAt;
    mediaStarted = true;
    clearTimeout(transportFallbackTimer);
    transportFallbackTimer = null;
    clearInterval(firstFrameTimer);
    firstFrameTimer = null;
    setProgressMilestone(100);
    connectAttempt = 0;
    clearConnectionWatchdog();
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
    if (state !== 'CONNECTED') setUIState('CONNECTED');
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'split_capability':
        if (splitSelected && msg.sessionId === sessionId) {
          if (!splitClient) splitClient = new window.KarCastSplitMediaClient({
            control: () => ws, session: () => sessionId, url: SIGNAL_URL,
            frame: payload => handleRelayFrame(payload),
            generation: generation => {
              diagnostics.splitMediaGeneration = generation;
              diagnostics.splitRecoverySourceBaselineUs = rawLastTimestamp;
              diagnostics.splitFirstSourceNewDecodedAt = 0;
              diagnostics.splitFirstSourceNewPresentedAt = 0;
              diagnostics.lastRecoveryReason = 'split media generation';
              clearRawDecoderWork();
            },
            event: event => { diagnostics.splitMediaEvent = event; }
          });
          splitClient.accept(msg);
        }
        break;
      case 'split_unavailable':
        if (splitSelected) { stopSplitMedia(); splitSelected = false; startRelay(); }
        break;
      case 'joined':
          savePairToken(msg.pair_token);
        // A renewed signaling registration can assign the SAME paired phone a
        // new session ID. Recent status on the live peer proves media survived.
        const livePhone = dc?.readyState === 'open' && phoneStatusAt > 0 &&
          Date.now() - phoneStatusAt <= 6000;
        if (signalingOnlyReconnect && (sessionId === msg.sessionId || livePhone)) {
          sessionId = msg.sessionId;
          signalingOnlyReconnect = false;
          connectAttempt = 0;
          break;
        }
        if (signalingOnlyReconnect) {
          cleanupWebRTC();
          connectionStartedAt = Date.now();
        }
        signalingOnlyReconnect = false;
        sessionId = msg.sessionId;
        setProgressMilestone(30, 40);
        setUIState('ESTABLISHING_SECURE_CONNECTION');
        armConnectionWatchdog();
        if (splitSelected && (!msg.capabilities?.includes('ws-split-v1') || !window.KarCastSplitMediaClient)) {
          splitSelected = false; diagnostics.splitFallbackReason = 'capability unavailable';
        }
        if (useRelay) startRelay();
        break;

      case 'relay_status':
        if (msg.ready) setProgressMilestone(60, 82);
        break;

      case 'peer_ready':
        if (hasConnectedPeerTransport()) break;
        if (msg.role === 'phone' || msg.role === 'browser') {
          setProgressMilestone(44, 52);
          if (!useRelay) initiateWebRTCOffer();
        }
        break;

      case 'answer':
        if (pc && msg.sdp) {
          setProgressMilestone(66, 74);
          const answeringPeer = pc;
          answeringPeer.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(async () => {
            if (pc !== answeringPeer) return;
            const candidates = pendingCandidates;
            pendingCandidates = [];
            for (const candidate of candidates) await answeringPeer.addIceCandidate(candidate).catch(() => {});
          }).catch(error => {
            if (pc !== answeringPeer) return;
            if (tryRelayFallback('Remote description failed: ' + error.message)) return;
            setUIState('CONNECTION_FAILED');
            scheduleReconnect();
          });
        }
        break;

      case 'candidate':
        if (pc && msg.candidate) countIceCandidate('REMOTE', msg.candidate.candidate || msg.candidate);
        if (pc && msg.candidate) {
          if (pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => {});
          else if (pendingCandidates.length < 64) pendingCandidates.push(msg.candidate);
        }
        break;

      case 'expired':
        if (hasConnectedPeerTransport()) { scheduleReconnect(true); break; }
        setUIState('CODE_EXPIRED');
        cleanupWebRTC();
        scheduleReconnect();
        break;

      case 'closed':
        diagnostics.lastSessionCloseReason = msg.reason || '';
        if (msg.reason === 'Another vehicle browser connected') {
          cleanupWebRTC();
          clearTimeout(reconnectTimer);
          clearConnectionWatchdog();
          clearInterval(heartbeatTimer);
          if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
          setUIState('PHONE_NOT_AVAILABLE', 'Connection opened in another browser. Reload to connect here.', true);
          break;
        }
        if (hasConnectedPeerTransport()) { scheduleReconnect(true); break; }
        setUIState('PHONE_NOT_AVAILABLE');
        cleanupWebRTC();
        scheduleReconnect();
        break;

      case 'error':
        handleSignalingError(msg);
        break;
    }
  }

  function handleSignalingError(msg) {
    diagnostics.lastSignalingError = msg.code + ': ' + (msg.message || '');
    if (hasConnectedPeerTransport()) { scheduleReconnect(true); return; }
    // V60: a typed code that the server rejects is reported and not retried
    // silently (field 14 Oct: 8 hidden retries behind "Waiting for your phone").
    // Token reconnects keep their existing automatic retry.
    const typedCodeRejected = !pairToken && ['PAIRING_CODE_INVALID', 'PAIRING_CODE_EXPIRED', 'SESSION_ALREADY_PAIRED'].includes(msg.code);
    if (typedCodeRejected) {
      setUIState(msg.code === 'PAIRING_CODE_EXPIRED' ? 'CODE_EXPIRED' : 'INVALID_CODE',
        msg.code === 'PAIRING_CODE_EXPIRED' ? 'This pairing code has expired. Enter the current code shown on your phone.'
          : msg.code === 'SESSION_ALREADY_PAIRED' ? 'This code is already in use by another browser. Close the other browser, or tap Stop and Start on your phone for a new code.'
          : 'Pairing code not accepted. Check the code on your phone. If it is correct, another browser may already be connected: tap Stop and Start on your phone for a new code.', true);
      cleanupWebRTC();
      clearTimeout(reconnectTimer);
      clearConnectionWatchdog();
      pairingCode = '';
      if (pairForm) pairForm.hidden = false;
      if (pairInput) pairInput.value = '';
      retireSignalingSocket();
      return;
    }
    switch (msg.code) {
      case 'PAIRING_CODE_INVALID':
        setUIState('INVALID_CODE');
        break;
      case 'PAIRING_CODE_EXPIRED':
        setUIState('CODE_EXPIRED');
        break;
      case 'SESSION_NOT_FOUND':
        setUIState('PHONE_NOT_AVAILABLE');
        break;
      default:
        setUIState('CONNECTION_FAILED');
    }
    cleanupWebRTC();
    scheduleReconnect();
  }

  // 3. WebRTC Direct P2P Connection
  function startRelay() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) return false;
    ws.send(JSON.stringify({
      version: PROTOCOL_VERSION, type: splitSelected ? 'split_start' : 'relay_start', sessionId,
      messageId: 'relay_' + Date.now(), timestamp: Date.now()
    }));
    return true;
  }

  function tryRelayFallback(reason) {
    if (!AUTO_RELAY || useRelay || !sessionId || !ws || ws.readyState !== WebSocket.OPEN) return false;
    // Keep the pairing socket and progress: only replace the failed media transport.
    diagnostics.fallbackReason = reason;
    const code = /timed out|15 seconds/.test(reason) ? 1 : /ICE/.test(reason) ? 2 :
      /channel closed/.test(reason) ? 3 : /disconnected/.test(reason) ? 4 :
      /description|Offer/.test(reason) ? 5 : /unavailable/.test(reason) ? 6 : 7;
    diagnostics.DIRECT_FAILURE_REASON = code;
    diagnostics.FALLBACK_TO_RELAY_REASON = code;
    if (code === 1) diagnostics.DIRECT_TIMEOUT++;
    diagnostics.FINAL_TRANSPORT = 2;
    diagnostics.transport = 'relay';
    useRelay = true;
    cleanupWebRTC();
    setUIState('ESTABLISHING_SECURE_CONNECTION');
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    armConnectionWatchdog();
    startRelay();
    renderDiagnostics();
    return true;
  }

  // V60 diagnostics (numeric only, no addresses): why DIRECT fails on the car.
  // mDNS = Chromium's obfuscated ".local" host name, which the phone cannot resolve.
  function countIceCandidate(side, text) {
    const parts = String(text || '').split(' ');
    const type = parts[parts.indexOf('typ') + 1] || '';
    const mdns = /\.local$/i.test(parts[4] || '');
    const key = 'DIRECT_' + side + '_' + (mdns ? 'MDNS' : type === 'host' ? 'HOST' : type === 'srflx' || type === 'prflx' ? 'SRFLX' : type === 'relay' ? 'RELAY' : 'HOST');
    if (side === 'REMOTE' && !['DIRECT_REMOTE_HOST', 'DIRECT_REMOTE_MDNS'].includes(key)) return;
    diagnostics[key] = (diagnostics[key] || 0) + 1;
  }
  function countIcePairs(peer) {
    if (!peer || typeof peer.getStats !== 'function') return;
    peer.getStats().then(stats => {
      let total = 0, failed = 0;
      stats.forEach(r => { if (r.type === 'candidate-pair') { total++; if (r.state === 'failed') failed++; } });
      diagnostics.DIRECT_PAIRS_TOTAL = total; diagnostics.DIRECT_PAIRS_FAILED = failed;
    }).catch(() => {});
  }

  function initiateWebRTCOffer() {
    if (pc) return;
    diagnostics.DIRECT_ATTEMPT_STARTED++;

    setUIState('ESTABLISHING_SECURE_CONNECTION');
    armConnectionWatchdog();

    try {
      pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: 'max-bundle'
      });
      diagnostics.peerConnectionState = pc.connectionState;
    } catch (e) {
      if (tryRelayFallback('WebRTC unavailable: ' + e.message)) return;
      setUIState('CONNECTION_FAILED');
      return;
    }

    const peer = pc;
    optionalFeature('attach', peer);
    if (AUTO_RELAY) transportFallbackTimer = setTimeout(() => {
      if (pc === peer && !mediaStarted) tryRelayFallback('No direct video frame after 15 seconds');
    }, DIRECT_START_TIMEOUT_MS);
    dc = pc.createDataChannel('tesla-touch', { ordered: true });
    if (USE_RAW_VIDEO) {
      videoChannel = pc.createDataChannel('karcast-video', { ordered: true });
      videoChannel.binaryType = 'arraybuffer';
      videoChannel.onmessage = event => handleRawFragment(event.data);
      videoChannel.onclose = () => { if (pc === peer && mediaStarted) tryRelayFallback('Reliable video channel closed'); };
    }
    dc.onopen = () => {
      if (pc !== peer) return;
      diagnostics.dataChannelState = 'open';
      setProgressMilestone(90, 94);
      renderDiagnostics();
      requestVideoRefresh();
      clearInterval(firstFrameTimer);
      let attempts = 0;
      firstFrameTimer = setInterval(() => {
        if (mediaStarted || ++attempts > 10) { clearInterval(firstFrameTimer); firstFrameTimer = null; return; }
        requestVideoRefresh();
      }, 1000);
    };
    dc.onclose = () => { diagnostics.dataChannelState = 'closed'; renderDiagnostics(); };
    dc.onmessage = event => {
      if (pc !== peer) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type !== 'media_status') return;
        phoneStatusAt = Date.now();
        applyVideoLayout(message.layout);
        diagnostics.androidAutoState = message.state;
        if (message.sourceFrames > phoneSourceFrames) phoneProgressAt = Date.now();
        phoneSourceFrames = message.sourceFrames;
        diagnostics.phoneSourceFrames = phoneSourceFrames;
        renderDiagnostics();
      } catch (_) {}
    };
    startMediaHealthChecks(peer);

    const videoTransceiver = USE_RAW_VIDEO ? null : pc.addTransceiver('video', { direction: 'recvonly' });
    if (videoTransceiver && 'jitterBufferTarget' in videoTransceiver.receiver) {
      try { videoTransceiver.receiver.jitterBufferTarget = 0; } catch (_) {}
    }

    pc.ontrack = (e) => {
      if (pc !== peer) return;
      if (e.track) {
        setProgressMilestone(78, 86);
        remoteVideo.srcObject = new MediaStream([e.track]);
        // Reuse the same received track; no second peer or video decoder is created here.
        if (dockVideo) {
          dockVideo.srcObject = remoteVideo.srcObject;
          dockVideo.play().catch(() => {});
        }
        remoteVideo.play().catch(() => {});
        e.track.onended = () => {
          if (pc !== peer || !mediaStarted) return;
          setUIState('CONNECTION_FAILED', 'The video stream stopped. Reconnecting...', true);
          scheduleReconnect();
        };
      }
    };

    remoteVideo.onloadeddata = markMediaConnected;
    remoteVideo.onplaying = markMediaConnected;

    pc.onicecandidate = (e) => {
      if (pc !== peer) return;
      if (e.candidate) countIceCandidate('LOCAL', e.candidate.candidate);
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          version: PROTOCOL_VERSION,
          type: 'candidate',
          sessionId: sessionId,
          messageId: 'cand_' + Date.now(),
          timestamp: Date.now(),
          candidate: e.candidate.toJSON()
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc !== peer) return;
      diagnostics.DIRECT_ICE_STATE = ["new","checking","connected","completed","failed","disconnected","closed"].indexOf(pc.iceConnectionState) + 1;
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (mediaStarted) clearConnectionWatchdog();
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
        setProgressMilestone(86, 92);
        inspectSelectedIceCandidatePair();
      } else if (pc.iceConnectionState === 'failed') {
        countIcePairs(peer);
        if (tryRelayFallback('ICE connection failed')) return;
        setUIState('CONNECTION_FAILED');
        scheduleReconnect();
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc !== peer) return;
      diagnostics.peerConnectionState = pc.connectionState;
      if (pc.connectionState === 'connected') {
        if (mediaStarted) clearConnectionWatchdog();
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
        setProgressMilestone(88, 94);
        inspectSelectedIceCandidatePair();
      } else if (pc.connectionState === 'failed') {
        if (tryRelayFallback('Peer connection failed')) return;
        setUIState('CONNECTION_FAILED');
        scheduleReconnect();
      } else if (pc.connectionState === 'disconnected') {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = setTimeout(() => {
          if (pc && pc.connectionState === 'disconnected') {
            if (tryRelayFallback('Direct connection disconnected')) return;
            setUIState('CONNECTION_FAILED', 'The local video connection was interrupted. Reconnecting...', true);
            scheduleReconnect();
          }
        }, 5000);
      }
      renderDiagnostics();
    };

    pc.createOffer().then(offer => {
      if (pc !== peer) return;
      return peer.setLocalDescription(offer).then(() => {
        if (pc !== peer) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
          setProgressMilestone(55, 63);
          ws.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            type: 'offer',
            sessionId: sessionId,
            messageId: 'offer_' + Date.now(),
            timestamp: Date.now(),
            sdp: offer.sdp,
            viewport: browserViewport()
          }));
        }
      });
    }).catch(error => {
      if (pc !== peer) return;
      if (tryRelayFallback('Offer failed: ' + error.message)) return;
      setUIState('CONNECTION_FAILED');
      scheduleReconnect();
    });
  }

  function recoveryFieldMetrics() {
    return {browserBuild:diagnostics.diagnosticsBuildId,layout:videoLayout,path:splitSelected?'secure-split-media':'secure-relay',consuming:state==='CONNECTED',
      video:Object.fromEntries(["lastReceivedIdrSourceUs","lastPresentedSourceUs","lastFrameReceivedAt", "lastFrameDecodedAt", "lastFramePresentedAt", "presentationRecoveries", "presentationSurfaceErrors", "DIRECT_REQUESTED", "DIRECT_ATTEMPT_STARTED", "DIRECT_ICE_STATE", "DIRECT_FAILURE_REASON", "DIRECT_TIMEOUT", "FALLBACK_TO_RELAY_REASON", "FINAL_TRANSPORT", "presentedFrames", "framesDecoded", "firstFrameMs", "frameAgeMs", "pendingVideoFrames", "videoQueueBytes", "decodeQueueSize", "staleVideoDrops", "recoveryRequests", "relayStalls", "signalingReconnects", "connectionAttempts", "frameAgeSamples", "frameAgeP50Ms", "frameAgeP95Ms", "frameAgeP99Ms", "referenceRecoveryFailed", "DIRECT_LOCAL_HOST", "DIRECT_LOCAL_MDNS", "DIRECT_LOCAL_SRFLX", "DIRECT_LOCAL_RELAY", "DIRECT_REMOTE_HOST", "DIRECT_REMOTE_MDNS", "DIRECT_PAIRS_TOTAL", "DIRECT_PAIRS_FAILED", "latePresentations", "retirementsDeferred", "transitAgeMs", "presentLatest","fastRejoins"].filter(k=>Number.isFinite(diagnostics[k])).map(k=>[k,diagnostics[k]]))};
  }
  function requestVideoRefresh() {
    diagnostics.recoveryRequests++;
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'request_keyframe' }));
    else if (useRelay && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
      version: PROTOCOL_VERSION, type: 'request_keyframe', sessionId, timestamp: Date.now(), messageId: 'refresh_' + Date.now(), fieldMetrics:recoveryFieldMetrics()
    }));
  }

  function startMediaHealthChecks(peer) {
    clearInterval(mediaHealthTimer);
    let checking = false;
    let lastFrames = 0;
    let lastBytes = 0;
    let decodedAt = Date.now();
    let receivedAt = 0;
    let requestedAt = 0;
    let stalledSince = 0;
    let lastPresented = null;
    let presentedAt = Date.now();
    renderedFrameAt = presentedAt;
    const generation = ++renderGeneration;
    if (renderedCallback !== null) remoteVideo.cancelVideoFrameCallback?.(renderedCallback);
    const observeRender = () => {
      if (pc !== peer || generation !== renderGeneration) return;
      renderedFrameAt = Date.now();
      if (optionalFeatures) lastPresentedMonotonicMs = performance.now();
      renderedCallback = remoteVideo.requestVideoFrameCallback(observeRender);
    };
    if (remoteVideo.requestVideoFrameCallback) renderedCallback = remoteVideo.requestVideoFrameCallback(observeRender);
    mediaHealthTimer = setInterval(async () => {
      if (checking || pc !== peer || !mediaStarted) return;
      checking = true;
      try {
        const stats = await peer.getStats();
        if (pc !== peer) return;
        let video;
        stats.forEach(stat => {
          if (stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) video = stat;
        });
        if (!video || typeof video.framesDecoded !== 'number') return;
        const now = Date.now();
        if (document.hidden) { decodedAt = presentedAt = now; stalledSince = 0; return; }
        if (video.framesDecoded !== lastFrames) decodedAt = now;
        if (video.bytesReceived !== lastBytes) receivedAt = now;
        lastFrames = video.framesDecoded;
        lastBytes = video.bytesReceived;
        diagnostics.framesDecoded = lastFrames;
        diagnostics.framesDropped = video.framesDropped || 0;
        diagnostics.videoQuietMs = now - decodedAt;
        // Decoding can continue while the video element stops presenting. Include
        // presentation health so this case does not require a page refresh.
        const quality = remoteVideo.getVideoPlaybackQuality?.();
        if (dockVideo?.paused && !dockVideo.hidden) dockVideo.play().catch(() => {});
        const presented = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : null;
        if (presented !== null && presented !== lastPresented) presentedAt = now;
        lastPresented = presented;
        if (remoteVideo.requestVideoFrameCallback) presentedAt = renderedFrameAt;
        const progressAt = remoteVideo.requestVideoFrameCallback ? presentedAt : (presented === null ? decodedAt : Math.min(decodedAt, presentedAt));
        diagnostics.presentationQuietMs = presented === null ? null : now - presentedAt;
        const sourceMoving = (receivedAt > 0 && now - receivedAt < 3000) ||
          (phoneProgressAt > 0 && now - phoneProgressAt < 3000);
        if (!sourceMoving || now - progressAt <= 2000) stalledSince = 0;
        else if (!stalledSince) stalledSince = now;
        if (sourceMoving && now - progressAt > 2000 && now - requestedAt > 1000) {
          requestedAt = now;
          requestVideoRefresh();
          remoteVideo.play().catch(() => {});
        }
        // A live AA source with no arriving RTP is a sender/transport stall,
        // not a static map or a video-element presentation stall. Give the
        // lightweight refresh time to work, then replace only the media path.
        if (stalledSince && now - stalledSince >= 6000 &&
            receivedAt > 0 && now - receivedAt >= 8000 && now - decodedAt >= 8000 &&
            phoneProgressAt > 0 && now - phoneProgressAt < 3000) {
          if (tryRelayFallback('Android Auto is producing frames but direct video stopped arriving')) return;
        }
        // Keyframe recovery preserves PeerConnection and decoder state.
        renderDiagnostics();
      } catch (_) {} finally { checking = false; }
    }, 1000);
  }

  // 4. Selected ICE Candidate Pair Classification
  async function inspectSelectedIceCandidatePair() {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let activePair = null;

      stats.forEach(stat => {
        if (stat.type === 'candidate-pair' && (stat.state === 'succeeded' || stat.nominated)) {
          activePair = stat;
        }
      });

      if (activePair) {
        const localCand = stats.get(activePair.localCandidateId) || {};
        const remoteCand = stats.get(activePair.remoteCandidateId) || {};

        diagnostics.localCandidateType = localCand.candidateType || 'unknown';
        diagnostics.remoteCandidateType = remoteCand.candidateType || 'unknown';
        diagnostics.localCandidateAddress = localCand.address || localCand.ip || 'masked';
        diagnostics.remoteCandidateAddress = remoteCand.address || remoteCand.ip || 'masked';
        diagnostics.protocol = activePair.protocol || 'udp';
        diagnostics.candidatePairRttMs = activePair.currentRoundTripTime ? Math.round(activePair.currentRoundTripTime * 1000) : null;

        if (diagnostics.localCandidateType === 'host' && diagnostics.remoteCandidateType === 'host') {
          diagnostics.connectionPath = 'local-direct';
        } else if (diagnostics.localCandidateType !== 'relay' && diagnostics.remoteCandidateType !== 'relay') {
          diagnostics.connectionPath = 'srflx-direct';
        } else if (diagnostics.localCandidateType === 'relay' || diagnostics.remoteCandidateType === 'relay') {
          diagnostics.connectionPath = 'relay';
        } else {
          diagnostics.connectionPath = 'unknown';
        }

        if (state === 'CONNECTED') {
          statusText.textContent = diagnostics.connectionPath === 'local-direct' ? 'Connected • Local Hotspot' : 'Connected';
        }
      }
    } catch (_) {}
    renderDiagnostics();
  }

  // 5. Touch DataChannel Integration (`tesla-touch`)
  function sendTouch(action, p) {
    const payload = { seq: ++seq, action: action, x: p.x, y: p.y };
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(payload));
      return true;
    }
    if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
      ws.send(JSON.stringify(Object.assign({
        version: PROTOCOL_VERSION,
        type: 'relay_touch',
        sessionId: sessionId,
        messageId: 'touch_' + Date.now(),
        timestamp: Date.now()
      }, payload)));
      return true;
    }
    return false;
  }

  function getTouchPoint(e) {
    const target = relayCanvas && !relayCanvas.hidden ? relayCanvas : remoteVideo;
    const r = streamContainer?.getBoundingClientRect?.();
    const sourceWidth = target === relayCanvas ? relayCanvas.width : remoteVideo.videoWidth;
    const sourceHeight = target === relayCanvas ? relayCanvas.height : remoteVideo.videoHeight;
    if (!sourceWidth || !sourceHeight || !r?.width || !r.height) return null;

    const g = presentationGeometry(r, sourceWidth, sourceHeight);
    const x = (e.clientX - r.left - g.left) / g.width;
    const localY = e.clientY - r.top;
    let y;
    if (nativeScene()) {
      y=(localY-g.top)/g.frameHeight;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x<0 || x>1 || y<0 || y>1) return null;
      return {x,y};
    }
    if (localY >= g.top && localY <= g.top + g.contentHeight) {
      y = (localY - g.top) / g.contentHeight * (1 - dockShare());
    } else if (localY >= r.height - g.dockHeight && localY <= r.height) {
      y = 1 - dockShare() + (localY - r.height + g.dockHeight) / g.dockHeight * dockShare();
    } else return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  function presentationGeometry(r, width, height) {
    if (videoLayout) { width = videoLayout.visibleWidth; height = videoLayout.visibleHeight; }
    const scale = Math.min(r.width / width, r.height / height);
    const frameHeight = height * scale;
    const dockHeight = nativeScene() ? 0 : frameHeight * dockShare();
    return { width: width * scale, left: (r.width - width * scale) / 2,
      top: (r.height - frameHeight) / 2, frameHeight, dockHeight, contentHeight: frameHeight - dockHeight };
  }

  function updatePresentationLayout() {
    const r = streamContainer?.getBoundingClientRect?.();
    if (!r?.width || !r.height) return;
    const relay = relayCanvas && !relayCanvas.hidden;
    const width = (relay ? relayCanvas.width : remoteVideo.videoWidth) || 1280;
    const height = (relay ? relayCanvas.height : remoteVideo.videoHeight) || 720;
    const g = presentationGeometry(r, width, height);
    streamContainer.classList.toggle('native-scene',nativeScene());
    streamContainer.style.setProperty('--frame-left',g.left+'px');
    streamContainer.style.setProperty('--source-left', (videoLayout ? -videoLayout.left*g.width/videoLayout.visibleWidth : 0)+'px');
    streamContainer.style.setProperty('--source-top', (videoLayout ? -videoLayout.top*g.frameHeight/videoLayout.visibleHeight : 0)+'px');
    streamContainer.style.setProperty('--source-height',(videoLayout ? videoLayout.height*g.frameHeight/videoLayout.visibleHeight : g.frameHeight)+'px');
    streamContainer.style.setProperty('--dock-height', g.dockHeight + 'px');
    streamContainer.style.setProperty('--content-height', g.contentHeight + 'px');
    streamContainer.style.setProperty('--content-top', g.top + 'px');
    streamContainer.style.setProperty('--frame-width', g.width + 'px');
    streamContainer.style.setProperty('--video-frame-width', (videoLayout ? g.width * videoLayout.width / videoLayout.visibleWidth : g.width) + 'px');
    streamContainer.style.setProperty('--content-frame-height', g.frameHeight + 'px');
    streamContainer.style.setProperty('--dock-frame-height', g.frameHeight + 'px');
  }
  remoteVideo.addEventListener('loadedmetadata', updatePresentationLayout);
  remoteVideo.addEventListener('resize', updatePresentationLayout);
  window.addEventListener('resize', updatePresentationLayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updatePresentationLayout);
  updatePresentationLayout();


  function concatBytes(parts) {
    const size = parts.reduce((total, part) => total + part.byteLength, 0);
    const joined = new Uint8Array(size);
    let offset = 0;
    parts.forEach(part => { joined.set(part, offset); offset += part.byteLength; });
    return joined;
  }

  function ensureRelayDecoder() {
    if (relayDecoder || relayDecoderFailed || !window.VideoDecoder || !relayContext) return !!relayDecoder;
    try {
      const generation = ++relayDecoderGeneration;
      relayDecoderStartedAt = Date.now();
      // One bounded phase per startup/recovery episode. Replayed keys and
      // decoder retirement do not extend it; healthy steady output rearms it.
      if (rawReferenceDeadline === null) rawReferenceDeadline = rawNow() + RAW_REFERENCE_BOOTSTRAP_MS;
      relayDecoder = new VideoDecoder({
        output: frame => {
          const presentedSourceUs = frame.timestamp;
          if (generation !== relayDecoderGeneration) { frame.close(); return; }
          lastDecodedFrameAt = Date.now();
          diagnostics.lastFrameDecodedAt = rawNow();
          diagnostics.framesDecoded = (diagnostics.framesDecoded || 0) + 1;
          decodedSincePresentation++;
          // Output order need not match submission order (H264 picture reordering).
          const match = relayInFlight.findIndex(unit => unit.timestamp === frame.timestamp);
          const pending = relayInFlight.splice(match >= 0 ? match : 0, 1)[0];
          if (splitSelected && pending?.timestamp > diagnostics.splitRecoverySourceBaselineUs && !diagnostics.splitFirstSourceNewDecodedAt)
            diagnostics.splitFirstSourceNewDecodedAt = rawNow();
          const pictureAge = pending ? Math.max(rawFrameAge(pending),
            pending.timestamp > 0 ? (rawLastTimestamp - pending.timestamp) / 1000 : 0) : 0;
          // Already-decoded pictures may be skipped without losing references.
          // V60: skip a late picture only while a newer one can replace it or the
          // screen was refreshed within MAX_PRESENTATION_GAP_MS; never freeze on
          // the newest decoded picture because it is late.
          const newerPending = relayInFlight.length > 0 || relayInputQueue.length > 0;
          const presentationGap = Date.now() - (lastPresentedFrameAt || relayDecoderStartedAt);
          if (pictureAge > LIVE_VIDEO_BUDGET_MS && (!PRESENT_LATEST || (newerPending && presentationGap < MAX_PRESENTATION_GAP_MS))) {
            frame.close();
            diagnostics.staleVideoDrops = (diagnostics.staleVideoDrops || 0) + 1;
            pumpRelayDecoder();
            return;
          }
          if (pictureAge > LIVE_VIDEO_BUDGET_MS) diagnostics.latePresentations = (diagnostics.latePresentations || 0) + 1;
          diagnostics.frameAgeMs = pictureAge;

          const layout = videoLayout && videoLayout.width === frame.displayWidth && videoLayout.height === frame.displayHeight ? videoLayout : null;
          const visibleWidth = layout ? layout.visibleWidth : frame.displayWidth;
          const visibleHeight = layout ? layout.visibleHeight : frame.displayHeight;
          const cropLeft = layout ? layout.left : 0;
          const sizeChanged = relayCanvas.width !== visibleWidth || relayCanvas.height !== visibleHeight;
          if (sizeChanged) {
            relayCanvas.width = visibleWidth;
            relayCanvas.height = visibleHeight;
          }
          try {
          relayContext.drawImage(frame, cropLeft, layout ? layout.top : 0, visibleWidth, visibleHeight, 0, 0, visibleWidth, visibleHeight);
          if (relayDockContext && !nativeScene()) {
            const dockPixels = layout ? layout.dockHeight : Math.round(frame.displayHeight * DOCK_SHARE);
            if (relayDockCanvas.width !== visibleWidth || relayDockCanvas.height !== dockPixels) {
              relayDockCanvas.width = visibleWidth;
              relayDockCanvas.height = dockPixels;
            }
            relayDockContext.drawImage(frame, cropLeft, visibleHeight - dockPixels,
              visibleWidth, dockPixels, 0, 0, visibleWidth, dockPixels);
          }
          } catch (_) {
            diagnostics.presentationSurfaceErrors = (diagnostics.presentationSurfaceErrors || 0) + 1;
            recoverPresentation();
            return;
          } finally { frame.close(); }
          remoteVideo.hidden = true;
          if (dockVideo) dockVideo.hidden = true;
          if (relayDockCanvas) relayDockCanvas.hidden = false;
          const layoutChanged = relayCanvas.hidden;
          relayCanvas.hidden = false;
          if (layoutChanged || sizeChanged) updatePresentationLayout();
          if (!mediaStarted) diagnostics.firstFrameMs = Date.now() - connectionStartedAt;
          mediaStarted = true;
          diagnostics.connectionPath = splitSelected ? 'secure-split-media' : useRelay ? 'secure-relay' : 'local-raw';
          diagnostics.FINAL_TRANSPORT = useRelay ? 2 : 1;
          diagnostics.protocol = useRelay ? 'wss' : 'sctp';
          if (splitSelected && pending?.timestamp > diagnostics.splitRecoverySourceBaselineUs && !diagnostics.splitFirstSourceNewPresentedAt)
            diagnostics.splitFirstSourceNewPresentedAt = rawNow();
          diagnostics.presentedFrames++;
          diagnostics.lastPresentedSourceUs = presentedSourceUs;
          rawFailedReferenceNotified = false; diagnostics.referenceRecoveryFailed = 0;
          // Only actual fresh presentation completes a steady-state catch-up.
          // Startup keeps its original grace; stale output never rearms either.
          if (rawReferenceDeadline !== null && (rawReferenceCatchup || rawNow() >= rawReferenceDeadline)) {
            rawReferenceDeadline = null; rawReferenceCatchup = false;
          }
          decodedSincePresentation = 0;
          diagnostics.lastFramePresentedAt = rawNow();
          recordFrameAge(diagnostics.frameAgeMs || 0);
          relayDecoderPresented = true;
          lastPresentedFrameAt = Date.now();
          if (optionalFeatures) lastPresentedMonotonicMs = performance.now();
          setProgressMilestone(100);
          connectAttempt = 0;
          clearConnectionWatchdog();
          if (state !== 'CONNECTED') setUIState('CONNECTED');
          updateRawQueueDiagnostics();
          pumpRelayDecoder();
        },
        error: failRelayDecoder
      });
      relayDecoder.ondequeue = pumpRelayDecoder;
      relayDecoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      return true;
    } catch (error) {
      failRelayDecoder(error);
      return false;
    }
  }

  function updateRawQueueDiagnostics() {
    diagnostics.pendingVideoFrames = relayInputQueue.length + relayInFlight.length;
    diagnostics.videoQueueBytes = relayInputBytes;
    diagnostics.decodeQueueSize = relayDecoder?.decodeQueueSize || 0;
  }

  function recoverPresentation() {
    const now = Date.now();
    if (document.hidden || (presentationRecoveryAt && now - presentationRecoveryAt < 2000)) return;
    presentationRecoveryAt = now;
    diagnostics.presentationRecoveries = (diagnostics.presentationRecoveries || 0) + 1;
    diagnostics.lastRecoveryReason = 'Decoded pictures are not reaching presentation';
    // Retire only this decoder's work; keep AA, pairing and media transport alive.
    clearRawDecoderWork();
    rawReferenceDeadline = rawNow() + RAW_REFERENCE_BOOTSTRAP_MS;
    relayRefreshAt = now;
    requestVideoRefresh();
  }

  function clearRawDecoderWork() {
    ++relayDecoderGeneration;
    if (relayDecoder) { try { relayDecoder.close(); } catch (_) {} }
    relayDecoder = null;
    relayInputQueue = [];
    relayInputBytes = 0;
    relayInFlight = [];
    relayHasKeyframe = false;
    rawReferenceCatchup = false;
    relayDecoderPresented = false;
    decodedSincePresentation = 0;
    rawDecodeLastTimestamp = 0;
    updateRawQueueDiagnostics();
  }

  function refreshAllowed(cooldownMs = 5000) {
    return !relayRefreshAt || Date.now() - relayRefreshAt >= cooldownMs;
  }

  function recoverRawVideo(reason, resetDecoder = false, newReferenceEpisode = false, cooldownMs = 5000) {
    const now = Date.now();
    // One replay per recovery episode, with time for its reference chain to decode.
    // A blocked request never resets the decoder (V60: reset + request are one step).
    if (!refreshAllowed(cooldownMs)) return false;
    relayRefreshAt = now;
    // A later, paced recovery is a new bounded episode. Repeated keys and
    // calls during the cooldown cannot extend the previous episode's deadline.
    if (newReferenceEpisode) { rawReferenceCatchup = false; rawReferenceDeadline = newReferenceEpisode === 'immediate' ? rawNow() + RAW_REFERENCE_BOOTSTRAP_MS : null; }
    diagnostics.relayStalls++;
    diagnostics.lastRecoveryReason = reason;
    if (resetDecoder) clearRawDecoderWork();
    requestVideoRefresh();
    renderDiagnostics();
    return true;
  }

  function pumpRelayDecoder() {
    if (relayPumping || !relayDecoder || relayDecoderFailed) return;
    relayPumping = true;
    try {
      while (relayInputQueue.length && relayInFlight.length < MAX_DECODE_IN_FLIGHT &&
          relayDecoder.decodeQueueSize < MAX_DECODE_IN_FLIGHT) {
        // V60: late queued pictures keep their reference chain and decode; only
        // their display is skipped. A backlog this far behind is retired with
        // its keyframe request, or kept decoding when the request is blocked.
        if (!bootstrappingReferences() && rawFrameAge(relayInputQueue[0]) > LIVE_BACKLOG_LIMIT_MS &&
            collapseStaleVideo('Decode exceeded live video budget')) break;
        const unit = relayInputQueue.shift();
        relayInputBytes -= unit.data.byteLength;
        const pending = { since: Date.now(), arrivedAt: unit.arrivedAt, timestamp: unit.timestamp, transitAgeMs: unit.transitAgeMs };
        relayInFlight.push(pending);
        try {
          relayDecoder.decode(new EncodedVideoChunk(unit));
          diagnostics.decoderSubmissions = (diagnostics.decoderSubmissions || 0) + 1;
        } catch (_) {
          // A missing reference requires a new IDR chain, not a new peer/session.
          // The rejecting decoder is unusable, so its request uses a short cooldown.
          clearRawDecoderWork();
          recoverRawVideo('Video decode rejected an access unit', false, false, 1000);
          break;
        }
      }
    } finally {
      relayPumping = false;
      updateRawQueueDiagnostics();
    }
  }

  function failRelayDecoder(error) {
    diagnostics.relayDecoderError = String(error && error.message || error);
    relayDecoderFailed = true;
    relayHasKeyframe = false;
    if (relayDecoder) { try { relayDecoder.close(); } catch (_) {} }
    relayDecoder = null;
    clearConnectionWatchdog();
    setUIState('CONNECTION_FAILED', 'This browser could not decode Android Auto video. Please update the vehicle browser and reload.', true);
  }

  function handleRawFragment(payload) {
    if (!USE_RAW_VIDEO || useRelay || !(payload instanceof ArrayBuffer)) return;
    const p = new Uint8Array(payload);
    if (p.length < 25 || p[0] !== 75 || p[1] !== 67 || p[2] !== 2) return;
    const v = new DataView(payload);
    const id = v.getUint32(4), part = v.getUint16(8), count = v.getUint16(10), size = v.getUint32(20);
    if (!size || size > 2 * 1024 * 1024 || !count || count > 132 || part >= count) return;
    if (part === 0) {
      rawFrame = { id, count, size, next: 0, offset: 12, bytes: new Uint8Array(12 + size) };
      rawFrame.bytes.set([75, 67, 1, p[3]]);
      rawFrame.bytes.set(p.subarray(12, 20), 4);
    }
    if (!rawFrame || rawFrame.id !== id || rawFrame.count !== count || rawFrame.size !== size || rawFrame.next !== part ||
        rawFrame.offset + p.length - 24 > rawFrame.bytes.length) { rawFrame = null; recoverRawVideo('Incomplete video access unit', true); return; }
    rawFrame.bytes.set(p.subarray(24), rawFrame.offset);
    rawFrame.offset += p.length - 24; rawFrame.next++;
    if (rawFrame.next === count) {
      const frame = rawFrame; rawFrame = null;
      if (frame.offset === frame.bytes.length) handleRelayFrame(frame.bytes.buffer, true);
      else recoverRawVideo('Incomplete video access unit', true);
    }
  }

  function handleRelayFrame(payload, raw = false) {
    if (!useRelay && !raw) return;
    const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : null;
    if (!bytes || bytes.byteLength < 13 || bytes[0] !== 75 || bytes[1] !== 67 || bytes[2] !== 1) return;
    const flags = bytes[3];
    const data = bytes.slice(12);
    if (flags & 4) {
      if (data.length <= 512) try { applyVideoLayout(JSON.parse(String.fromCharCode(...data))); } catch (_) {}
      return;
    }
    if (flags & 1) {
      relayConfig = [data];
      return;
    }
    const key = (flags & 2) !== 0;
    diagnostics.receivedVideoFrames = (diagnostics.receivedVideoFrames || 0) + 1;
    // Layout/SPS/PPS and phone heartbeats are not pending video pictures.
    const sourceWasQuiet = rawSourceReceivedAt && Date.now() - rawSourceReceivedAt > 2000 &&
      !relayInputQueue.length && !relayInFlight.length;
    relayReceivedAt = Date.now();
    diagnostics.lastFrameReceivedAt = rawNow();
    noteExpiredReferenceRecovery();
    rawMissingSince = 0;
    rawSourceBaseline = phoneSourceFrames;
    const view = new DataView(bytes.buffer, bytes.byteOffset + 4, 8);
    const timestamp = view.getUint32(0) * 4294967296 + view.getUint32(4);
    const arrivedAt = rawNow();
    const previousTimestamp = rawLastTimestamp;
    // Receiving a current picture advances freshness knowledge even if its
    // references are missing. Old recovery pictures cannot erase that knowledge
    // or relearn the source clock from a historical cache replay.
    if (timestamp > rawLastTimestamp) {
      if (sourceWasQuiet) { rawTransitFloor = null; resetTransitWindow(); }
      rawSourceReceivedAt = Date.now();
      rawLastTimestamp = timestamp;
      const transit = arrivedAt - timestamp / 1000;
      // V60: windowed minimum, so a lasting path-delay rise re-baselines.
      rawTransitFloor = PRESENT_LATEST ? observeTransit(transit, arrivedAt) :
        rawTransitFloor === null ? transit : Math.min(rawTransitFloor, transit);
    }
    const transitAgeMs = rawTransitFloor === null || timestamp <= 0 ? 0 : Math.max(0, arrivedAt - timestamp / 1000 - rawTransitFloor);
    diagnostics.sourceTimestampDeltaMs = previousTimestamp > 0 ? (timestamp - previousTimestamp) / 1000 : 0;
    diagnostics.transitAgeMs = transitAgeMs;
    diagnostics.sourceTimestampUs = timestamp;
    if (key) diagnostics.lastReceivedIdrSourceUs = timestamp;
    diagnostics.latestSourceTimestampUs = rawLastTimestamp;
    if (!relayHasKeyframe && !key) return;
    if (!ensureRelayDecoder()) return;
    let accessUnit = data;
    if (key && relayConfig.length) accessUnit = concatBytes(relayConfig.concat([data]));
    // A refresh may replay a cached GOP alongside the live stream. Pictures
    // already received are duplicates, not evidence of new transport backlog.
    // Keep the active reference chain; retirement still requires a fresh IDR.
    if (relayHasKeyframe && timestamp > 0 && timestamp <= rawDecodeLastTimestamp) {
      diagnostics.replayedVideoDrops = (diagnostics.replayedVideoDrops || 0) + 1;
      return;
    }
    const incoming = { type: key ? 'key' : 'delta', timestamp, data: accessUnit, arrivedAt, transitAgeMs };
    // A short transport-age spike is not a missing reference. Preserve the
    // healthy decoder for one fixed, bounded reference catch-up episode rather
    // than replay its entire historical GOP. Outputs still obey 250ms, and an
    // expired episode cannot be renewed until fresh presentation succeeds.
    const incomingAge = rawFrameAge(incoming);
    if (rawReferenceDeadline === null && relayHasKeyframe &&
        relayInFlight.length <= MAX_DECODE_IN_FLIGHT &&
        lastDecodedFrameAt && Date.now() - lastDecodedFrameAt <= 1000 &&
        incomingAge > LIVE_VIDEO_BUDGET_MS && incomingAge <= RAW_REFERENCE_BOOTSTRAP_MS) {
      rawReferenceDeadline = rawNow() + RAW_REFERENCE_BOOTSTRAP_MS;
      rawReferenceCatchup = true;
    }
    // V60: pictures later than 250ms keep decoding (display skips them while
    // newer ones exist). Only a backlog beyond LIVE_BACKLOG_LIMIT_MS is retired,
    // and only together with its keyframe request.
    if (!bootstrappingReferences() &&
        ((relayInputQueue.length && rawFrameAge(relayInputQueue[0]) > LIVE_BACKLOG_LIMIT_MS) ||
        (relayInFlight.length && rawFrameAge(relayInFlight[0]) > LIVE_BACKLOG_LIMIT_MS)) &&
        collapseStaleVideo('Queued video exceeded live video budget')) {
      if (!key) return;
      if (!ensureRelayDecoder()) return;
    }
    if (!bootstrappingReferences() && timestamp > 0 && rawFrameAge(incoming) > LIVE_BACKLOG_LIMIT_MS &&
        collapseStaleVideo('Transport exceeded live video budget')) {
      diagnostics.staleVideoDrops = (diagnostics.staleVideoDrops || 0) + 1;
      return;
    }
    // A fresh cached GOP may continue arriving after the first decoder output.
    // Preserve its reference chain: bound queued work by bytes / frames and the
    // 250ms freshness deadline. pumpRelayDecoder still caps in-flight work at 8.
    if (relayInputBytes + accessUnit.byteLength > MAX_VIDEO_QUEUE_BYTES ||
        relayInputQueue.length >= MAX_VIDEO_QUEUE_FRAMES) {
      recoverRawVideo('Video decode queue exceeded its limit', true);
      return;
    }
    if (key) relayHasKeyframe = true;
    if (timestamp > 0) rawDecodeLastTimestamp = Math.max(rawDecodeLastTimestamp, timestamp);
    relayInputQueue.push(incoming);
    relayInputBytes += accessUnit.byteLength;
    pumpRelayDecoder();
  }

  function handleCancelTouch() {
    if (pressedPointer !== null) {
      sendTouch('cancel', lastPoint);
      pressedPointer = null;
    }
  }

  function bindTouchTarget(target) {
    if (!target) return;
    target.onpointerdown = (e) => {
      if (pressedPointer !== null || e.button !== 0) return;
      const p = getTouchPoint(e);
      if (!p) return;
      e.preventDefault();
      lastPoint = p;
      if (sendTouch('down', p)) {
        pressedPointer = e.pointerId;
        target.setPointerCapture(e.pointerId);
      }
    };
    target.onpointermove = (e) => {
      if (e.pointerId !== pressedPointer) return;
      e.preventDefault();
      lastPoint = getTouchPoint(e) || lastPoint;
      sendTouch('move', lastPoint);
    };
    target.onpointerup = (e) => {
      if (e.pointerId !== pressedPointer) return;
      e.preventDefault();
      lastPoint = getTouchPoint(e) || lastPoint;
      sendTouch('up', lastPoint);
      pressedPointer = null;
    };
    target.onpointercancel = target.onlostpointercapture = handleCancelTouch;
  }
  bindTouchTarget(remoteVideo);
  bindTouchTarget(relayCanvas);
  bindTouchTarget(dockVideo);
  bindTouchTarget(relayDockCanvas);
  // V60: a frozen picture is labelled instead of looking live. Shown only while
  // video is expected (pictures or phone progress arriving) but none is drawn;
  // a static Android Auto screen sends no pictures and shows no label.
  let stallOverlay = null;
  function updateStallOverlay(now) {
    // Expected = something newer than the last drawn picture arrived recently.
    const expected = (relayReceivedAt > lastPresentedFrameAt && now - relayReceivedAt < 5000) ||
      (phoneProgressAt > lastPresentedFrameAt && now - phoneProgressAt < 5000);
    const show = !!(state === 'CONNECTED' && !document.hidden && lastPresentedFrameAt > 0 && now - lastPresentedFrameAt > 2500 && expected);
    diagnostics.stallOverlayShown = show ? 1 : 0;
    if (!show && !stallOverlay) return;
    if (!stallOverlay && document.createElement && document.body) {
      stallOverlay = document.createElement('div');
      stallOverlay.setAttribute('role', 'status');
      stallOverlay.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:50;padding:8px 14px;border-radius:16px;background:rgba(10,14,20,.82);color:#fff;font:14px system-ui,sans-serif;pointer-events:none';
      stallOverlay.textContent = 'Video paused — reconnecting…';
      document.body.appendChild(stallOverlay);
    }
    if (stallOverlay) stallOverlay.hidden = !show;
  }
  // V61: reconnect the moment the device reports its network is back.
  window.addEventListener('online', () => {
    if (ws && ws.readyState === 1 && lastServerMessageAt && Date.now() - lastServerMessageAt < 3000) return;
    if (pairToken || /^\d{6}$/.test(pairingCode)) fastRejoin('network online');
  });
  setInterval(() => {
    checkSignalingLiveness(Date.now());
    updateStallOverlay(Date.now());
    if (state !== 'CONNECTED' || !['secure-relay', 'secure-split-media', 'local-raw'].includes(diagnostics.connectionPath) || !lastPresentedFrameAt) return;
    // AA may legitimately stop producing frames on an unchanged screen.
    // A stalled decoder has pending work; silence alone is not a transport failure.
    const now = Date.now();
    if (document.hidden) {
      relayInFlight.forEach(unit => { unit.since = now; });
      rawMissingSince = 0;
      rawSourceBaseline = phoneSourceFrames;
      rawPresentationStallAt = 0;
      rawPresentationSourceBaseline = phoneSourceFrames;
      return;
    }
    updateRawQueueDiagnostics();
    // Cached reference outputs are deliberately not displayed. Let the existing
    // bounded two-second episode reach live continuation before retiring it.
    // Otherwise the watchdog interrupts valid priming at 1.5s and requests the
    // same historical GOP again, adding transport work instead of healing it.
    if (!bootstrappingReferences() && decodedSincePresentation >= 2 && lastDecodedFrameAt > lastPresentedFrameAt && now - lastDecodedFrameAt <= 1500 &&
        now - lastPresentedFrameAt >= 1500) {
      recoverPresentation();
      return;
    }
    // Replayed packets can keep arriving while every picture is too old to
    // display. Give bounded reference recovery time, then use the existing
    // relay fallback when independent AA status proves the source is moving.
    // Packet arrival must not reset this presentation deadline.
    const directPresentationStarved = !useRelay && diagnostics.connectionPath === 'local-raw' &&
      now - lastPresentedFrameAt > 2000 && phoneProgressAt > 0 && now - phoneProgressAt <= 3000;
    if (!directPresentationStarved || phoneSourceFrames < rawPresentationSourceBaseline) {
      rawPresentationStallAt = 0;
      rawPresentationSourceBaseline = phoneSourceFrames;
    } else if (!rawPresentationStallAt) {
      rawPresentationStallAt = now;
      rawPresentationSourceBaseline = phoneSourceFrames;
    } else if (now - rawPresentationStallAt >= 8000 &&
        relayReceivedAt > 0 && now - relayReceivedAt <= 3000 &&
        phoneSourceFrames - rawPresentationSourceBaseline >= 3) {
      if (tryRelayFallback('Android Auto is advancing but DIRECT cannot present current reference pictures')) return;
    }
    // Start the deadline when undecoded work arrives, not at the last static image.
    // A freshly submitted frame after a minute of silence still gets 2s to render.
    if (relayInFlight.length && now - relayInFlight[0].since > 2000 &&
        now - lastPresentedFrameAt > 2000) {
      recoverRawVideo('Pending video stopped rendering', true);
    }
    // Receiving dependent pictures is not decoder progress after retirement.
    // Ask for a complete reference chain even while those unusable deltas arrive.
    if (!relayHasKeyframe && relayReceivedAt && now - relayReceivedAt <= 3000 &&
        now - lastPresentedFrameAt > 2000) {
      recoverRawVideo('Video awaiting a decodable reference chain', true, true);
    }
    // Phone progress alone is not a decoder stall. Require a sustained absence
    // of access units AND multiple new source frames before a transport refresh.
    if (now - relayReceivedAt <= 3000 || now - phoneProgressAt > 3000) {
      rawMissingSince = 0;
      rawSourceBaseline = phoneSourceFrames;
    } else if (!rawMissingSince) {
      rawMissingSince = now;
      rawSourceBaseline = phoneSourceFrames;
    } else if (now - rawMissingSince >= 8000 && phoneSourceFrames - rawSourceBaseline >= 3) {
      recoverRawVideo('Phone video is advancing but no access units arrive');
    }
    renderDiagnostics();
  }, 1000);
  window.addEventListener('blur', handleCancelTouch);

  // 6. Diagnostics Mode (?metrics=1)
  function renderDiagnostics() {
    if (!SHOW_METRICS) return;
    metricsPanel.hidden = false;
    metricsPanel.textContent = 'KarCast Vehicle Client Diagnostics (?metrics=1)\n' + JSON.stringify(diagnostics, null, 2);
  }

  // 7. Cleanup
  function stopSplitMedia() { if (splitClient) { splitClient.stop(); splitClient = null; clearRawDecoderWork(); } }

  function cleanupWebRTC() {
    stopSplitMedia();
    optionalFeature('detach');
    videoLayout = null;
    updatePresentationLayout();
    rawFrame = null;
    if (videoChannel) { videoChannel.onclose = videoChannel.onmessage = null; try { videoChannel.close(); } catch (_) {} videoChannel = null; }
    ++renderGeneration;
    if (renderedCallback !== null) remoteVideo.cancelVideoFrameCallback?.(renderedCallback);
    renderedCallback = null;
    renderedFrameAt = 0;
    clearTimeout(transportFallbackTimer);
    transportFallbackTimer = null;
    handleCancelTouch();
    clearInterval(firstFrameTimer);
    firstFrameTimer = null;
    pendingCandidates = [];
    clearInterval(mediaHealthTimer);
    mediaHealthTimer = null;
    phoneProgressAt = phoneSourceFrames = phoneStatusAt = 0;
    clearConnectionWatchdog();
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
    mediaStarted = false;
    clearRawDecoderWork();
    relayDecoderFailed = false;
    relayConfig = [];
    relayHasKeyframe = false;
    lastPresentedFrameAt = 0;
    lastPresentedMonotonicMs = -1;
    relayReceivedAt = relayRefreshAt = rawMissingSince = rawSourceBaseline = 0;
    rawPresentationStallAt = rawPresentationSourceBaseline = 0;
    lastDecodedFrameAt = presentationRecoveryAt = 0;
    rawTransitFloor = null; resetTransitWindow(); rawLastTimestamp = 0; rawSourceReceivedAt = 0; rawReferenceDeadline = null; rawReferenceCatchup = false; rawFailedReferenceNotified = false; diagnostics.referenceRecoveryFailed = 0;
    if (relayCanvas) relayCanvas.hidden = true;
    if (relayDockCanvas) relayDockCanvas.hidden = true;
    if (dockVideo) { dockVideo.hidden = false; dockVideo.srcObject = null; }
    remoteVideo.hidden = false;
    if (dc) { try { dc.close(); } catch (_) {} dc = null; }
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
      try { pc.close(); } catch (_) {} pc = null;
    }
    remoteVideo.onloadeddata = remoteVideo.onplaying = null;
    remoteVideo.srcObject = null;
    updatePresentationLayout();
    diagnostics.peerConnectionState = 'closed';
    diagnostics.dataChannelState = 'closed';
  }

  // Auto-Connect Immediately on Load
  setTimeout(() => {
    if (state === 'READY') {
      connectAndJoin();
    }
  }, 300);

  renderDiagnostics();
  resetProgress();

  // Expose test helper hooks
  window.__KARCAST_TEST_HOOKS__ = {
    connectAndJoin,
    getUIState: () => state,
    getDiagnostics: () => diagnostics,
    getFrameAgeHistogram: () => frameAgeBuckets.slice(),
    sendTouch,
    applyVideoLayout, browserViewport, getTouchPoint, presentationGeometry, updatePresentationLayout,
    cleanupWebRTC
  };
})();
