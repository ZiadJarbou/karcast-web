'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const Server=require('./server-core'),Ws=require('./tools/signal-server/ws_frame.cjs');
const clients=[];
function connect(port,path='/ws',capability='',origin='https://app.karcast.app') {
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path,agent:false,headers:{Connection:'Upgrade',Upgrade:'websocket',
   Origin:origin,'Sec-WebSocket-Version':'13','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'),
   'Sec-WebSocket-Protocol':'karcast-v1'+(capability?', media_cap.'+capability:'')}});
  req.on('upgrade',(_,socket)=>{
   const ws=new Ws(socket);clients.push(ws);ws.messages=[];ws.binary=[];
   ws.on('message',s=>{ws.messages.push(JSON.parse(s));ws.emit('received');});
   ws.on('binary',b=>{ws.binary.push(b);ws.emit('received');});resolve(ws);
  });
  req.on('response',res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
 });
}
function wait(ws,predicate) {
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.removeListener('received',check);reject(new Error('Expected socket event missing'));},2000);
  function check(){const result=predicate();if(result){clearTimeout(timer);ws.removeListener('received',check);resolve(result);}}
  ws.on('received',check);check();
 });
}
const send=(ws,type,payload={})=>ws.send(JSON.stringify({version:'1.0',type,...payload}));
const packet=flags=>{const b=Buffer.alloc(18);b.set([75,67,1,flags]);b.writeBigUInt64BE(123456n,4);return b;};
(async()=>{
 const server=new Server();server.port=0;
 try {
  await server.start();const port=server.server.address().port;
  assert.equal(await connect(port,'/ws/media'),403);
  const phone=await connect(port);send(phone,'register',{capabilities:['ws-split-v1']});
  const registered=await wait(phone,()=>phone.messages.find(m=>m.type==='registered'));
  const browser=await connect(port);send(browser,'join',{pairingCode:registered.pairingCode});
  const joined=await wait(browser,()=>browser.messages.find(m=>m.type==='joined'));assert(joined.capabilities.includes('ws-split-v1'));
  send(browser,'split_start',{sessionId:joined.sessionId});
  const pg=await wait(phone,()=>phone.messages.find(m=>m.type==='split_capability'));
  const bg=await wait(browser,()=>browser.messages.find(m=>m.type==='split_capability'));
  assert.equal(await connect(port,'/ws/media',bg.capability,'https://evil.invalid'),403);
  assert.equal(await connect(port,'/ws/media',bg.capability,'invalid-origin'),403);
  const pm=await connect(port,'/ws/media',pg.capability),bm=await connect(port,'/ws/media',bg.capability);
  assert.equal(await connect(port,'/ws/media',bg.capability),403,'replayed handshake');
  pm.sendBinary(packet(1));pm.sendBinary(packet(2));
  await wait(bm,()=>bm.binary.some(b=>b[3]===2));assert.equal(browser.binary.length,0,'binary absent from control');
  assert.equal(bm.binary.at(-1).readBigUInt64BE(4),123456n,'original source time preserved');
  send(browser,'relay_touch',{sessionId:joined.sessionId,seq:1,action:'down',x:0.5,y:0.5});
  await wait(phone,()=>phone.messages.find(m=>m.type==='relay_touch'));
  const oldCount=bm.binary.length;phone.sendBinary(packet(2));
  send(phone,'heartbeat');await wait(phone,()=>phone.messages.find(m=>m.type==='heartbeat'));
  assert.equal(bm.binary.length,oldCount,'control cannot be used as split media writer');
  bm.close();browser.messages=[];send(browser,'split_reconnect',{sessionId:joined.sessionId});
  const regrant=await wait(browser,()=>browser.messages.find(m=>m.type==='split_capability'));
  const bm2=await connect(port,'/ws/media',regrant.capability);
  pm.sendBinary(packet(1));pm.sendBinary(packet(2));await wait(bm2,()=>bm2.binary.some(b=>b[3]===2));
  assert.equal(server.sessionStore.getSessionById(joined.sessionId).phoneSocket.splitMediaCapable,true);
  send(browser,'relay_start',{sessionId:joined.sessionId});
  await wait(phone,()=>phone.messages.find(m=>m.type==='relay_start'));
  phone.sendBinary(packet(1));phone.sendBinary(packet(2));await wait(browser,()=>browser.binary.some(b=>b[3]===2));
  console.log('PASS real local sockets: trusted Origin, authenticated upgrades, role grants, KC timestamp, separate control, media-only reconnect, legacy fallback');
 } finally {
  for(const c of clients)c.socket.destroy();await server.stop();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
