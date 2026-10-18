'use strict';
// Real local sockets against the production entry (adapted from staging-network-test.cjs and
// split-staging-network-test.cjs): HTTP identity, assets, Origin policy, native registration,
// split media grant and legacy relay fallback.
const assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {ProductionServer}=require('./production-server.cjs'),Ws=require('./tools/signal-server/ws_frame.cjs');
const identity=require('./production-identity.json');
const clients=[];
function connect(port,urlPath='/ws',capability='',origin='https://app.karcast.app'){
 return new Promise((resolve,reject)=>{
  const headers={Host:'app.karcast.app',Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64')};
  if(origin){headers.Origin=origin;headers['Sec-WebSocket-Protocol']='karcast-v1'+(capability?', media_cap.'+capability:'');}
  else if(capability)headers['Sec-WebSocket-Protocol']='karcast-v1, media_cap.'+capability;
  const req=http.request({host:'127.0.0.1',port,path:urlPath,agent:false,headers});
  req.on('upgrade',(_,socket)=>{const ws=new Ws(socket);clients.push(ws);ws.messages=[];ws.binary=[];
   ws.on('message',s=>{ws.messages.push(JSON.parse(s));ws.emit('received');});
   ws.on('binary',b=>{ws.binary.push(b);ws.emit('received');});resolve(ws);});
  req.on('response',res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
 });
}
function wait(ws,predicate){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.removeListener('received',check);reject(new Error('Expected socket event missing'));},2000);
  function check(){const r=predicate();if(r){clearTimeout(timer);ws.removeListener('received',check);resolve(r);}}
  ws.on('received',check);check();
 });
}
const send=(ws,type,payload={})=>ws.send(JSON.stringify({version:'1.0',type,...payload}));
const packet=flags=>{const b=Buffer.alloc(18);b.set([75,67,1,flags]);b.writeBigUInt64BE(123456n,4);return b;};
function rawUpgrade(port,host,origin){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(port,'127.0.0.1');let bytes='';
  const timer=setTimeout(()=>{socket.destroy();reject(new Error('upgrade timeout'));},3000);
  socket.on('error',reject);socket.on('data',b=>{bytes+=b;if(bytes.includes('\r\n\r\n')){clearTimeout(timer);socket.destroy();resolve(bytes);}});
  socket.on('connect',()=>socket.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n${origin?`Origin: ${origin}\r\nSec-WebSocket-Protocol: karcast-v1\r\n`:''}\r\n`));
 });
}
(async()=>{
 const server=new ProductionServer({port:0});
 try{
  await server.start();const port=server.server.address().port;
  const get=(p,host='app.karcast.app',method='GET')=>new Promise((resolve,reject)=>{http.request({host:'127.0.0.1',port,path:p,method,headers:{Host:host}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts)}));}).on('error',reject).end();});
  assert.equal((await get('/health','staging.karcast.app')).status,421);
  assert.equal((await get('/','evil.example')).status,421);
  const health=await get('/health');assert.equal(health.status,200);
  const h=JSON.parse(health.body);
  assert.equal(h.service,'app.karcast.app');assert.equal(h.version,'1.0');assert.equal(h.signalingOwner,'app.karcast.app');
  assert.equal(h.browserBuild,identity.browserBuild);assert.equal(h.splitMedia,'ws-split-v1');
  assert.equal('staging' in h,false,'production health must not claim staging');
  assert.equal(health.headers['cache-control'],'no-store');
  for(const name of ['index.html','app.js','style.css','session-features.js','session-features.css','mic-uplink.js','split-media-client.js']){
   const r=await get('/'+name);assert.equal(r.status,200,name);
   assert.equal(r.body.equals(fs.readFileSync(path.join(__dirname,'public',name))),true,name+' bytes');
  }
  const root=await get('/');assert.equal(root.status,200);assert.match(root.headers['content-type'],/^text\/html/);
  for(const p of ['/p0-diagnostics.js','/p0a-signaling.js','/p0a-build-identity.json','/p0/events','/../server-core.js','/server-core.js','/package.json','/production-identity.json'])
   assert.equal((await get(p)).status,404,p);
  assert.equal((await get('/p0/events','app.karcast.app','POST')).status,405,'no diagnostic upload route');
  assert.equal((await get('/app.js','app.karcast.app','HEAD')).status,200);
  assert.match(await rawUpgrade(port,'app.karcast.app','https://evil.example'),/403 Forbidden/);
  assert.match(await rawUpgrade(port,'app.karcast.app','https://staging.karcast.app'),/403 Forbidden/);
  assert.match(await rawUpgrade(port,'staging.karcast.app',null),/^HTTP\/1\.1 4/);
  assert.match(await rawUpgrade(port,'app.karcast.app','https://app.karcast.app'),/101 Switching Protocols/);
  // Native phone (no Origin, as OkHttp in V68 and older builds) registers; browser pairs by code.
  const phone=await connect(port,'/ws','',null);send(phone,'register',{capabilities:['ws-split-v1']});
  const registered=await wait(phone,()=>phone.messages.find(m=>m.type==='registered'));
  assert.equal(await connect(port,'/ws/media'),403,'media without grant');
  const browser=await connect(port);send(browser,'join',{pairingCode:registered.pairingCode});
  const joined=await wait(browser,()=>browser.messages.find(m=>m.type==='joined'));assert(joined.capabilities.includes('ws-split-v1'));
  send(browser,'split_start',{sessionId:joined.sessionId});
  const pg=await wait(phone,()=>phone.messages.find(m=>m.type==='split_capability'));
  const bg=await wait(browser,()=>browser.messages.find(m=>m.type==='split_capability'));
  assert.equal(await connect(port,'/ws/media',bg.capability,'https://staging.karcast.app'),403,'staging Origin on media');
  const pm=await connect(port,'/ws/media',pg.capability,null),bm=await connect(port,'/ws/media',bg.capability);
  pm.sendBinary(packet(1));pm.sendBinary(packet(2));
  await wait(bm,()=>bm.binary.some(b=>b[3]===2));assert.equal(browser.binary.length,0,'binary absent from control');
  send(browser,'relay_touch',{sessionId:joined.sessionId,seq:1,action:'down',x:0.5,y:0.5});
  await wait(phone,()=>phone.messages.find(m=>m.type==='relay_touch'));
  // Legacy phone without split capability (older installed builds) still gets the relay path.
  const legacy=await connect(port,'/ws','',null);send(legacy,'register');
  const legacyReg=await wait(legacy,()=>legacy.messages.find(m=>m.type==='registered'));
  const legacyBrowser=await connect(port);send(legacyBrowser,'join',{pairingCode:legacyReg.pairingCode});
  const legacyJoined=await wait(legacyBrowser,()=>legacyBrowser.messages.find(m=>m.type==='joined'));
  assert.equal((legacyJoined.capabilities||[]).includes('ws-split-v1'),false);
  send(legacyBrowser,'relay_start',{sessionId:legacyJoined.sessionId});
  await wait(legacy,()=>legacy.messages.find(m=>m.type==='relay_start'));
  legacy.sendBinary(packet(1));legacy.sendBinary(packet(2));await wait(legacyBrowser,()=>legacyBrowser.binary.some(b=>b[3]===2));
  console.log('PASS production local sockets: host identity, exact assets, no P0 routes, Origin policy, native registration, split media, legacy relay');
 }finally{for(const c of clients)c.socket.destroy();await server.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
