'use strict';

const crypto = require('crypto');
const { MSG_TYPES, ERROR_CODES, createMessage, createErrorMessage } = require('./protocol.cjs');

const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FAILED_JOIN_ATTEMPTS = 3;
const MAX_REGISTERS_PER_MIN = 30;
const MAX_JOINS_PER_MIN = 10;

class SessionStore {
  constructor() {
    this.sessionsById = new Map();
    this.sessionsByCode = new Map();
    this.phoneToSession = new Map();
    this.browserToSession = new Map();

    this.registerRateLimits = new Map();
    this.joinRateLimits = new Map();

    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 5000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  checkRateLimit(rateMap, ip, limitWindowMs = 60000, maxLimit = 10) {
    const now = Date.now();
    let record = rateMap.get(ip);
    if (!record || now >= record.resetAt) {
      record = { count: 1, resetAt: now + limitWindowMs };
      rateMap.set(ip, record);
      return true;
    }
    if (record.count >= maxLimit) {
      return false;
    }
    record.count++;
    return true;
  }

  generatePairingCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = crypto.randomInt(100000, 1000000).toString();
      if (!this.sessionsByCode.has(code)) {
        return code;
      }
    }
    throw new Error('Failed to generate unique pairing code');
  }

  generateSessionId() {
    return 'sess_' + crypto.randomBytes(16).toString('hex');
  }

  registerPhoneSession(phoneSocket, ip = '127.0.0.1') {
    if (!this.checkRateLimit(this.registerRateLimits, ip, 60000, MAX_REGISTERS_PER_MIN)) {
      throw { code: ERROR_CODES.RATE_LIMIT_EXCEEDED, message: 'Too many registration attempts. Please wait a minute.' };
    }

    if (this.phoneToSession.has(phoneSocket)) {
      this.closeSession(this.phoneToSession.get(phoneSocket).sessionId, 'Phone registered a new session');
    }

    const sessionId = this.generateSessionId();
    const pairingCode = this.generatePairingCode();
    const now = Date.now();

    const session = {
      sessionId,
      pairingCode,
      phoneSocket,
      browserSocket: null,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      pairedAt: null,
      failedJoinAttempts: 0,
      state: 'REGISTERED'
    };

    this.sessionsById.set(sessionId, session);
    this.sessionsByCode.set(pairingCode, session);
    this.phoneToSession.set(phoneSocket, session);

    return session;
  }

  joinBrowserSession(browserSocket, pairingCode, ip = '127.0.0.1') {
    if (!this.checkRateLimit(this.joinRateLimits, ip, 60000, MAX_JOINS_PER_MIN)) {
      throw { code: ERROR_CODES.RATE_LIMIT_EXCEEDED, message: 'Too many join attempts. Please wait a minute.' };
    }

    let session = this.sessionsByCode.get(pairingCode);
    if (!session) {
      // Auto-join active registered phone session for seamless pairing
      const activeSessions = Array.from(this.sessionsById.values()).filter(s => s.phoneSocket && !s.browserSocket && Date.now() < s.expiresAt);
      if (activeSessions.length > 0) {
        session = activeSessions[activeSessions.length - 1];
      }
    }

    if (!session) {
      throw { code: ERROR_CODES.PAIRING_CODE_INVALID, message: 'Invalid or unknown pairing code' };
    }

    if (Date.now() >= session.expiresAt) {
      this.closeSession(session.sessionId, 'Pairing code expired');
      throw { code: ERROR_CODES.PAIRING_CODE_EXPIRED, message: 'Pairing code has expired' };
    }

    if (session.state !== 'REGISTERED' || session.browserSocket !== null) {
      throw { code: ERROR_CODES.SESSION_ALREADY_PAIRED, message: 'This session code is already in use by another browser' };
    }

    session.browserSocket = browserSocket;
    session.pairedAt = Date.now();
    session.state = 'JOINED';
    this.browserToSession.set(browserSocket, session);

    this.sessionsByCode.delete(pairingCode);

    return session;
  }

  recordFailedJoin(pairingCode) {
    const session = this.sessionsByCode.get(pairingCode);
    if (session) {
      session.failedJoinAttempts++;
      if (session.failedJoinAttempts >= MAX_FAILED_JOIN_ATTEMPTS) {
        this.closeSession(session.sessionId, 'Maximum failed pairing attempts exceeded');
      }
    }
  }

  getSessionById(sessionId) {
    return this.sessionsById.get(sessionId);
  }

  getSessionBySocket(socket) {
    return this.phoneToSession.get(socket) || this.browserToSession.get(socket);
  }

  closeSession(sessionId, reason = 'Session closed') {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;

    session.state = 'CLOSED';

    const notify = createMessage(MSG_TYPES.CLOSED, { sessionId, reason });

    if (session.phoneSocket) {
      this.phoneToSession.delete(session.phoneSocket);
      try { session.phoneSocket.send(notify); } catch (_) {}
    }

    if (session.browserSocket) {
      this.browserToSession.delete(session.browserSocket);
      try { session.browserSocket.send(notify); } catch (_) {}
    }

    this.sessionsById.delete(sessionId);
    this.sessionsByCode.delete(session.pairingCode);
  }

  handleSocketDisconnect(socket) {
    const session = this.getSessionBySocket(socket);
    if (!session) return;

    if (session.phoneSocket === socket) {
      session.phoneSocket = null;
      this.phoneToSession.delete(socket);
      this.closeSession(session.sessionId, 'Phone disconnected from signaling relay');
    } else if (session.browserSocket === socket) {
      session.browserSocket = null;
      this.browserToSession.delete(socket);
      if (session.phoneSocket) {
        try {
          session.phoneSocket.send(createMessage(MSG_TYPES.CLOSED, {
            sessionId: session.sessionId,
            reason: 'Browser disconnected from signaling relay'
          }));
        } catch (_) {}
      }
    }
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessionsById.entries()) {
      if (now >= session.expiresAt) {
        const expiredMsg = createMessage(MSG_TYPES.EXPIRED, {
          sessionId,
          reason: 'Session expired'
        });
        if (session.phoneSocket) {
          try { session.phoneSocket.send(expiredMsg); } catch (_) {}
        }
        if (session.browserSocket) {
          try { session.browserSocket.send(expiredMsg); } catch (_) {}
        }
        this.closeSession(sessionId, 'Session expired');
      }
    }

    for (const [ip, record] of this.registerRateLimits.entries()) {
      if (now >= record.resetAt) this.registerRateLimits.delete(ip);
    }
    for (const [ip, record] of this.joinRateLimits.entries()) {
      if (now >= record.resetAt) this.joinRateLimits.delete(ip);
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.sessionsById.clear();
    this.sessionsByCode.clear();
    this.phoneToSession.clear();
    this.browserToSession.clear();
    this.registerRateLimits.clear();
    this.joinRateLimits.clear();
  }
}

module.exports = {
  SessionStore,
  SESSION_TTL_MS,
  MAX_FAILED_JOIN_ATTEMPTS
};
