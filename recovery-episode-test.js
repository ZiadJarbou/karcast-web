'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness(path) {
 let now=10000,socket,peer,decoder,sequence=0,produced=0,painted=0,decoded=0,surfaceUnavailable=false;const intervals=[],timeouts=[];
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,style:{},classList:{toggle(){}},setAttribute(){},addEventListener(){},getContext(){return{drawImage(){if(surfaceUnavailable)throw Error('Surface unavailable');painted++;}};}});return nodes.get(id);};
 class Socket {static OPEN=1;constructor(){socket=this;this.readyState=1;this.sent=[];}send(data){this.sent.push(JSON.parse(data));}close(){}}
 class Peer {constructor(){peer=this;this.connectionState='connected';}createDataChannel(label){const ch={readyState:'open',send(){},close(){}};if(label==='karcast-video')this.video=ch;else this.touch=ch;return ch;}addTransceiver(){return{receiver:{}};}async createOffer(){return{type:'offer',sdp:'fixture'};}async setLocalDescription(){}async setRemoteDescription(){}close(){} }
 class Decoder {constructor(callback){this.callback=callback;this.pending=[];this.decodeQueueSize=0;decoder=this;}configure(){}close(){this.closed=true;}decode(chunk){this.pending.push(chunk);}}
 const window={VideoDecoder:Decoder,EncodedVideoChunk:class{},location:{search:`?pair_code=123456${path==='relay'?'&transport=relay':''}`},addEventListener(){}};
 const context={window,document:{getElementById:node},location:{protocol:'http:',host:'localhost'},URLSearchParams,WebSocket:Socket,RTCPeerConnection:Peer,VideoDecoder:Decoder,EncodedVideoChunk:class{constructor(x){Object.assign(this,x);}},Uint8Array,ArrayBuffer,DataView,Date:class extends Date{static now(){return now;}},performance:{now:()=>now},setTimeout(fn,ms){timeouts.push({fn,ms});return timeouts.length;},clearTimeout(){},setInterval(fn,ms){intervals.push({fn,ms});return 1;},clearInterval(){}};
 vm.runInNewContext(fs.readFileSync(process.env.KARCAST_SOURCE||'public/app.js','utf8'),context);
 const hooks=window.__KARCAST_TEST_HOOKS__;hooks.connectAndJoin();socket.onopen();socket.onmessage({data:JSON.stringify({type:'joined',sessionId:'startup'})});socket.onmessage({data:JSON.stringify({type:'peer_ready',role:'phone'})});
 function packet(key,pts,config=false){produced+=!config;const bytes=new Uint8Array(18);bytes.set([75,67,1,config?1:key?2:0]);new DataView(bytes.buffer).setBigUint64(4,BigInt(pts));bytes.set([0,0,1,config?0x67:key?0x65:0x41],12);if(path==='relay')socket.onmessage({data:bytes.buffer});else{const raw=new Uint8Array(30);raw.set([75,67,2,bytes[3]]);const v=new DataView(raw.buffer);v.setUint32(4,++sequence);v.setUint16(10,1);v.setBigUint64(12,BigInt(pts));v.setUint32(20,6);raw.set(bytes.subarray(12),24);peer.video.onmessage({data:raw.buffer});}}
 function drain(limit=Infinity){const current=decoder;if(!current)return;while(!current.closed&&current.pending.length&&limit-->0){const chunk=current.pending.shift();decoded++;current.callback.output({timestamp:chunk.timestamp,displayWidth:1280,displayHeight:720,close(){}});}}
 return{packet,drain,hooks,node,messages(){return socket.sent;},surface(unavailable){surfaceUnavailable=unavailable;},ice(value){peer.iceConnectionState=value;peer.oniceconnectionstatechange();},directTimeout(){timeouts.find(x=>x.ms===15000).fn();},health(){intervals.find(x=>x.ms===1000).fn();},source(frames){peer.touch.onmessage({data:JSON.stringify({type:'media_status',state:'projecting',sourceFrames:frames})});},relayStarts(){return socket.sent.filter(x=>x.type==='relay_start').length;},refreshes(){return hooks.getDiagnostics().recoveryRequests;},async ready(){for(let i=0;i<30;i++)await Promise.resolve();if(path==='direct')peer.touch.onopen();},advance(ms){now+=ms;},stats(){return{produced,painted,decoded,decoderPending:decoder?.pending.length||0};}};
}
(async()=>{
 const proof=harness('relay');await proof.ready();
 proof.packet(true,1000000);proof.drain();
 proof.packet(false,1033333);proof.packet(false,1066666);proof.advance(2000);proof.drain();proof.health();
 const beforeProof=proof.messages().filter(m=>m.type==='request_keyframe').length;assert.equal(beforeProof,1,'Fixture first attempts bounded cache recovery');
 proof.advance(2100);proof.packet(false,5200000);proof.drain();
 const requests=proof.messages().filter(m=>m.type==='request_keyframe');
 assert.equal(requests.length,beforeProof+1,'Actual two-second expiry reports one confirmed failed-reference episode immediately');
 const currentProof=requests.at(-1).fieldMetrics;
 assert(currentProof,'Recovery message carries current proof, not ten-second-old periodic telemetry');
 assert.equal(currentProof.video.referenceRecoveryFailed,1);
 assert(currentProof.video.lastFrameReceivedAt-currentProof.video.lastFramePresentedAt>=2000);
 assert(currentProof.video.recoveryRequests>=2);
 proof.advance(33);proof.packet(false,5233333);proof.drain();
 assert.equal(proof.messages().filter(m=>m.type==='request_keyframe').length,requests.length,'Expired episode does not loop notifications or renew the deadline');
 assert(!JSON.stringify(currentProof).includes('pairToken'));
 for(const path of ['direct','relay']) {
  for(const delayMs of [300,525,800,1000,1900]) for(const pendingCount of [1,8]) {
   const overlap=harness(path);await overlap.ready();
   overlap.packet(true,1000000);overlap.drain();
   overlap.advance(2100);overlap.packet(false,3100000);overlap.drain();
   const beforeOverlap=overlap.hooks.getDiagnostics().presentedFrames;
   const beforeRefresh=overlap.refreshes();
   overlap.advance(33);
   for(let p=0;p<pendingCount;p++)overlap.packet(false,3133333+p);
   overlap.advance(delayMs);if(delayMs>=1000)overlap.drain(1);overlap.packet(false,3166666);overlap.drain();
   assert.equal(overlap.hooks.getDiagnostics().presentedFrames,beforeOverlap,
    'Delayed pending reference pictures are never displayed');
   overlap.advance(33);overlap.packet(false,(3166+delayMs)*1000);overlap.drain();
   assert.equal(overlap.hooks.getDiagnostics().presentedFrames,beforeOverlap+1,
    `${path}: short jitter with ${pendingCount} decoder pictures in flight preserves the reference chain`);
   assert.equal(overlap.refreshes(),beforeRefresh,'Healthy bounded pending decode must not trigger historical GOP replay');
  }
  const repeated=harness(path);await repeated.ready();
  repeated.packet(true,1000000);repeated.drain();
  repeated.advance(2100);repeated.packet(false,3100000);repeated.drain();
  repeated.advance(333);repeated.packet(false,3133333);repeated.drain();
  repeated.advance(33);repeated.packet(false,3466000);repeated.drain();
  repeated.advance(1800);repeated.packet(false,5266000);repeated.drain();
  const beforeSecondSpike=repeated.hooks.getDiagnostics().presentedFrames;
  const beforeSecondRefresh=repeated.refreshes();
  repeated.advance(400);repeated.packet(false,5299333);repeated.drain();
  repeated.advance(33);repeated.packet(false,5699000);repeated.drain();
  assert.equal(repeated.hooks.getDiagnostics().presentedFrames,beforeSecondSpike+1,'A fresh presentation completes the prior episode; a later independent spike gets its own fixed deadline');
  assert.equal(repeated.refreshes(),beforeSecondRefresh,'Independent jitter after actual fresh presentation never replays historical GOP');
  const beyond=harness(path);await beyond.ready();
  beyond.packet(true,1000000);beyond.drain();
  beyond.advance(2100);beyond.packet(false,3100000);beyond.drain();
  beyond.advance(33);for(let i=0;i<8;i++)beyond.packet(false,3133333+i);
  beyond.advance(2100);beyond.drain(1);
  const beforeBeyond=beyond.stats().decoded;
  const beforeBeyondPresented=beyond.hooks.getDiagnostics().presentedFrames;
  beyond.packet(false,3166666);beyond.drain();
  assert.equal(beyond.stats().decoded,beforeBeyond,'Transport older than two seconds still retires, even with recent stale decode progress');
  assert.equal(beyond.hooks.getDiagnostics().presentedFrames,beforeBeyondPresented,'Out-of-bound reference backlog is never displayed');
  const jitter=harness(path);await jitter.ready();
  jitter.packet(true,1000000);jitter.drain();
  jitter.advance(2100);jitter.packet(false,3100000);jitter.drain();
  const beforeJitter=jitter.hooks.getDiagnostics().presentedFrames;
  const refreshBeforeJitter=jitter.refreshes();
  jitter.advance(333);jitter.packet(false,3133333);jitter.drain();
  assert.equal(jitter.hooks.getDiagnostics().presentedFrames,beforeJitter,
    'An aged transport reference is decoded but never displayed');
  jitter.advance(33);jitter.packet(false,3466000);jitter.drain();
  assert.equal(jitter.hooks.getDiagnostics().presentedFrames,beforeJitter+1,
    'Brief transport jitter must preserve references for fresh continuation');
  assert.equal(jitter.refreshes(),refreshBeforeJitter,'No historical cache replay for a short transport-age spike');
  const expires=harness(path);await expires.ready();expires.packet(true,1000000);expires.drain();
  expires.advance(2100);expires.packet(false,3100000);expires.drain();
  expires.advance(333);expires.packet(false,3133333);expires.drain();
  expires.advance(1800);expires.packet(false,4933000);expires.drain();
  const beforeExpired=expires.stats().decoded;
  expires.advance(400);expires.packet(false,5333000);expires.drain();
  assert.equal(expires.stats().decoded,beforeExpired,
    'Persistent aged references still retire after the fixed two-second deadline, respecting the existing refresh cooldown');
  const priming=harness(path);await priming.ready();
  priming.packet(true,1000000);priming.drain();
  priming.packet(false,1033333);priming.packet(false,1066666);
  priming.advance(1600);priming.drain();priming.health();
  assert.equal(priming.hooks.getDiagnostics().presentationRecoveries||0,0,
    'Presentation watchdog must not retire a bounded reference episode before its two-second deadline');
  priming.packet(false,2600000);priming.drain();
  assert.equal(priming.hooks.getDiagnostics().presentedFrames,2,
    'Live continuation completes the same reference episode without a second cache replay');
  const delayed=harness(path);await delayed.ready();
  delayed.packet(true,1000000);delayed.drain();
  delayed.packet(false,1033333);delayed.packet(false,1066666);delayed.advance(2000);delayed.drain();
  assert.equal(delayed.hooks.getDiagnostics().framesDecoded,3);
  assert.equal(delayed.hooks.getDiagnostics().presentedFrames,1,'Reproduce decode without presentation');
  delayed.health();
  assert.equal(delayed.hooks.getDiagnostics().presentationRecoveries,1,'Recover post-decode starvation within two seconds on both transports');
  delayed.packet(true,3000000);delayed.drain();
  assert.equal(delayed.hooks.getDiagnostics().presentedFrames,2,'Fresh IDR restores presentation without displaying the obsolete picture');
  assert.equal(delayed.hooks.getDiagnostics().signalingReconnects,0);
  assert.equal(delayed.relayStarts(),path==='relay'?1:0,'Decoder recovery preserves the selected transport');
  for(let i=0;i<30;i++){delayed.advance(1000);delayed.health();}
  assert.equal(delayed.hooks.getDiagnostics().presentationRecoveries,1,'Static screen does not cause repeated decoder recovery');
  const surface=harness(path);await surface.ready();surface.packet(true,1000000);surface.drain();
  surface.surface(true);surface.advance(100);surface.packet(false,1100000);surface.drain();
  assert.equal(surface.hooks.getDiagnostics().presentationSurfaceErrors,1);
  surface.surface(false);surface.packet(true,1100000);surface.drain();
  assert.equal(surface.hooks.getDiagnostics().presentedFrames,2,'Temporary surface error cannot strand picture ownership');
 }
 const ice=harness('direct');await ice.ready();ice.ice('failed');
 assert.equal(ice.hooks.getDiagnostics().DIRECT_REQUESTED,1);
 assert.equal(ice.hooks.getDiagnostics().DIRECT_ATTEMPT_STARTED,1);
 assert.equal(ice.hooks.getDiagnostics().DIRECT_ICE_STATE,5);
 assert.equal(ice.hooks.getDiagnostics().FALLBACK_TO_RELAY_REASON,2);
 assert.equal(ice.hooks.getDiagnostics().FINAL_TRANSPORT,2);
 const timeout=harness('direct');await timeout.ready();timeout.advance(15000);timeout.directTimeout();
 assert.equal(timeout.hooks.getDiagnostics().DIRECT_TIMEOUT,1);
 assert.equal(timeout.hooks.getDiagnostics().FALLBACK_TO_RELAY_REASON,1);
 assert.equal(timeout.relayStarts(),1);
 console.log('PASS transport: explicit DIRECT request/attempt/ICE failure/timeout and final RELAY reason');
 console.log('PASS DIRECT/RELAY: delayed decoded output and unavailable surface; fresh recovery <=2s without AA/peer restart');
 const stalled=harness('direct');await stalled.ready();
 stalled.source(1);stalled.packet(true,1000000);stalled.drain();
 const initialPresented=stalled.hooks.getDiagnostics().presentedFrames;
 // Cached/dependent packets still arrive; no current picture is presented.
 // AA status keeps advancing, independently of those replayed access units.
 stalled.advance(2500);stalled.source(2);stalled.packet(false,1033333);stalled.health();
 for(let i=0;i<7;i++){stalled.advance(1000);stalled.source(3+i);stalled.packet(false,1033333);stalled.health();}
 assert.equal(stalled.relayStarts(),0,'Allow bounded reference recovery before replacing the media path');
 stalled.advance(1000);stalled.source(10);stalled.packet(false,1033333);stalled.health();
 assert.equal(stalled.relayStarts(),1,'Advancing AA with arriving unusable DIRECT packets must not remain frozen indefinitely');
 assert.equal(stalled.hooks.getDiagnostics().presentedFrames,initialPresented,'Fallback must not present stale references');
 assert.equal(stalled.hooks.getDiagnostics().transport,'relay');
 assert.equal(stalled.hooks.getDiagnostics().signalingReconnects,0,'Fallback preserves the healthy signaling session');
 const staticScreen=harness('direct');await staticScreen.ready();
 staticScreen.source(1);staticScreen.packet(true,1000000);staticScreen.drain();
 for(let i=0;i<20;i++){staticScreen.advance(1000);staticScreen.source(1);staticScreen.health();}
 assert.equal(staticScreen.relayStarts(),0,'An unchanged AA screen without new source frames must not trigger fallback');
 const progressing=harness('direct');await progressing.ready();progressing.source(1);
 progressing.packet(true,1000000);progressing.drain();
 for(let i=1;i<=20;i++){progressing.advance(1000);progressing.source(i+1);progressing.packet(false,1000000+i*1000000);progressing.drain();progressing.health();}
 assert.equal(progressing.relayStarts(),0,'Healthy DIRECT presentation remains on DIRECT');
 console.log('PASS DIRECT: bounded presentation-stall fallback; static and healthy screens preserved');
 for(const path of ['direct','relay']) {
  const immediate=harness(path);await immediate.ready();
  immediate.packet(true,1000000); immediate.drain();
  immediate.advance(1900);
  immediate.packet(false,1033333); immediate.drain();
  immediate.advance(201);
  immediate.packet(false,1066666); immediate.drain();
  const recoveredBefore=immediate.stats().decoded;
  immediate.packet(true,1000000);
  for(let i=1;i<=90;i++) immediate.packet(false,1000000+i*33333);
  immediate.drain();
  assert.equal(immediate.stats().decoded-recoveredBefore,91,
    `${path}: a paced transport retirement must admit its immediate complete replay in a fresh bounded episode`);
  assert(immediate.hooks.getDiagnostics().frameAgeMs<=250);
  const h=harness(path);await h.ready();
  h.packet(true,1000000);for(let i=1;i<=40;i++)h.packet(false,1000000+i*33333);h.drain();
  const first=h.hooks.getDiagnostics().presentedFrames;
  h.advance(1900);h.packet(false,1000000+41*33333);h.drain();
  h.advance(201);h.packet(false,1000000+42*33333);h.drain();
  assert.equal(h.hooks.getDiagnostics().presentedFrames,first,'Stale transport retires its reference chain');
  // Incoming unusable deltas must not satisfy media health indefinitely.
  h.advance(5500);h.packet(false,1000000+42*33333);const before=h.refreshes();h.health();
  assert.equal(h.refreshes(),before+1,`${path}: live packets with no decodable reference chain must request a paced recovery`);
  const requested=h.refreshes();for(let i=0;i<10;i++){h.advance(100);h.packet(false,1000000+(43+i)*33333);h.health();}
  assert.equal(h.refreshes(),requested,'Repeated packets do not renew a recovery episode');
  // A replacement cache needs compressed historical references to reach live.
  // The old two-second deadline must not permanently disable all later episodes.
  const decodedBeforeReplay=h.stats().decoded;
  h.packet(true,1000000);for(let i=1;i<=300;i++)h.packet(false,1000000+i*33333);h.drain();
  assert.equal(h.stats().decoded-decodedBeforeReplay,301,`${path}: the replacement decoder receives every cached reference even when previously received by its retired predecessor`);
  assert(h.hooks.getDiagnostics().presentedFrames>first,`${path}: a later complete reference chain reaches fresh video after an expired episode`);
  assert(h.hooks.getDiagnostics().frameAgeMs<=250,'Historical decoded references are never presented');
  assert.equal(h.hooks.getDiagnostics().pendingVideoFrames,0);
  const knowledge=harness(path);await knowledge.ready();
  knowledge.packet(true,1000000);knowledge.drain();
  knowledge.advance(2000);knowledge.packet(false,3000000);knowledge.drain();
  knowledge.packet(false,3033333);knowledge.advance(2500);knowledge.packet(false,3100000);knowledge.drain();
  knowledge.advance(6000);knowledge.packet(false,20000000);knowledge.health();
  const beforeOldReplay=knowledge.hooks.getDiagnostics().presentedFrames;
  knowledge.packet(true,10000000);knowledge.drain();
  assert.equal(knowledge.hooks.getDiagnostics().presentedFrames,beforeOldReplay,
    `${path}: a replay older than an already received undecodable source picture must never be displayed`);
  knowledge.packet(true,20000000);knowledge.drain();
  assert(knowledge.hooks.getDiagnostics().presentedFrames>beforeOldReplay,
    `${path}: tracking skipped source pictures does not prevent a current IDR from restoring playback`);
  console.log(`PASS ${path}: bounded paced recovery after expired cached startup; no stale display or deadline renewal`);
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
