'use strict';

/**
 * Unified Node.js Server for app.karcast.app
 * Hostinger Production Application Entry Point
 *
 * Combines:
 * - Public Vehicle Browser Web Frontend (GET /)
 * - Public WebSocket Signaling Relay (WSS /ws)
 * - Application Health Endpoint (GET /health)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WsSocket = require('./tools/signal-server/ws_frame.cjs');
const { SessionStore } = require('./tools/signal-server/session_store.cjs');
const {
  PROTOCOL_VERSION,
  MSG_TYPES,
  ERROR_CODES,
  createMessage,
  createErrorMessage,
  parseAndValidateMessage
} = require('./tools/signal-server/protocol.cjs');

const PORT = Number(process.env.PORT) || 8090;
const PUBLIC_DIR = path.join(__dirname, 'public');

class UnifiedAppServer {
  constructor(options = {}) {
    this.port = options.port || PORT;
    this.sessionStore = new SessionStore();
    this.server = null;
    this.connections = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

      this.server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname !== '/ws' && url.pathname !== '/') {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        // Browser Origin Validation for WebSocket Connections
        const origin = req.headers['origin'];
        if (origin) {
          const originHost = new URL(origin).host.toLowerCase();
          const allowedHosts = ['app.karcast.app', 'localhost', '127.0.0.1'];
          const allowed = allowedHosts.some(allowedHost =>
            originHost === allowedHost || originHost.startsWith(allowedHost + ':')
          );
          if (!allowed) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        const ws = WsSocket.performHandshake(req, socket);
        if (!ws) return;

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                         req.socket.remoteAddress || '127.0.0.1';

        this.connections.add(ws);

        ws.on('message', text => this.handleWsMessage(ws, text, clientIp));
        ws.on('close', () => {
          this.connections.delete(ws);
          this.sessionStore.handleSocketDisconnect(ws);
        });
      });

      this.server.listen(this.port, () => {
        resolve(this.port);
      });

      this.server.on('error', err => reject(err));
    });
  }

  handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    // Health Check Endpoint
    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        service: 'app.karcast.app',
        version: PROTOCOL_VERSION,
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

        default:
          ws.send(createErrorMessage(ERROR_CODES.UNKNOWN_MESSAGE_TYPE, `Unsupported message type: ${msg.type}`, msg.messageId));
      }
    } catch (err) {
      ws.send(createErrorMessage(err.code || ERROR_CODES.INTERNAL_ERROR, err.message || 'Error processing request', msg.messageId));
    }
  }

  handleRegister(ws, msg, clientIp) {
    const session = this.sessionStore.registerPhoneSession(ws, clientIp);
    ws.send(createMessage(MSG_TYPES.REGISTERED, {
      sessionId: session.sessionId,
      pairingCode: session.pairingCode,
      expiresAt: session.expiresAt,
      replyToMessageId: msg.messageId
    }));
  }

  handleJoin(ws, msg, clientIp) {
    const pairingCode = String(msg.pairingCode || '').trim();
    if (!pairingCode) {
      ws.send(createErrorMessage(ERROR_CODES.PAIRING_CODE_INVALID, 'Missing pairing code', msg.messageId));
      return;
    }

    let session;
    try {
      session = this.sessionStore.joinBrowserSession(ws, pairingCode, clientIp);
    } catch (err) {
      this.sessionStore.recordFailedJoin(pairingCode);
      ws.send(createErrorMessage(err.code || ERROR_CODES.PAIRING_CODE_INVALID, err.message || 'Failed to join session', msg.messageId));
      return;
    }

    ws.send(createMessage(MSG_TYPES.JOINED, {
      sessionId: session.sessionId,
      replyToMessageId: msg.messageId
    }));

    const peerReadyPhone = createMessage(MSG_TYPES.PEER_READY, { sessionId: session.sessionId, role: 'browser' });
    const peerReadyBrowser = createMessage(MSG_TYPES.PEER_READY, { sessionId: session.sessionId, role: 'phone' });

    try { session.phoneSocket.send(peerReadyPhone); } catch (_) {}
    try { session.browserSocket.send(peerReadyBrowser); } catch (_) {}
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

    session.phoneSocket.send(createMessage(MSG_TYPES.OFFER, {
      sessionId: session.sessionId,
      sdp: msg.sdp
    }));
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

    session.browserSocket.send(createMessage(MSG_TYPES.ANSWER, {
      sessionId: session.sessionId,
      sdp: msg.sdp
    }));
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

    recipient.send(createMessage(MSG_TYPES.CANDIDATE, {
      sessionId: session.sessionId,
      candidate: msg.candidate
    }));
  }

  handleReady(ws, msg) {
    const session = this.sessionStore.getSessionById(msg.sessionId);
    if (!session) return;
    const recipient = (session.phoneSocket === ws) ? session.browserSocket : session.phoneSocket;
    if (recipient) {
      try { recipient.send(createMessage(MSG_TYPES.PEER_READY, { sessionId: session.sessionId, role: (session.phoneSocket === ws) ? 'phone' : 'browser' })); } catch (_) {}
    }
  }

  handleClose(ws, msg) {
    const session = this.sessionStore.getSessionById(msg.sessionId);
    if (session) {
      this.sessionStore.closeSession(session.sessionId, msg.reason || 'Closed by peer');
    }
  }

  stop() {
    return new Promise(resolve => {
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

if (require.main === module) {
  const server = new UnifiedAppServer();
  server.start().then(port => {
    console.log(`Unified app.karcast.app application (v${PROTOCOL_VERSION}) listening on http/ws port ${port}`);
  }).catch(err => {
    console.error('Failed to start app.karcast.app server:', err);
    process.exit(1);
  });
}

module.exports = UnifiedAppServer;
