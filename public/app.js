/**
 * KarCast Vehicle Browser Client (https://app.karcast.app)
 * Version: 2.0
 *
 * Public entry point for Tesla and vehicle browsers.
 * Bootstraps WebRTC signaling via wss://app.karcast.app/ws.
 * Video streaming and touch controls pass 100% LOCALLY over hotspot P2P WebRTC.
 */

(function () {
  'use strict';

  const PROTOCOL_VERSION = '1.0';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const DEFAULT_SIGNAL_URL = `${protocol}//${location.host}/ws`;
  const urlParams = new URLSearchParams(window.location.search);
  const SIGNAL_URL = window.KARCAST_SIGNAL_URL || urlParams.get('signal') || DEFAULT_SIGNAL_URL;
  const SHOW_METRICS = urlParams.get('metrics') === '1';
  const requestedTransport = (urlParams.get('transport') || '').toLowerCase();
  const RELAY_AVAILABLE = !!window.VideoDecoder && !!window.EncodedVideoChunk;
  let useRelay = RELAY_AVAILABLE && requestedTransport === 'relay';
  const AUTO_RELAY = RELAY_AVAILABLE && requestedTransport !== 'webrtc';
  const DIRECT_START_TIMEOUT_MS = 15000;

  // UI Elements
  const overlay = document.getElementById('pairing-overlay');
  const messageBox = document.getElementById('message-box');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const connectionPill = document.getElementById('connection-pill');
  const remoteVideo = document.getElementById('remoteVideo');
  const relayCanvas = document.getElementById('relayCanvas');
  const relayContext = relayCanvas ? relayCanvas.getContext('2d', { alpha: false }) : null;
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
  let pairingCode = 'auto';
  let sessionId = null;
  let ws = null;
  let pc = null;
  let dc = null;
  let heartbeatTimer = null;
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
  let relayDecoderFailed = false;
  let transportFallbackTimer = null;
  let relayConfig = [];
  let relayHasKeyframe = false;
  let lastPresentedFrameAt = 0;
  let pendingCandidates = [];
  let signalingOnlyReconnect = false;
  let firstFrameTimer = null;
  let connectionStartedAt = 0;
  let mediaHealthTimer = null;
  let phoneProgressAt = 0;
  let phoneSourceFrames = 0;
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

  // Diagnostics & Metrics
  const diagnostics = {
    diagnosticsBuildId: 'tesla-auto-relay-20261002',
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

  function setUIState(newState, userMessage = '', isError = false) {
    state = newState;
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
        overlay.hidden = false;
        connectionPill.hidden = false;

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
    if (!pairingCode) pairingCode = 'auto';
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
      ws = new WebSocket(SIGNAL_URL);
      ws.binaryType = 'arraybuffer';
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
        }
      }, 15000);

      ws.send(JSON.stringify({
        version: PROTOCOL_VERSION,
        type: 'join',
        pairingCode: pairingCode,
        messageId: 'join_' + Date.now(),
        timestamp: Date.now()
      }));
    };

    ws.onmessage = (event) => {
      if (ws !== socket) return;
      if (typeof event.data !== 'string') {
        handleRelayFrame(event.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) { return; }

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
      if (ws !== socket) return;
      diagnostics.signalingState = 'closed';
      diagnostics.lastSocketCloseCode = event.code;
      diagnostics.lastSocketCloseReason = event.reason || '';
      clearInterval(heartbeatTimer);

      if (hasConnectedPeerTransport()) {
        scheduleReconnect(true);
      } else {
        scheduleReconnect();
      }
    };
  }

  function retireSignalingSocket() {
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
    const delay = Math.min(10000, 2500 * Math.max(1, connectAttempt));
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
      case 'joined':
        if (signalingOnlyReconnect && sessionId === msg.sessionId) {
          signalingOnlyReconnect = false;
          connectAttempt = 0;
          break;
        }
        if (signalingOnlyReconnect) cleanupWebRTC();
        signalingOnlyReconnect = false;
        sessionId = msg.sessionId;
        setProgressMilestone(30, 40);
        setUIState('ESTABLISHING_SECURE_CONNECTION');
        armConnectionWatchdog();
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
      version: PROTOCOL_VERSION, type: 'relay_start', sessionId,
      messageId: 'relay_' + Date.now(), timestamp: Date.now()
    }));
    return true;
  }

  function tryRelayFallback(reason) {
    if (!AUTO_RELAY || useRelay || !sessionId || !ws || ws.readyState !== WebSocket.OPEN) return false;
    // Keep the pairing socket and progress: only replace the failed media transport.
    diagnostics.fallbackReason = reason;
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

  function initiateWebRTCOffer() {
    if (pc) return;

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
    if (AUTO_RELAY) transportFallbackTimer = setTimeout(() => {
      if (pc === peer && !mediaStarted) tryRelayFallback('No direct video frame after 15 seconds');
    }, DIRECT_START_TIMEOUT_MS);
    dc = pc.createDataChannel('tesla-touch', { ordered: true });
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
        diagnostics.androidAutoState = message.state;
        if (message.sourceFrames > phoneSourceFrames) phoneProgressAt = Date.now();
        phoneSourceFrames = message.sourceFrames;
      } catch (_) {}
    };
    startMediaHealthChecks(peer);

    const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    if ('jitterBufferTarget' in videoTransceiver.receiver) {
      try { videoTransceiver.receiver.jitterBufferTarget = 0; } catch (_) {}
    }

    pc.ontrack = (e) => {
      if (pc !== peer) return;
      if (e.track) {
        setProgressMilestone(78, 86);
        remoteVideo.srcObject = new MediaStream([e.track]);
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
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (mediaStarted) clearConnectionWatchdog();
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
        setProgressMilestone(86, 92);
        inspectSelectedIceCandidatePair();
      } else if (pc.iceConnectionState === 'failed') {
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
            sdp: offer.sdp
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

  function requestVideoRefresh() {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type: 'keyframe' }));
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
        if (video.framesDecoded !== lastFrames) { decodedAt = now; stalledSince = 0; }
        if (video.bytesReceived !== lastBytes) receivedAt = now;
        lastFrames = video.framesDecoded;
        lastBytes = video.bytesReceived;
        diagnostics.framesDecoded = lastFrames;
        diagnostics.framesDropped = video.framesDropped || 0;
        diagnostics.videoQuietMs = now - decodedAt;
        const sourceMoving = (receivedAt > 0 && now - receivedAt < 3000) ||
          (phoneProgressAt > 0 && now - phoneProgressAt < 3000);
        if (!sourceMoving || now - decodedAt <= 4000) stalledSince = 0;
        else if (!stalledSince) stalledSince = now;
        if (sourceMoving && now - decodedAt > 4000 && now - requestedAt > 3000) {
          requestedAt = now;
          requestVideoRefresh();
          remoteVideo.play().catch(() => {});
        }
        if (stalledSince && now - stalledSince > 11000) {
          clearInterval(mediaHealthTimer);
          diagnostics.videoStalls = (diagnostics.videoStalls || 0) + 1;
          setUIState('RECONNECTING', 'Restoring video...', false);
          scheduleReconnect();
        }
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
    const r = target.getBoundingClientRect();
    const sourceWidth = target === relayCanvas ? relayCanvas.width : remoteVideo.videoWidth;
    const sourceHeight = target === relayCanvas ? relayCanvas.height : remoteVideo.videoHeight;
    if (!sourceWidth || !sourceHeight || !r.width || !r.height) return null;

    const scale = Math.min(r.width / sourceWidth, r.height / sourceHeight);
    const displayWidth = sourceWidth * scale;
    const displayHeight = sourceHeight * scale;
    const displayLeft = r.left + (r.width - displayWidth) / 2;
    const displayTop = r.top + (r.height - displayHeight) / 2;
    const x = (e.clientX - displayLeft) / displayWidth;
    const y = (e.clientY - displayTop) / displayHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }


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
      relayDecoder = new VideoDecoder({
        output: frame => {
          if (relayCanvas.width !== frame.displayWidth || relayCanvas.height !== frame.displayHeight) {
            relayCanvas.width = frame.displayWidth;
            relayCanvas.height = frame.displayHeight;
          }
          relayContext.drawImage(frame, 0, 0, relayCanvas.width, relayCanvas.height);
          frame.close();
          remoteVideo.hidden = true;
          relayCanvas.hidden = false;
          if (!mediaStarted) diagnostics.firstFrameMs = Date.now() - connectionStartedAt;
          mediaStarted = true;
          diagnostics.connectionPath = 'secure-relay';
          diagnostics.protocol = 'wss';
          diagnostics.presentedFrames++;
          lastPresentedFrameAt = Date.now();
          setProgressMilestone(100);
          connectAttempt = 0;
          clearConnectionWatchdog();
          if (state !== 'CONNECTED') setUIState('CONNECTED');
        },
        error: failRelayDecoder
      });
      relayDecoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      return true;
    } catch (error) {
      failRelayDecoder(error);
      return false;
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

  function handleRelayFrame(payload) {
    if (!useRelay) return;
    const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : null;
    if (!bytes || bytes.byteLength < 13 || bytes[0] !== 75 || bytes[1] !== 67 || bytes[2] !== 1) return;
    const flags = bytes[3];
    const data = bytes.slice(12);
    if (flags & 1) {
      relayConfig = [data];
      return;
    }
    const key = (flags & 2) !== 0;
    if (!relayHasKeyframe && !key) return;
    if (!ensureRelayDecoder()) return;
    let accessUnit = data;
    if (key && relayConfig.length) accessUnit = concatBytes(relayConfig.concat([data]));
    const view = new DataView(bytes.buffer, bytes.byteOffset + 4, 8);
    const timestamp = view.getUint32(0) * 4294967296 + view.getUint32(4);
    try {
      relayDecoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: timestamp, data: accessUnit }));
      if (key) relayHasKeyframe = true;
    } catch (_) {
      relayHasKeyframe = false;
    }
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
  setInterval(() => {
    if (state !== 'CONNECTED' || diagnostics.connectionPath !== 'secure-relay' || !lastPresentedFrameAt) return;
    // AA may legitimately stop producing frames on an unchanged screen.
    // A stalled decoder has pending work; silence alone is not a transport failure.
    if (Date.now() - lastPresentedFrameAt < 12000 || !relayDecoder || !relayDecoder.decodeQueueSize) return;
    diagnostics.relayStalls = (diagnostics.relayStalls || 0) + 1;
    lastPresentedFrameAt = 0;
    setUIState('RECONNECTING', 'Video paused. Reconnecting...', false);
    scheduleReconnect();
  }, 3000);
  window.addEventListener('blur', handleCancelTouch);

  // 6. Diagnostics Mode (?metrics=1)
  function renderDiagnostics() {
    if (!SHOW_METRICS) return;
    metricsPanel.hidden = false;
    metricsPanel.textContent = 'KarCast Vehicle Client Diagnostics (?metrics=1)\n' + JSON.stringify(diagnostics, null, 2);
  }

  // 7. Cleanup
  function cleanupWebRTC() {
    clearTimeout(transportFallbackTimer);
    transportFallbackTimer = null;
    handleCancelTouch();
    clearInterval(firstFrameTimer);
    firstFrameTimer = null;
    pendingCandidates = [];
    clearInterval(mediaHealthTimer);
    mediaHealthTimer = null;
    phoneProgressAt = phoneSourceFrames = 0;
    clearConnectionWatchdog();
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
    mediaStarted = false;
    if (relayDecoder) { try { relayDecoder.close(); } catch (_) {} }
    relayDecoder = null;
    relayDecoderFailed = false;
    relayConfig = [];
    relayHasKeyframe = false;
    lastPresentedFrameAt = 0;
    if (relayCanvas) relayCanvas.hidden = true;
    remoteVideo.hidden = false;
    if (dc) { try { dc.close(); } catch (_) {} dc = null; }
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
      try { pc.close(); } catch (_) {} pc = null;
    }
    remoteVideo.onloadeddata = remoteVideo.onplaying = null;
    remoteVideo.srcObject = null;
    diagnostics.peerConnectionState = 'closed';
    diagnostics.dataChannelState = 'closed';
  }

  // Auto-Connect Immediately on Load
  setTimeout(() => {
    if (state === 'READY') {
      pairingCode = 'auto';
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
    sendTouch,
    cleanupWebRTC
  };
})();
