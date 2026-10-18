'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(path) {
 let now=10000,socket,peer,decoder,sequence=0,produced=0,painted=0,decoded=0;
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,style:{},classList:{toggle(){}},setAttribute(){},addEventListener(){},getContext(){return{drawImage(){painted++;}};}});return nodes.get(id);};
 class Socket {static OPEN=1;constructor(){socket=this;this.readyState=1;}send(){}close(){}}
 class Peer {constructor(){peer=this;this.connectionState='connected';}createDataChannel(label){const ch={readyState:'open',send(){},close(){}};if(label==='karcast-video')this.video=ch;else this.touch=ch;return ch;}addTransceiver(){return{receiver:{}};}async createOffer(){return{type:'offer',sdp:'fixture'};}async setLocalDescription(){}async setRemoteDescription(){}close(){} }
 class Decoder {constructor(callback){this.callback=callback;this.pending=[];this.decodeQueueSize=0;decoder=this;}configure(){}close(){this.closed=true;}decode(chunk){this.pending.push(chunk);}}
 const window={VideoDecoder:Decoder,EncodedVideoChunk:class{},location:{search:`?pair_code=123456${path==='relay'?'&transport=relay':path==='split'?'&transport=ws-split':''}`},addEventListener(){}};
 const context={window,document:{getElementById:node},location:{protocol:'http:',host:'localhost'},URL,URLSearchParams,WebSocket:Socket,RTCPeerConnection:Peer,VideoDecoder:Decoder,EncodedVideoChunk:class{constructor(x){Object.assign(this,x);}},Uint8Array,ArrayBuffer,DataView,Date:class extends Date{static now(){return now;}},performance:{now:()=>now},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){}};
 vm.runInNewContext(fs.readFileSync('public/split-media-client.js','utf8'),context);
 vm.runInNewContext(fs.readFileSync(process.env.KARCAST_SOURCE||'public/app.js','utf8'),context);
 const hooks=window.__KARCAST_TEST_HOOKS__;hooks.connectAndJoin();socket.onopen();socket.onmessage({data:JSON.stringify({type:'joined',sessionId:'startup',capabilities:['ws-split-v1']})});socket.onmessage({data:JSON.stringify({type:'peer_ready',role:'phone'})});
 if(path==='split'){socket.onmessage({data:JSON.stringify({type:'split_capability',role:'browser',sessionId:'startup',capability:'a'.repeat(64),expiresAt:now+10000,generation:'fixture'})});socket.onopen();}
 function packet(key,pts,config=false){produced+=!config;const bytes=new Uint8Array(18);bytes.set([75,67,1,config?1:key?2:0]);new DataView(bytes.buffer).setBigUint64(4,BigInt(pts));bytes.set([0,0,1,config?0x67:key?0x65:0x41],12);if(path!=='direct')socket.onmessage({data:bytes.buffer});else{const raw=new Uint8Array(30);raw.set([75,67,2,bytes[3]]);const v=new DataView(raw.buffer);v.setUint32(4,++sequence);v.setUint16(10,1);v.setBigUint64(12,BigInt(pts));v.setUint32(20,6);raw.set(bytes.subarray(12),24);peer.video.onmessage({data:raw.buffer});}}
 function drain(limit=Infinity){const current=decoder;if(!current)return;while(!current.closed&&current.pending.length&&limit-->0){const chunk=current.pending.shift();decoded++;current.callback.output({timestamp:chunk.timestamp,displayWidth:1280,displayHeight:720,close(){}});}}
 return{packet,drain,hooks,node,async ready(){for(let i=0;i<30;i++)await Promise.resolve();if(path==='direct')peer.touch.onopen();},advance(ms){now+=ms;},stats(){return{produced,painted,decoded,decoderPending:decoder?.pending.length||0};}};
}
(async()=>{
 for(const path of (process.env.KARCAST_PATH?[process.env.KARCAST_PATH]:['direct','relay','split'])){
  // Real hardware can output its first picture while a fresh cached GOP is
  // still arriving. That output must not turn the remaining burst into a stall.
  const interleaved=harness(path);await interleaved.ready();
  interleaved.packet(true,1000000);for(let i=1;i<8;i++)interleaved.packet(false,1000000+i*33333);
  interleaved.drain(1);assert.equal(interleaved.hooks.getUIState(),'CONNECTED');
  for(let i=8;i<=40;i++)interleaved.packet(false,1000000+i*33333);
  assert(interleaved.stats().decoderPending<=8,'Decoder concurrency remains bounded during the burst');
  interleaved.drain();
  assert.equal(interleaved.stats().decoded,41,`${path}: first decoder output during a fresh GOP burst must preserve all reference pictures`);
  assert(interleaved.hooks.getDiagnostics().presentedFrames<=9,'Old reference pictures are decoded without stale replay');
  assert.equal(interleaved.hooks.getDiagnostics().pendingVideoFrames,0);
  interleaved.advance(33);interleaved.packet(false,1000000+41*33333);interleaved.drain();
  const replayBefore=interleaved.hooks.getDiagnostics().presentedFrames;
  interleaved.packet(true,1000000);for(let i=1;i<=41;i++)interleaved.packet(false,1000000+i*33333);
  interleaved.advance(33);interleaved.packet(false,1000000+42*33333);interleaved.drain();
  assert.equal(interleaved.hooks.getDiagnostics().presentedFrames,replayBefore+1,`${path}: an old refresh replay must not destroy the live reference chain`);
  const long=harness(path);await long.ready();long.packet(true,1000000);
  for(let i=1;i<=400;i++)long.packet(false,1000000+i*33333);
  long.advance(300);long.packet(false,1000000+400*33333+300000);long.drain();
  assert.equal(long.stats().decoded,402,'Long startup GOP retains compressed references within the two-second phase');
  assert.equal(long.hooks.getDiagnostics().presentedFrames,1,'Only the fresh current picture is presented after delayed bootstrap');
  assert(long.hooks.getDiagnostics().frameAgeMs<=250);assert.equal(long.hooks.getDiagnostics().pendingVideoFrames,0);
  const expired=harness(path);await expired.ready();expired.packet(true,1000000);
  for(let i=1;i<=40;i++)expired.packet(false,1000000+i*33333);
  expired.advance(2001);expired.packet(false,3000000);expired.drain();
  assert.equal(expired.hooks.getDiagnostics().presentedFrames,0,'Expired bootstrap must not present an old picture');
  assert.equal(expired.hooks.getDiagnostics().pendingVideoFrames,0,'Two-second deadline retires unfinished references');
  for(let i=0;i<5;i++){expired.advance(100);expired.packet(true,1000000);expired.drain();}
  assert.equal(expired.hooks.getDiagnostics().presentedFrames,0,'Repeated stale keys do not extend bootstrap');
  const h=harness(path);await h.ready();
  h.packet(false,1000000);assert.equal(h.stats().decoderPending,0,'Non-IDR startup waits for a key');
  h.packet(true,1000000);for(let i=1;i<=40;i++)h.packet(false,1000000+i*33333);
  assert(h.stats().produced>0);h.drain();
  assert(h.hooks.getDiagnostics().presentedFrames>0,`${path}: produced video must produce a first picture after cached GOP burst / delayed decoder startup`);
  assert.equal(h.hooks.getUIState(),'CONNECTED');assert.equal(h.node('connection-progress-value').textContent,'100%');
  const livePts=1000000+40*33333+2000000;
  h.advance(2000);h.packet(false,livePts);h.drain();
  const before=h.hooks.getDiagnostics().presentedFrames;
  h.advance(1000);h.packet(false,livePts+33333);h.drain();assert.equal(h.hooks.getDiagnostics().presentedFrames,before,'A stalled transport must not present stale pictures');
  h.packet(false,livePts+1000000);h.drain();assert.equal(h.hooks.getDiagnostics().presentedFrames,before+1,'Approved reference-only catch-up resumes fresh delta without replay');const beforeExpired=h.hooks.getDiagnostics().presentedFrames;h.packet(false,livePts+1033333);h.advance(2001);h.packet(false,livePts+1066666);h.drain();assert.equal(h.hooks.getDiagnostics().presentedFrames,beforeExpired,'Expired two-second reference deadline never displays stale pictures');h.packet(false,livePts+3001000);h.drain();assert.equal(h.hooks.getDiagnostics().presentedFrames,beforeExpired,'Actually retired references still require IDR');
  h.packet(true,livePts+3001000);h.drain();assert(h.hooks.getDiagnostics().presentedFrames>beforeExpired,'Later IDR restores bounded playback');
  h.advance(251);h.packet(true,livePts+3252000);h.advance(251);h.drain();assert(h.hooks.getDiagnostics().staleVideoDrops>0,'Late decoder output is discarded');
  const resumedPts=livePts+3503000;h.packet(true,resumedPts);h.drain();
  for(let i=1;i<=54000;i++){h.advance(1000/30);h.packet(i%60===0,resumedPts+Math.round(i*1000000/30));h.drain();assert(h.hooks.getDiagnostics().pendingVideoFrames<=8);}
  assert.equal(h.hooks.getUIState(),'CONNECTED');assert(h.hooks.getDiagnostics().frameAgeMs<=250);
  console.log(`PASS ${path}: startup burst, first non-IDR, late IDR/decoder, stale GOP, stalled transport, 30-minute 30fps freshness; presented=${h.hooks.getDiagnostics().presentedFrames}`);
 }
})().catch(e=>{console.error(e);process.exitCode=1;});


