'use strict';

/**
 * KarCast Public Signaling Relay Protocol Specification (v1.0)
 *
 * This versioned JSON protocol is used exclusively for orchestration,
 * session discovery, pairing, and WebRTC SDP/ICE exchange between
 * the Android Phone app and the vehicle browser (app.karcast.app).
 *
 * MEDIA AND TOUCH TRAFFIC ARE NEVER PROXIED THROUGH THIS SERVICE.
 */

const PROTOCOL_VERSION = '1.0';
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB

const MSG_TYPES = {
  // Phone -> Server
  REGISTER: 'register',
  ANSWER: 'answer',

  // Browser -> Server
  JOIN: 'join',
  OFFER: 'offer',

  // Both -> Server
  CANDIDATE: 'candidate',
  READY: 'ready',
  CLOSE: 'close',
  HEARTBEAT: 'heartbeat',

  // Server -> Clients
  REGISTERED: 'registered',
  JOINED: 'joined',
  PEER_READY: 'peer_ready',
  EXPIRED: 'expired',
  CLOSED: 'closed',
  ERROR: 'error'
};

const ERROR_CODES = {
  INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT',
  UNKNOWN_MESSAGE_TYPE: 'UNKNOWN_MESSAGE_TYPE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  PAIRING_CODE_INVALID: 'PAIRING_CODE_INVALID',
  PAIRING_CODE_EXPIRED: 'PAIRING_CODE_EXPIRED',
  SESSION_ALREADY_PAIRED: 'SESSION_ALREADY_PAIRED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function createMessage(type, payload = {}) {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    type,
    messageId: 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    ...payload
  });
}

function createErrorMessage(code, message, originalMessageId = null) {
  return createMessage(MSG_TYPES.ERROR, {
    code,
    message,
    ...(originalMessageId ? { replyToMessageId: originalMessageId } : {})
  });
}

function parseAndValidateMessage(rawText) {
  if (typeof rawText !== 'string') {
    throw { code: ERROR_CODES.INVALID_MESSAGE_FORMAT, message: 'Message payload must be a string' };
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw { code: ERROR_CODES.PAYLOAD_TOO_LARGE, message: 'Message payload exceeds 64 KB limit' };
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    throw { code: ERROR_CODES.INVALID_MESSAGE_FORMAT, message: 'Invalid JSON payload' };
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw { code: ERROR_CODES.INVALID_MESSAGE_FORMAT, message: 'JSON payload must be an object' };
  }

  if (json.version !== PROTOCOL_VERSION) {
    throw { code: ERROR_CODES.INVALID_MESSAGE_FORMAT, message: `Unsupported protocol version: ${json.version}` };
  }

  if (typeof json.type !== 'string' || !Object.values(MSG_TYPES).includes(json.type)) {
    throw { code: ERROR_CODES.UNKNOWN_MESSAGE_TYPE, message: `Unknown or missing message type: ${json.type}` };
  }

  return json;
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_PAYLOAD_BYTES,
  MSG_TYPES,
  ERROR_CODES,
  createMessage,
  createErrorMessage,
  parseAndValidateMessage
};
