'use strict';
// Production entry for app.karcast.app. Mirrors staging-server.cjs (same server-core,
// same /ws + /ws/media upgrade boundary) without the P0 DiagnosticStore or P0 assets.
const path=require('node:path'), fs=require('node:fs');
const UnifiedAppServer=require('./server-core.js');
const {PROTOCOL_VERSION}=require('./tools/signal-server/protocol.cjs');
const HOST='app.karcast.app', ORIGIN=`https://${HOST}`;
const BUILD=require('./production-identity.json');
const ASSETS=new Set(['index.html','app.js','style.css','session-features.js','session-features.css','mic-uplink.js','split-media-client.js']);
const hostAllowed=req=>(req.headers.host||'').toLowerCase().split(':')[0]===HOST;
function validateUpgrade(req){
 const key=req.headers['sec-websocket-key'];
 const protocols=(req.headers['sec-websocket-protocol']||'').split(',').map(p=>p.trim()).filter(Boolean);
 const browser=Boolean(req.headers.origin);
 return hostAllowed(req)&&(!browser||req.headers.origin===ORIGIN)&&req.method==='GET'&&['/ws','/ws/media'].includes(req.url)&&
  req.headers.upgrade?.toLowerCase()==='websocket'&&req.headers['sec-websocket-version']==='13'&&
  typeof key==='string'&&/^[A-Za-z0-9+/]{22}==$/.test(key)&&
  (!browser||protocols.includes('karcast-v1'))&&
  protocols.every(p=>p==='karcast-v1'||(req.url==='/ws'?/^pair_token\.[a-f0-9]{64}$/:/^media_cap\.[a-f0-9]{64}$/).test(p));
}
class ProductionServer extends UnifiedAppServer {
 constructor(options={}){
  super({...options,allowedOrigins:[ORIGIN],validateUpgrade});
 }
 async handleHttpRequest(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!hostAllowed(req)){res.writeHead(421);res.end();return;}
  let url;try{url=new URL(req.url,ORIGIN);}catch(_){res.writeHead(400);res.end();return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  if(url.pathname==='/health'){
   res.setHeader('Content-Type','application/json');
   res.end(req.method==='HEAD'?'':JSON.stringify({status:'ok',service:HOST,version:PROTOCOL_VERSION,browserBuild:BUILD.browserBuild,browserRevision:BUILD.browserRevision,splitMedia:'ws-split-v1',signalingOwner:HOST,relay:'bounded-owned-v52-write-age1',relayAdmission:this.relayFreshness.snapshot()}));return;
  }
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!ASSETS.has(name)){res.writeHead(404);res.end();return;}
  try{
   const bytes=fs.readFileSync(path.join(__dirname,'public',name));
   const mime=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'application/javascript';
   res.setHeader('Content-Type',mime+'; charset=utf-8');res.setHeader('Content-Length',bytes.length);
   res.end(req.method==='HEAD'?undefined:bytes);
  }catch(_){res.writeHead(503);res.end();}
 }
}
module.exports={ProductionServer,validateUpgrade,HOST,ASSETS};
