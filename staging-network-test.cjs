'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),os=require('node:os'),path=require('node:path');
const {StagingServer}=require('./staging-server.cjs');
async function run(){
 const server=new StagingServer({port:0,evidenceDirectory:path.join(os.tmpdir(),'karcast-staging-test-'+Date.now())});
 await server.start();const port=server.server.address().port;
 const get=host=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:'/health',headers:{Host:host}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject);});
 const upgrade=(origin,withRegistration=false)=>new Promise((resolve,reject)=>{
  const socket=net.connect(port,'127.0.0.1');let bytes=Buffer.alloc(0);
  const timer=setTimeout(()=>{socket.destroy();reject(new Error('upgrade timeout '+JSON.stringify({origin,withRegistration,response:bytes.toString()})));},3000);
  socket.on('error',reject);socket.on('data',b=>{bytes=Buffer.concat([bytes,b]);const text=bytes.toString();if(text.includes('registered')||(!withRegistration&&text.includes('\r\n\r\n'))){clearTimeout(timer);socket.destroy();resolve(text);}});
  socket.on('connect',()=>{
   const headers=`GET /ws HTTP/1.1\r\nHost: staging.karcast.app\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n${origin?`Origin: ${origin}\r\nSec-WebSocket-Protocol: karcast-v1\r\n`:''}\r\n`;
   const payload=Buffer.from(JSON.stringify({version:'1.0',type:'register',messageId:'test',timestamp:Date.now(),phone_token:'a'.repeat(64)}));
   const frame=Buffer.alloc(8+payload.length);frame[0]=0x81;frame[1]=0xfe;frame.writeUInt16BE(payload.length,2);frame.fill(0,4,8);payload.copy(frame,8);
   socket.write(withRegistration?Buffer.concat([Buffer.from(headers),frame]):headers);
  });
 });
 try{
  assert.equal((await get('app.karcast.app')).status,421);
  const health=await get('staging.karcast.app');assert.equal(health.status,200);assert.equal(JSON.parse(health.body).signalingOwner,'staging.karcast.app');
  assert.match(await upgrade('https://evil.example'),/403 Forbidden/);
  assert.match(await upgrade('https://staging.karcast.app'),/101 Switching Protocols/);
  assert.match(await upgrade(null,true),/registered/,'native registration coalesced with upgrade head is processed');
  console.log('PASS isolated HTTP identity, denied Origin, browser handshake and native registration');
 }finally{await server.stop();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
