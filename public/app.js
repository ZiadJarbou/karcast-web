/**
 * KarCast Vehicle Browser Client (https://app.karcast.app)
 * Version: 1.0
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
  const codeInputs = Array.from(document.querySelectorAll('.code-digit'));
  const connectBtn = document.getElementById('connect-btn');
  const retryBtn = document.getElementById('retry-btn');
  const messageBox = document.getElementById('message-box');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  const connectionPill = document.getElementById('connection-pill');
  const remoteVideo = document.getElementById('remoteVideo');
  const metricsPanel = document.getElementById('metrics-panel');

  // Application State
  let state = 'READY'; // READY, PAIRING, ESTABLISHING_SECURE_CONNECTION, CONNECTED, RECONNECTING, FAILED
  let pairingCode = '';
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
    diagnosticsBuildId: 'phase3d-unified-client',
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

  // 1. Code Input Management
  codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = val ? val.slice(-1) : '';

      if (val && index < codeInputs.length - 1) {
        codeInputs[index + 1].focus();
      }

      updatePairingCodeFromInputs();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && index > 0) {
        codeInputs[index - 1].focus();
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '').slice(0, 6);
      pasteData.split('').forEach((char, idx) => {
        if (codeInputs[idx]) codeInputs[idx].value = char;
      });
      if (codeInputs[Math.min(pasteData.length, 5)]) {
        codeInputs[Math.min(pasteData.length, 5)].focus();
      }
      updatePairingCodeFromInputs();
    });
  });

  function updatePairingCodeFromInputs() {
    pairingCode = codeInputs.map(i => i.value).join('');
    connectBtn.disabled = pairingCode.length !== 6;
  }

  function setUIState(newState, userMessage = '', isError = false) {
    state = newState;
    messageBox.textContent = userMessage;
    messageBox.classList.toggle('error', isError);

    switch (newState) {
      case 'READY':
        statusText.textContent = 'Ready to connect';
        statusDot.className = 'status-dot';
        overlay.hidden = false;
        connectionPill.hidden = true;
        connectBtn.disabled = pairingCode.length !== 6;
        connectBtn.hidden = false;
        retryBtn.hidden = true;
        break;

      case 'CONNECTING_SIGNAL':
      case 'PAIRING':
      case 'ESTABLISHING_SECURE_CONNECTION':
        statusText.textContent = 'Connecting...';
        statusDot.className = 'status-dot connecting';
        connectBtn.disabled = true;
        connectBtn.hidden = false;
        retryBtn.hidden = true;
        break;

      case 'CONNECTED':
        statusText.textContent = diagnostics.connectionPath === 'local-direct' ? 'Connected • Local Hotspot' : 'Connected';
        statusDot.className = 'status-dot connected';
        overlay.hidden = true;
        connectionPill.hidden = false;
        break;

      case 'RECONNECTING':
        statusText.textContent = 'Reconnecting...';
        statusDot.className = 'status-dot connecting';
        break;

      case 'INVALID_CODE':
      case 'CODE_EXPIRED':
      case 'PHONE_NOT_AVAILABLE':
      case 'CONNECTION_FAILED':
        statusText.textContent = 'Connection failed';
        statusDot.className = 'status-dot error';
        overlay.hidden = false;
        connectionPill.hidden = true;
        connectBtn.hidden = true;
        retryBtn.hidden = false;
        break;
    }
    renderDiagnostics();
  }

  // 2. Public Signaling Client
  function connectAndJoin() {
    if (pairingCode.length !== 6) return;

    setUIState('PAIRING', 'Connecting to KarCast signaling relay...');
    cleanupWebRTC();

    try {
      ws = new WebSocket(SIGNAL_URL);
      diagnostics.signalingState = 'connecting';
    } catch (err) {
      setUIState('CONNECTION_FAILED', 'Unable to reach signaling relay. Check network.', true);
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
        setUIState('CONNECTION_FAILED', 'Unable to connect to KarCast signaling relay.', true);
      }
    };

    ws.onclose = () => {
      diagnostics.signalingState = 'closed';
      clearInterval(heartbeatTimer);

      if (state === 'CONNECTED' && pc && pc.connectionState === 'connected') {
        setTimeout(reconnectSignalingBackground, 5000);
      } else if (state !== 'READY' && state !== 'INVALID_CODE' && state !== 'CODE_EXPIRED') {
        setUIState('CONNECTION_FAILED', 'Signaling connection closed.', true);
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
        setUIState('ESTABLISHING_SECURE_CONNECTION', 'Code accepted. Waiting for phone...');
        break;

      case 'peer_ready':
        if (msg.role === 'phone' || msg.role === 'browser') {
          initiateWebRTCOffer();
        }
        break;

      case 'answer':
        if (pc && msg.sdp) {
          pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {
            setUIState('CONNECTION_FAILED', 'Failed to set remote SDP answer.', true);
          });
        }
        break;

      case 'candidate':
        if (pc && msg.candidate) {
          pc.addIceCandidate(msg.candidate).catch(() => {});
        }
        break;

      case 'expired':
        setUIState('CODE_EXPIRED', 'This pairing code has expired. Generate a new code on your phone.', true);
        cleanupWebRTC();
        break;

      case 'closed':
        setUIState('PHONE_NOT_AVAILABLE', 'Phone disconnected from session.', true);
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
        setUIState('INVALID_CODE', 'Invalid pairing code. Check the code on your phone and try again.', true);
        break;
      case 'PAIRING_CODE_EXPIRED':
        setUIState('CODE_EXPIRED', 'This code has expired. Generate a new code in KarCast.', true);
        break;
      case 'SESSION_NOT_FOUND':
        setUIState('PHONE_NOT_AVAILABLE', 'Phone not available. Make sure KarCast is running on your phone.', true);
        break;
      default:
        setUIState('CONNECTION_FAILED', msg.message || 'Unable to connect to your phone. Make sure vehicle is connected to phone hotspot.', true);
    }
    cleanupWebRTC();
  }

  // 3. WebRTC Direct P2P Connection
  function initiateWebRTCOffer() {
    if (pc) return;

    setUIState('ESTABLISHING_SECURE_CONNECTION', 'Establishing direct local connection...');

    try {
      pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: 'max-bundle'
      });
      diagnostics.peerConnectionState = pc.connectionState;
    } catch (e) {
      setUIState('CONNECTION_FAILED', 'WebRTC is unavailable in this browser.', true);
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
      }
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

    pc.onconnectionstatechange = () => {
      diagnostics.peerConnectionState = pc.connectionState;
      if (pc.connectionState === 'connected') {
        setUIState('CONNECTED');
        inspectSelectedIceCandidatePair();
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setUIState('CONNECTION_FAILED', 'Unable to connect to your phone. Make sure this vehicle is connected to the phone hotspot.', true);
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
      setUIState('CONNECTION_FAILED', 'Failed to create WebRTC offer.', true);
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

  // Event Listeners
  connectBtn.addEventListener('click', connectAndJoin);
  retryBtn.addEventListener('click', () => {
    codeInputs.forEach(i => i.value = '');
    updatePairingCodeFromInputs();
    setUIState('READY');
    codeInputs[0].focus();
  });

  // Auto-Focus First Input
  codeInputs[0].focus();
  renderDiagnostics();

  // Expose test helper hooks
  window.__KARCAST_TEST_HOOKS__ = {
    setPairingCode: (code) => {
      code.split('').forEach((c, idx) => { if (codeInputs[idx]) codeInputs[idx].value = c; });
      updatePairingCodeFromInputs();
    },
    connectAndJoin,
    getUIState: () => state,
    getDiagnostics: () => diagnostics,
    sendTouch,
    cleanupWebRTC
  };
})();
