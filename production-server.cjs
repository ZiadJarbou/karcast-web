'use strict';
// Production entry for app.karcast.app. Mirrors staging-server.cjs (same server-core,
// same /ws + /ws/media upgrade boundary) without the P0 DiagnosticStore or P0 assets.
// V85 (CR-20261022-TAADA-STYLE-PLAY-RELEASE B/D/F): V82 page (i18n.js), /car + bare-URL car link that follows
// the car-identity status, and the public car-identity API (car-identity.cjs).
const path=require('node:path'), fs=require('node:fs');
const UnifiedAppServer=require('./server-core.js');
const {PROTOCOL_VERSION}=require('./tools/signal-server/protocol.cjs');
const {CarIdentityService}=require('./car-identity.cjs');
const HOST='app.karcast.app', ORIGIN=`https://${HOST}`;
const BUILD=require('./production-identity.json');
const ASSETS=new Set(['index.html','app.js','style.css','session-features.js','session-features.css','mic-uplink.js','split-media-client.js','i18n.js']);
// Same validated parameters as staging V83/V84; the page and app.js are unchanged.
// V85 M1: fallback=relay lets the page reach the phone over the internet if its local address is lost.
const CAR_LINK='/?signal=wss%3A%2F%2Fcar.karcast.app%3A8443%2Fws&transport=relay&present=latest&fallback=relay';
// Revoked identity: the car uses the internet relay (CR D) until phones have a new identity.
const RELAY_LINK='/?transport=relay';
const MAX_BODY=32768;
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
/** Car link for the current identity status: anything but "revoked" keeps the validated local link. */
const carLinkFor=status=>status==='revoked'?RELAY_LINK:CAR_LINK;
function readJson(req){
 return new Promise((resolve)=>{
  if(!(req.headers['content-type']||'').startsWith('application/json')){resolve(undefined);return;}
  let size=0;const parts=[];
  req.on('data',d=>{size+=d.length;if(size>MAX_BODY){resolve(undefined);req.destroy();}else parts.push(d);});
  req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch(_){resolve(undefined);}});
  req.on('error',()=>resolve(undefined));
 });
}
class ProductionServer extends UnifiedAppServer {
 constructor(options={}){
  super({...options,allowedOrigins:[ORIGIN],validateUpgrade});
  this.carIdentity=options.carIdentity||new CarIdentityService();
 }
 async handleHttpRequest(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!hostAllowed(req)){res.writeHead(421);res.end();return;}
  let url;try{url=new URL(req.url,ORIGIN);}catch(_){res.writeHead(400);res.end();return;}
  if(url.pathname.startsWith('/api/v1/car-identity')){await this.handleCarIdentity(req,res,url);return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  if(url.pathname==='/health'){
   res.setHeader('Content-Type','application/json');
   res.end(req.method==='HEAD'?'':JSON.stringify({status:'ok',service:HOST,version:PROTOCOL_VERSION,browserBuild:BUILD.browserBuild,browserRevision:BUILD.browserRevision,carLink:'v85-1',carIdentity:this.carIdentity.knownStatus(),splitMedia:'ws-split-v1',signalingOwner:HOST,relay:'bounded-owned-v52-write-age1',relayAdmission:this.relayFreshness.snapshot()}));return;
  }
  if(url.pathname==='/car'||url.pathname==='/car/'||(url.pathname==='/'&&!url.search)){
   const status=(await this.carIdentity.status())?.status||null;
   res.writeHead(302,{Location:carLinkFor(status)});res.end();return;
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
 async handleCarIdentity(req,res,url){
  res.setHeader('Content-Type','application/json');
  const send=(code,body)=>{res.writeHead(code);res.end(JSON.stringify(body));};
  if(url.pathname==='/api/v1/car-identity/status'&&req.method==='GET'){
   const s=await this.carIdentity.status();send(s?200:503,s||{error:'status_unavailable'});return;
  }
  if(req.method!=='POST'||!['/api/v1/car-identity','/api/v1/car-identity/challenge'].includes(url.pathname)){send(404,{error:'not_found'});return;}
  const body=await readJson(req);
  if(body===undefined){send(400,{error:'json'});return;}
  const [code,out]=url.pathname.endsWith('/challenge')?this.carIdentity.challenge(body)
   :await this.carIdentity.identity(body,req.socket?.remoteAddress||'');
  send(code,out);
 }
}
module.exports={ProductionServer,validateUpgrade,HOST,ASSETS,CAR_LINK,RELAY_LINK,carLinkFor};
