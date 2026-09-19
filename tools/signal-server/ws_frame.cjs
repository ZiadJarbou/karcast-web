'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    this.on('error', () => {}); // Prevent unhandled error crashes on TCP reset during teardown

    socket.on('data', chunk => this.handleData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', err => {
      this.emit('error', err);
      this.handleClose();
    });
  }

  static performHandshake(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return null;
    }

    const digest = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${digest}`,
      '\r\n'
    ].join('\r\n');

    socket.write(responseHeaders);
    return new WsSocket(socket);
  }

  send(text) {
    if (this.closed || !this.socket.writable) return;

    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;

    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {
      this.handleClose();
    }
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];

      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;

      let headerOffset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        headerOffset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(128 * 1024)) {
          this.close(1009, 'Payload too large');
          return;
        }
        payloadLen = Number(bigLen);
        headerOffset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < headerOffset + 4) return;
        maskKey = this.buffer.slice(headerOffset, headerOffset + 4);
        headerOffset += 4;
      }

      const totalFrameLen = headerOffset + payloadLen;
      if (this.buffer.length < totalFrameLen) return;

      const frameData = this.buffer.slice(headerOffset, totalFrameLen);
      this.buffer = this.buffer.slice(totalFrameLen);

      if (masked && maskKey) {
        for (let i = 0; i < frameData.length; i++) {
          frameData[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        this.handleClose();
        return;
      } else if (opcode === 0x9) {
        this.sendPong(frameData);
      } else if (opcode === 0x1) {
        this.emit('message', frameData.toString('utf8'));
      }
    }
  }

  sendPong(payload) {
    if (this.closed || !this.socket.writable) return;
    const header = Buffer.alloc(2);
    header[0] = 0x8a;
    header[1] = payload.length;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {}
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      const header = Buffer.alloc(2);
      header[0] = 0x88;
      header[1] = payload.length;
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {}
    try { this.socket.end(); } catch (_) {}
    this.emit('close');
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

module.exports = WsSocket;
