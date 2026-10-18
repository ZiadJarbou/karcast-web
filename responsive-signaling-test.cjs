'use strict';
const assert=require('node:assert/strict'),Server=require('./server-core.js');
const server=new Server();
const socket=()=>({messages:[],send(text){this.messages.push(JSON.parse(text));},close(){}});
try {
 for(const viewport of [{schema:2,width:768,height:1024,token:'secret'},undefined,
     {schema:2,width:5000,height:900},{schema:2,width:800.5,height:900}]) {
  const phone=socket(),browser=socket(),session=server.sessionStore.registerPhoneSession(phone);
  server.handleJoin(browser,{pairingCode:session.pairingCode,viewport,messageId:'test'},'127.0.0.1');
  const ready=phone.messages.find(m=>m.type==='peer_ready'); assert(ready);
  if(viewport?.width===768) assert.deepEqual(ready.viewport,{schema:2,width:768,height:1024});
  else assert.equal(ready.viewport,undefined);
  assert(!JSON.stringify(ready).includes('secret'));
  const intruder=socket();
  assert.throws(()=>server.handleReady(intruder,{sessionId:session.sessionId,viewport:{schema:2,width:1280,height:720}}));
  const count=phone.messages.length;
  server.handleJoin(intruder,{pairingCode:'000000',viewport:{schema:2,width:1280,height:720}},'127.0.0.1');
  assert.equal(phone.messages.length,count,'Unauthenticated viewport never reaches phone');
  server.sessionStore.closeSession(session.sessionId,'test complete');
 }
 console.log('PASS authenticated JOIN viewport whitelist, legacy fallback and unauthorized controller rejection');
} finally {server.sessionStore.destroy();server.relayFreshness.close?.();}
