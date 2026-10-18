'use strict';
// Deployment adapter only. No KarCast protocol, session store, or recovery logic.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DiagnosticStore}=require('./diagnostic-store.cjs');
const HOST = 'staging.karcast.app';
const ORIGIN = `https://${HOST}`;
const TYPES = {'index.html':'text/html', 'app.js':'application/javascript',
  'p0-diagnostics.js':'application/javascript', 'p0a-signaling.js':'application/javascript', 'p0a-build-identity.json':'application/json', 'style.css':'text/css', 'session-features.js':'application/javascript', 'session-features.css':'text/css', 'mic-uplink.js':'application/javascript'};
const hostAllowed = req => (req.headers.host || '').toLowerCase().split(':')[0] === HOST;
function createServer() {
  const diagnosticStore=new DiagnosticStore(path.join(__dirname,'p0-evidence'));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (!hostAllowed(req)) { res.writeHead(421); res.end(); return; }
    let url; try { url = new URL(req.url, ORIGIN); } catch (_) { res.writeHead(400); res.end(); return; }
    try { if (await diagnosticStore.route(req,res,url)) return; } catch (_) { res.writeHead(503);res.end('{}');return; }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/health') {
      res.setHeader('Content-Type','application/json');
      res.end(req.method === 'HEAD' ? '' : JSON.stringify({status:'ok',staging:true})); return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!Object.hasOwn(TYPES,name)) { res.writeHead(404); res.end(); return; }
    try {
      const bytes = fs.readFileSync(path.join(__dirname,'public',name));
      res.setHeader('Content-Type',TYPES[name]+'; charset=utf-8');
      res.setHeader('Content-Length',bytes.length);
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (_) { res.writeHead(503); res.end(); }
  });
  server.on('upgrade',(req,socket,head) => {
    const reject = code => socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const key = req.headers['sec-websocket-key'];
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(p=>p.trim());
    if (!hostAllowed(req) || req.headers.origin !== ORIGIN) { reject('403 Forbidden'); return; }
    if (req.method !== 'GET' || req.url !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(key) || !protocols.includes('karcast-v1') ||
        protocols.some(p=>p!=='karcast-v1' && !/^pair_token\.[a-f0-9]{64}$/.test(p))) {
      reject('400 Bad Request'); return;
    }
    socket.pause();
    // Explicitly reviewed origin translation, pinned upstream; never an open proxy.
    const upstream = https.request({hostname:'app.karcast.app',port:443,path:'/ws',method:'GET',headers:{
      Host:'app.karcast.app',Origin:'https://app.karcast.app',Connection:'Upgrade',Upgrade:'websocket',
      'Sec-WebSocket-Version':'13','Sec-WebSocket-Key':key,'Sec-WebSocket-Protocol':protocols.join(', ')
    }});
    socket.on('error',()=>upstream.destroy());
    socket.on('close',()=>upstream.destroy());
    upstream.on('error',()=>{ if (!socket.destroyed) reject('502 Bad Gateway'); });
    upstream.setTimeout(15000,()=>upstream.destroy(new Error('Upstream handshake timeout')));
    upstream.on('response',res=>{ res.resume(); reject('502 Bad Gateway'); });
    upstream.on('upgrade',(res,remote,upstreamHead)=>{
      const expected=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== expected ||
          res.headers['sec-websocket-protocol'] !== 'karcast-v1' || socket.destroyed) {
        remote.destroy(); if (!socket.destroyed) reject('502 Bad Gateway'); return;
      }
      remote.setTimeout(0); // No gateway inactivity or reconnect policy after upgrade.
      remote.on('error',()=>socket.destroy()); remote.on('close',()=>socket.destroy());
      socket.on('error',()=>remote.destroy()); socket.on('close',()=>remote.destroy());
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'+
        `Sec-WebSocket-Accept: ${expected}\r\nSec-WebSocket-Protocol: karcast-v1\r\n\r\n`);
      if (head.length) remote.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      // Stream piping uses Node backpressure; no payload parsing, storage, or logging.
      socket.pipe(remote); remote.pipe(socket); socket.resume();
    });
    upstream.end();
  });
  server.on('close',()=>{diagnosticStore.close().catch(()=>{});});
  return server;
}
module.exports = {createServer};
