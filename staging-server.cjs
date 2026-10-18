'use strict';
const path=require('node:path'), fs=require('node:fs');
const UnifiedAppServer=require('./server-core.js');
const {DiagnosticStore}=require('./diagnostic-store.cjs');
const HOST='staging.karcast.app', ORIGIN=`https://${HOST}`;
const ASSETS=new Set(['index.html','app.js','p0-diagnostics.js','p0a-signaling.js','p0a-build-identity.json','style.css','session-features.js','session-features.css','mic-uplink.js','split-media-client.js']);
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
class StagingServer extends UnifiedAppServer {
 constructor(options={}){
  super({...options,allowedOrigins:[ORIGIN],validateUpgrade});
  this.diagnosticStore=new DiagnosticStore(options.evidenceDirectory||path.join(__dirname,'p0-evidence-isolated-v50'));
 }
 async handleHttpRequest(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!hostAllowed(req)){res.writeHead(421);res.end();return;}
  let url;try{url=new URL(req.url,ORIGIN);}catch(_){res.writeHead(400);res.end();return;}
  try{if(await this.diagnosticStore.route(req,res,url))return;}catch(_){res.writeHead(503);res.end('{}');return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  if(url.pathname==='/health'){
   res.setHeader('Content-Type','application/json');
   res.end(req.method==='HEAD'?'':JSON.stringify({status:'ok',staging:true,browserBuild:'fieldlog-v69-startup1-20261018-01',splitMedia:'ws-split-v1',signalingOwner:HOST,relay:'bounded-owned-v52-write-age1',relayAdmission:this.relayFreshness.snapshot()}));return;
  }
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!ASSETS.has(name)){res.writeHead(404);res.end();return;}
  try{
   const bytes=fs.readFileSync(path.join(__dirname,'public',name));
   const mime=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':'application/javascript';
   res.setHeader('Content-Type',mime+'; charset=utf-8');res.setHeader('Content-Length',bytes.length);
   res.end(req.method==='HEAD'?undefined:bytes);
  }catch(_){res.writeHead(503);res.end();}
 }
 async stop(){await super.stop();await this.diagnosticStore.close();}
}
module.exports={StagingServer,validateUpgrade};
