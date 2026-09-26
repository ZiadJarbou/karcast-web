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

  // UI Elements
  const overlay = document.getElementById('pairing-overlay');
  const messageBox = document.getElementById('message-box');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const connectionPill = document.getElementById('connection-pill');
  const remoteVideo = document.getElementById('remoteVideo');
  const metricsPanel = document.getElementById('metrics-panel');

  const cardHeading = document.getElementById('card-heading');
  const cardSubtitle = document.getElementById('card-subtitle');
  const waitingSteps = document.getElementById('waiting-steps');
  const progressTimeline = document.getElementById('progress-timeline');
  const statusPanelTitle = document.getElementById('status-panel-title');
  const statusPanelSub = document.getElementById('status-panel-sub');

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
  let seq = 0;
  let pressedPointer = null;
  let lastPoint = { x: 0, y: 0 };

  // Diagnostics & Metrics
  const diagnostics = {
    diagnosticsBuildId: 'phase3d-unified-client-v2.0',
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
      case 'ESTABLISHING_SECURE_CONNECTION':
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
  function connectAndJoin() {
    if (!pairingCode) pairingCode = 'auto';

    setUIState('PAIRING');
    cleanupWebRTC();

    try {
      ws = new WebSocket(SIGNAL_URL);
      diagnostics.signalingState = 'connecting';
    } catch (err) {
      setUIState('CONNECTION_FAILED');
      return;
    }

    ws.onopen = () => {
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
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) { return; }

      handleSignalingMessage(msg);
    };

    ws.onerror = () => {
      diagnostics.signalingState = 'error';
      if (state !== 'CONNECTED') {
        setUIState('PHONE_NOT_AVAILABLE');
        setTimeout(connectAndJoin, 3000);
      }
    };

    ws.onclose = () => {
      diagnostics.signalingState = 'closed';
      clearInterval(heartbeatTimer);

      if (state === 'CONNECTED' && pc && pc.connectionState === 'connected') {
        setTimeout(reconnectSignalingBackground, 5000);
      } else {
        setTimeout(connectAndJoin, 3000);
      }
    };
  }

  function reconnectSignalingBackground() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    try {
      ws = new WebSocket(SIGNAL_URL);
      ws.onopen = () => { diagnostics.signalingState = 'open'; };
      ws.onclose = () => { diagnostics.signalingState = 'closed'; };
    } catch (_) {}
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        sessionId = msg.sessionId;
        setUIState('ESTABLISHING_SECURE_CONNECTION');
        break;

      case 'peer_ready':
        if (msg.role === 'phone' || msg.role === 'browser') {
          initiateWebRTCOffer();
        }
        break;

      case 'answer':
        if (pc && msg.sdp) {
          pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {
            setUIState('CONNECTION_FAILED');
          });
        }
        break;

      case 'candidate':
        if (pc && msg.candidate) {
          pc.addIceCandidate(msg.candidate).catch(() => {});
        }
        break;

      case 'expired':
        setUIState('CODE_EXPIRED');
        cleanupWebRTC();
        break;

      case 'closed':
        setUIState('PHONE_NOT_AVAILABLE');
        cleanupWebRTC();
        break;

      case 'error':
        handleSignalingError(msg);
        break;
    }
  }

  function handleSignalingError(msg) {
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
  }

  // 3. WebRTC Direct P2P Connection
  function initiateWebRTCOffer() {
    if (pc) return;

    setUIState('ESTABLISHING_SECURE_CONNECTION');

    try {
      pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: 'max-bundle'
      });
      diagnostics.peerConnectionState = pc.connectionState;
    } catch (e) {
      setUIState('CONNECTION_FAILED');
      return;
    }

    dc = pc.createDataChannel('tesla-touch', { ordered: true });
    dc.onopen = () => { diagnostics.dataChannelState = 'open'; renderDiagnostics(); };
    dc.onclose = () => { diagnostics.dataChannelState = 'closed'; renderDiagnostics(); };

    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.ontrack = (e) => {
      if (e.track) {
        remoteVideo.srcObject = new MediaStream([e.track]);
        remoteVideo.play().catch(() => {});
        setUIState('CONNECTED');
      }
    };

    remoteVideo.onplaying = () => {
      setUIState('CONNECTED');
    };

    pc.onicecandidate = (e) => {
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
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setUIState('CONNECTED');
        inspectSelectedIceCandidatePair();
      } else if (pc.iceConnectionState === 'failed') {
        setUIState('CONNECTION_FAILED');
      }
    };

    pc.onconnectionstatechange = () => {
      diagnostics.peerConnectionState = pc.connectionState;
      if (pc.connectionState === 'connected') {
        setUIState('CONNECTED');
        inspectSelectedIceCandidatePair();
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setUIState('CONNECTION_FAILED');
      }
      renderDiagnostics();
    };

    pc.createOffer().then(offer => {
      return pc.setLocalDescription(offer).then(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
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
    }).catch(() => {
      setUIState('CONNECTION_FAILED');
    });
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
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify({
      seq: ++seq,
      action: action,
      x: p.x,
      y: p.y
    }));
    return true;
  }

  function getTouchPoint(e) {
    const r = remoteVideo.getBoundingClientRect();
    const vw = remoteVideo.videoWidth || 1280;
    const vh = remoteVideo.videoHeight || 720;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - h) / 2) / h;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  function handleCancelTouch() {
    if (pressedPointer !== null) {
      sendTouch('cancel', lastPoint);
      pressedPointer = null;
    }
  }

  remoteVideo.onpointerdown = (e) => {
    if (pressedPointer !== null || e.button !== 0) return;
    const p = getTouchPoint(e);
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
    e.preventDefault();
    lastPoint = p;
    if (sendTouch('down', p)) {
      pressedPointer = e.pointerId;
      remoteVideo.setPointerCapture(e.pointerId);
    }
  };

  remoteVideo.onpointermove = (e) => {
    if (e.pointerId !== pressedPointer) return;
    e.preventDefault();
    const p = getTouchPoint(e);
    lastPoint = p;
    sendTouch('move', p);
  };

  remoteVideo.onpointerup = (e) => {
    if (e.pointerId !== pressedPointer) return;
    e.preventDefault();
    const p = getTouchPoint(e);
    lastPoint = p;
    sendTouch('up', p);
    pressedPointer = null;
  };

  remoteVideo.onpointercancel = remoteVideo.onlostpointercapture = handleCancelTouch;
  window.addEventListener('blur', handleCancelTouch);

  // 6. Diagnostics Mode (?metrics=1)
  function renderDiagnostics() {
    if (!SHOW_METRICS) return;
    metricsPanel.hidden = false;
    metricsPanel.textContent = 'KarCast Vehicle Client Diagnostics (?metrics=1)\n' + JSON.stringify(diagnostics, null, 2);
  }

  // 7. Cleanup
  function cleanupWebRTC() {
    handleCancelTouch();
    if (dc) { try { dc.close(); } catch (_) {} dc = null; }
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
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

  // Expose test helper hooks
  window.__KARCAST_TEST_HOOKS__ = {
    connectAndJoin,
    getUIState: () => state,
    getDiagnostics: () => diagnostics,
    sendTouch,
    cleanupWebRTC
  };
})();
