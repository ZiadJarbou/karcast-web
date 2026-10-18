'use strict';

/**
 * Core Unified Server Class for app.karcast.app
 *
 * Exports UnifiedAppServer without auto-starting.
 * Used by server.js (production entry point) and test.js (automated tests).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WsSocket = require('./tools/signal-server/ws_frame.cjs');
const RelayFreshness = require('./relay-freshness.cjs');
const SplitMedia = require('./split-media.cjs');
const { SessionStore } = require('./tools/signal-server/session_store.cjs');
const {
  PROTOCOL_VERSION,
  MSG_TYPES,
  ERROR_CODES,
  createMessage,
  createErrorMessage,
  parseAndValidateMessage
} = require('./tools/signal-server/protocol.cjs');

// Optional bounded viewport, forwarded only after authenticated pairing succeeds.
function viewportDescriptor(v) {
  if (!v || v.schema !== 2 || !Number.isInteger(v.width) || !Number.isInteger(v.height) ||
      v.width<240 || v.width>4096 || v.height<240 || v.height>4096 || v.width/v.height<0.5 || v.width/v.height>4) return undefined;
  return {schema:2,width:v.width,height:v.height};
}
const PORT = Number(process.env.PORT) || 8090;
const PUBLIC_DIR = path.join(__dirname, 'public');

const SERVER_INSTANCE_ID = 'inst_' + crypto.randomBytes(4).toString('hex');
const SERVER_STARTED_AT = Date.now();

function codeFingerprint(code) {
  if (!code || typeof code !== 'string') return 'none';
  return crypto.createHash('sha256').update(code.trim()).digest('hex').slice(0, 8);
}

class UnifiedAppServer {
  constructor(options = {}) {
    this.port = options.port ?? PORT;
    this.allowedOrigins = options.allowedOrigins || null;
    this.validateUpgrade = options.validateUpgrade || (() => true);
    this.sessionStore = new SessionStore();
    this.server = null;
    this.connections = new Set();
    this.relayFreshness = new RelayFreshness();
    this.splitMedia = new SplitMedia(this.sessionStore);
    // V61: a paired browser that sends nothing (not even a WebSocket pong) for
    // browserDeadMs is closed, so its session returns to REGISTERED in seconds
    // instead of waiting ~2 minutes for TCP to notice a vanished network.
    this.browserPingMs = options.browserPingMs ?? 2500;
    this.browserDeadMs = options.browserDeadMs ?? 8000;
    this.livenessTimer = null;
    this.livenessCounters = { pings: 0, deadBrowsersClosed: 0 };
  }

  checkBrowserLiveness(now = Date.now()) {
    for (const ws of this.sessionStore.browserToSession.keys()) {
      // A slow but alive browser keeps draining queued video (its TCP stack
      // acknowledges data), even when our ping waits behind that video.
      const written = ws.socket?.bytesWritten;
      if (typeof written === 'number' && ws.socket.writableLength > 0 && written !== ws.livenessBytesWritten) ws.lastReceivedAt = now;
      ws.livenessBytesWritten = written;
      const silentMs = now - (ws.lastReceivedAt || now);
      if (silentMs >= this.browserDeadMs) {
        this.livenessCounters.deadBrowsersClosed++;
        console.log(`[BROWSER_DEAD] instanceId=${SERVER_INSTANCE_ID} silentMs=${silentMs}`);
        if (typeof ws.handleClose === 'function') ws.handleClose(); // emits close -> session REGISTERED
        continue;
      }
      if (silentMs >= this.browserPingMs) {
        this.livenessCounters.pings++;
        if (typeof ws.sendPing === 'function') ws.sendPing();
        // App-level heartbeat lets the browser detect a dead server path too.
        try { ws.send(createMessage(MSG_TYPES.HEARTBEAT, { serverLiveness: true })); } catch (_) {}
      }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

      this.server.on('upgrade', (req, socket, head) => {
        if (!this.validateUpgrade(req)) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname !== '/ws' && url.pathname !== '/' && url.pathname !== '/ws/media') {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        // Browser Origin Validation for WebSocket Connections
        const origin = req.headers['origin'];
        if (origin) {
          let originHost;
          try { originHost = new URL(origin).host.toLowerCase(); }
          catch (_) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
          const allowedHosts = ['app.karcast.app', 'localhost', '127.0.0.1'];
          const allowed = this.allowedOrigins ? this.allowedOrigins.includes(origin) : allowedHosts.some(allowedHost =>
            originHost === allowedHost || originHost.startsWith(allowedHost + ':')
          );
          if (!allowed) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        const mediaGrant = url.pathname === '/ws/media' ? this.splitMedia.authorize(req) : null;
        if (url.pathname === '/ws/media' && (!mediaGrant || url.search)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
        }
        const ws = WsSocket.performHandshake(req, socket);
        if (!ws) return;

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                         req.socket.remoteAddress || '127.0.0.1';

        this.connections.add(ws);

        if (mediaGrant) {
          this.splitMedia.bind(ws, mediaGrant);
          ws.on('close', () => this.connections.delete(ws));
          if (head.length) ws.handleData(head);
          return;
        }
        ws.on('message', text => this.handleWsMessage(ws, text, clientIp));
        ws.on('binary', data => this.handleWsBinary(ws, data));
        ws.on('close', () => {
          this.connections.delete(ws);
          this.splitMedia.controlClosed(ws);
          this.sessionStore.handleSocketDisconnect(ws);
        });
        if (head.length) ws.handleData(head);
      });

      this.livenessTimer = setInterval(() => this.checkBrowserLiveness(), Math.min(1000, this.browserPingMs));
      if (this.livenessTimer.unref) this.livenessTimer.unref();
      this.server.listen(this.port, () => {
        this.port = this.server.address().port;
        console.log(`[SERVER_START] instanceId=${SERVER_INSTANCE_ID} startedAt=${SERVER_STARTED_AT} pid=${process.pid} port=${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', err => reject(err));
    });
  }

  handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    // Health Check Endpoint with safe process instance diagnostics
    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        service: 'app.karcast.app',
        version: PROTOCOL_VERSION,
        serverInstanceId: SERVER_INSTANCE_ID,
        serverStartedAt: SERVER_STARTED_AT,
        timestamp: Date.now()
      }));
      return;
    }

    // Static Web Assets Serving (public/)
    let reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon'
    };

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'File Not Found' }));
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.writeHead(200);
      res.end(data);
    });
  }

  handleWsMessage(ws, rawText, clientIp) {
    let msg;
    try {
      msg = parseAndValidateMessage(rawText);
    } catch (err) {
      ws.send(createErrorMessage(err.code || ERROR_CODES.INVALID_MESSAGE_FORMAT, err.message || 'Invalid message'));
      return;
    }

    try {
      switch (msg.type) {
        case MSG_TYPES.SPLIT_START:
        case MSG_TYPES.SPLIT_RECONNECT:
          this.splitMedia.request(ws, msg); break;

        case MSG_TYPES.REGISTER:
          this.handleRegister(ws, msg, clientIp);
          break;

        case MSG_TYPES.JOIN:
          this.handleJoin(ws, msg, clientIp);
          break;

        case MSG_TYPES.OFFER:
          this.handleOffer(ws, msg);
          break;

        case MSG_TYPES.ANSWER:
          this.handleAnswer(ws, msg);
          break;

        case MSG_TYPES.CANDIDATE:
          this.handleCandidate(ws, msg);
          break;

        case MSG_TYPES.READY:
          this.handleReady(ws, msg);
          break;

        case MSG_TYPES.HEARTBEAT:
          ws.send(createMessage(MSG_TYPES.HEARTBEAT, { replyToMessageId: msg.messageId }));
          break;

        case MSG_TYPES.CLOSE:
          this.handleClose(ws, msg);
          break;

        case MSG_TYPES.REQUEST_KEYFRAME:
        case MSG_TYPES.RELAY_START:
        case MSG_TYPES.RELAY_TOUCH:
        case MSG_TYPES.RELAY_STATUS:
          this.forwardRelayControl(ws, msg);
          break;

        default:
          ws.send(createErrorMessage(ERROR_CODES.UNKNOWN_MESSAGE_TYPE, `Unsupported message type: ${msg.type}`, msg.messageId));
      }
    } catch (err) {
      ws.send(createErrorMessage(err.code || ERROR_CODES.INTERNAL_ERROR, err.message || 'Error processing request', msg.messageId));
    }
  }

  forwardRelayControl(ws, msg) {
    if (msg.type === MSG_TYPES.RELAY_START) this.splitMedia.legacy(ws);
    const session = this.sessionStore.getSessionBySocket(ws);
    if (!session) throw { code: ERROR_CODES.UNAUTHORIZED, message: 'Relay session not found' };
    const target = session.phoneSocket === ws ? session.browserSocket : session.phoneSocket;
    if (target) target.send(JSON.stringify(msg));
  }

  handleWsBinary(ws, data) {
    const session = this.sessionStore.getSessionBySocket(ws);
    if (!session || session.phoneSocket !== ws || !session.browserSocket || this.splitMedia.active(ws)) return;
    // Binary media is accepted only phone -> paired browser and is never persisted.
    this.relayFreshness.forward(session.browserSocket, ws, session.sessionId, data);
  }

  handleRegister(ws, msg, clientIp) {
    ws.splitMediaCapable = msg.capabilities?.includes('ws-split-v1') === true;
    const session = this.sessionStore.registerPhoneSession(ws, clientIp, msg.phone_token || '');
    console.log(`[REGISTER] instanceId=${SERVER_INSTANCE_ID} codeHash=${codeFingerprint(session.pairingCode)} sess=${session.sessionId.slice(-6)} activeSessions=${this.sessionStore.sessionsById.size}`);
    ws.send(createMessage(MSG_TYPES.REGISTERED, {
      sessionId: session.sessionId,
      pairingCode: session.pairingCode,
      expiresAt: session.expiresAt,
      replyToMessageId: msg.messageId
    }));
  }

  handleJoin(ws, msg, clientIp) {
    const pairingCode = String(msg.pairingCode || '').trim();
    const pairToken = ws.pairToken || msg.pair_token || '';
    if (ws.pairToken && msg.pair_token && ws.pairToken !== msg.pair_token) {
      throw { code: ERROR_CODES.UNAUTHORIZED, message: 'Pairing token mismatch' };
    }
    if (!pairingCode && !pairToken) {
      ws.send(createErrorMessage(ERROR_CODES.PAIRING_CODE_INVALID, 'Missing pairing code', msg.messageId));
      return;
    }

    const existingSession = this.sessionStore.sessionsByCode.get(pairingCode);
    console.log(`[JOIN] instanceId=${SERVER_INSTANCE_ID} codeHash=${codeFingerprint(pairingCode)} codeFound=${!!existingSession} activeSessions=${this.sessionStore.sessionsById.size}`);

    let session;
    try {
      session = this.sessionStore.joinBrowserSession(ws, pairingCode, clientIp, pairToken);
    } catch (err) {
      this.sessionStore.recordFailedJoin(pairingCode);
      ws.send(createErrorMessage(err.code || ERROR_CODES.PAIRING_CODE_INVALID, err.message || 'Failed to join session', msg.messageId));
      return;
    }

    ws.send(createMessage(MSG_TYPES.JOINED, {
      sessionId: session.sessionId,
      pair_token: session.pairToken,
      capabilities: session.phoneSocket?.splitMediaCapable ? ['ws-split-v1'] : [],
      replyToMessageId: msg.messageId
    }));

    session.browserViewport = viewportDescriptor(msg.viewport);
    const peerReadyPhone = createMessage(MSG_TYPES.PEER_READY, { sessionId: session.sessionId, role: 'browser', viewport: session.browserViewport });
    const peerReadyBrowser = createMessage(MSG_TYPES.PEER_READY, { sessionId: session.sessionId, role: 'phone' });

    try { session.phoneSocket.send(peerReadyPhone); } catch (_) {}
    try { session.browserSocket.send(peerReadyBrowser); } catch (_) {}
    console.log(`[PEER_READY] instanceId=${SERVER_INSTANCE_ID} sess=${session.sessionId.slice(-6)} phoneActive=${!!session.phoneSocket} browserActive=${!!session.browserSocket}`);
  }

  handleOffer(ws, msg) {
    const session = this.sessionStore.getSessionById(msg.sessionId);
    if (!session || session.browserSocket !== ws) {
      ws.send(createErrorMessage(ERROR_CODES.UNAUTHORIZED, 'Session not found or socket unauthorized', msg.messageId));
      return;
    }

    if (!msg.sdp || typeof msg.sdp !== 'string') {
      ws.send(createErrorMessage(ERROR_CODES.INVALID_MESSAGE_FORMAT, 'Missing or invalid SDP offer', msg.messageId));
      return;
    }

    if (!session.phoneSocket) {
      ws.send(createErrorMessage(ERROR_CODES.SESSION_NOT_FOUND, 'Phone is not connected to this session', msg.messageId));
      return;
    }

    console.log(`[OFFER_RECEIVED_FROM_BROWSER] instanceId=${SERVER_INSTANCE_ID} sess=${msg.sessionId.slice(-6)} sdpLen=${msg.sdp.length}`);
    session.phoneSocket.send(createMessage(MSG_TYPES.OFFER, {
      sessionId: session.sessionId,
      sdp: msg.sdp
    }));
    console.log(`[OFFER_FORWARDED_TO_PHONE] instanceId=${SERVER_INSTANCE_ID} sess=${msg.sessionId.slice(-6)} phoneActive=${!!session.phoneSocket}`);
  }

  handleAnswer(ws, msg) {
    const session = this.sessionStore.getSessionById(msg.sessionId);
    if (!session || session.phoneSocket !== ws) {
      ws.send(createErrorMessage(ERROR_CODES.UNAUTHORIZED, 'Session not found or socket unauthorized', msg.messageId));
      return;
    }

    if (!msg.sdp || typeof msg.sdp !== 'string') {
      ws.send(createErrorMessage(ERROR_CODES.INVALID_MESSAGE_FORMAT, 'Missing or invalid SDP answer', msg.messageId));
      return;
    }

    if (!session.browserSocket) {
      ws.send(createErrorMessage(ERROR_CODES.SESSION_NOT_FOUND, 'Browser is not connected to this session', msg.messageId));
      return;
    }

    console.log(`[ANSWER_RECEIVED_FROM_PHONE] instanceId=${SERVER_INSTANCE_ID} sess=${msg.sessionId.slice(-6)} sdpLen=${msg.sdp.length}`);
    session.browserSocket.send(createMessage(MSG_TYPES.ANSWER, {
      sessionId: session.sessionId,
      sdp: msg.sdp
    }));
    console.log(`[ANSWER_FORWARDED_TO_BROWSER] instanceId=${SERVER_INSTANCE_ID} sess=${msg.sessionId.slice(-6)} browserActive=${!!session.browserSocket}`);
  }

  handleCandidate(ws, msg) {
    const session = this.sessionStore.getSessionById(msg.sessionId);
    if (!session) {
      ws.send(createErrorMessage(ERROR_CODES.SESSION_NOT_FOUND, 'Session not found', msg.messageId));
      return;
    }

    const recipient = (session.phoneSocket === ws) ? session.browserSocket : (session.browserSocket === ws) ? session.phoneSocket : null;
    if (!recipient) {
      ws.send(createErrorMessage(ERROR_CODES.UNAUTHORIZED, 'Unauthorized or peer disconnected', msg.messageId));
      return;
    }

    if (!msg.candidate) {
      ws.send(createErrorMessage(ERROR_CODES.INVALID_MESSAGE_FORMAT, 'Missing ICE candidate', msg.messageId));
      return;
    }

    const fromRole = (session.browserSocket === ws) ? 'browser' : 'phone';
    const toRole = (session.phoneSocket === recipient) ? 'phone' : 'browser';
    console.log(`[ICE_FORWARDED] instanceId=${SERVER_INSTANCE_ID} sess=${msg.sessionId.slice(-6)} from=${fromRole} to=${toRole}`);

    recipient.send(createMessage(MSG_TYPES.CANDIDATE, {
      sessionId: session.sessionId,
      candidate: msg.candidate
    }));
  }

  handleReady(ws, msg) {
    const session = this.sessionStore.getSessionById(msg.sessionId);
    if (!session || (session.phoneSocket !== ws && session.browserSocket !== ws)) {
      throw { code: ERROR_CODES.UNAUTHORIZED, message: 'Unauthorized session' };
    }
    const recipient = (session.phoneSocket === ws) ? session.browserSocket : session.phoneSocket;
    if (recipient) {
      try { recipient.send(createMessage(MSG_TYPES.PEER_READY, { sessionId: session.sessionId, role: (session.phoneSocket === ws) ? 'phone' : 'browser', viewport: session.browserSocket === ws ? session.browserViewport : undefined })); } catch (_) {}
    }
  }

  handleClose(ws, msg) {
    const session = this.sessionStore.getSessionById(msg.sessionId);
    if (!session || (session.phoneSocket !== ws && session.browserSocket !== ws)) {
      throw { code: ERROR_CODES.UNAUTHORIZED, message: 'Unauthorized session' };
    }
    if (session) {
      this.sessionStore.closeSession(session.sessionId, msg.reason || 'Closed by peer');
    }
  }

  stop() {
    return new Promise(resolve => {
      clearInterval(this.livenessTimer); this.livenessTimer = null;
      this.sessionStore.destroy();
      for (const conn of this.connections) {
        try { conn.close(1001, 'Server shutting down'); } catch (_) {}
      }
      this.connections.clear();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

module.exports = UnifiedAppServer;
