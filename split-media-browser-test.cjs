'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const nodes=new Map(),timers=new Map(),sockets=[],listeners={};let next=0,now=10000;
const node=id=>{
 if(!nodes.has(id))nodes.set(id,{hidden:true,style:{setProperty(){}},classList:{toggle(){}},setAttribute(){},addEventListener(){},
   capture:[],setPointerCapture(id){this.capture.push(id);},getBoundingClientRect(){return this.rect;},
   videoWidth:1280,videoHeight:720,getContext(){return{drawImage(){}};},play(){return Promise.resolve();}});
 return nodes.get(id);
};
node('stream-container').rect={left:0,top:0,width:1280,height:720};
class Socket {
 static OPEN=1;
 constructor(url,protocols){this.url=url;this.protocols=protocols;this.readyState=1;this.sent=[];sockets.push(this);}
 send(s){this.sent.push(JSON.parse(s));}close(){this.closed=true;this.readyState=3;}
}
class Decoder {constructor(cb){this.cb=cb;this.decodeQueueSize=0;}configure(){}close(){this.closed=true;}
 decode(c){this.cb.output({timestamp:c.timestamp,displayWidth:1280,displayHeight:720,close(){}});}}
const window={VideoDecoder:Decoder,EncodedVideoChunk:class{},devicePixelRatio:3,
 location:{search:'?pair_code=123456&transport=ws-split'},addEventListener(t,cb){listeners[t]=cb;}};
const context={window,document:{getElementById:node},location:{protocol:'https:',host:'app.karcast.app'},
 URL,URLSearchParams,WebSocket:Socket,VideoDecoder:Decoder,EncodedVideoChunk:class{constructor(x){Object.assign(this,x);}},
 Uint8Array,ArrayBuffer,DataView,Date:class extends Date{static now(){return now;}},performance:{now:()=>now},
 setTimeout(fn,ms){timers.set(++next,{fn,ms});return next;},clearTimeout(id){timers.delete(id);},
 setInterval(){return -1;},clearInterval(){}};
vm.createContext(context);
for(const p of ['public/split-media-client.js','public/app.js'])vm.runInContext(fs.readFileSync(p,'utf8'),context);
const hooks=window.__KARCAST_TEST_HOOKS__;hooks.connectAndJoin();const control=sockets[0];control.onopen();
const message=m=>control.onmessage({data:JSON.stringify(m)});
message({type:'joined',sessionId:'s',capabilities:['ws-split-v1']});
assert.equal(control.sent.at(-1).type,'split_start');
assert.equal(hooks.getDiagnostics().inputCapabilities.text,false);
assert.equal(hooks.getDiagnostics().inputCapabilities.multiTouch,false);
const grant=()=>message({type:'split_capability',role:'browser',sessionId:'s',capability:'a'.repeat(64),expiresAt:now+10000,generation:'g'});
grant();let media=sockets.at(-1);assert.equal(media.url,'wss://app.karcast.app/ws/media');assert(!media.url.includes('aaaa'));
assert(media.protocols[1].startsWith('media_cap.'));media.onopen();
const frame=(pts,flags=2)=>{const p=new Uint8Array(18);p.set([75,67,1,flags]);new DataView(p.buffer).setBigUint64(4,BigInt(pts));p.set([0,0,1,0x65],12);return p.buffer;};
control.onmessage({data:frame(1)});assert.equal(hooks.getDiagnostics().presentedFrames,0,'control cannot inject split media');
media.onmessage({data:frame(1000000)});assert.equal(hooks.getUIState(),'CONNECTED');
assert.equal(hooks.getDiagnostics().connectionPath,'secure-split-media');
assert(hooks.getDiagnostics().splitFirstSourceNewPresentedAt>0);
media.bufferedAmount=10000000;
const event=(id,x,y)=>({button:0,pointerId:id,clientX:x,clientY:y,preventDefault(){}});
const canvas=node('relayCanvas');canvas.onpointerdown(event(1,640,300));
canvas.onpointerdown(event(2,100,100));
for(let i=0;i<100;i++)canvas.onpointermove(event(1,640+i,300));
canvas.onpointerup(event(1,740,300));
let touch=control.sent.filter(m=>m.type==='relay_touch');assert.equal(touch.length,102);
assert.equal(touch[0].action,'down');assert.equal(touch.at(-1).action,'up');assert.equal(canvas.capture[0],1);
assert(touch.every((m,i)=>!i||m.seq>touch[i-1].seq));assert.equal(media.sent.length,0,'input never queues behind video');
// CSS scale/DPR does not alter normalized source coordinates, including the relocated dock.
node('stream-container').rect={left:10,top:20,width:640,height:360};
canvas.onpointerdown(event(3,330,200));canvas.onpointercancel();canvas.onlostpointercapture();
touch=control.sent.filter(m=>m.type==='relay_touch');assert.equal(touch.at(-2).x,0.5);assert.equal(touch.at(-1).action,'cancel');
const before=touch.length;canvas.onpointerdown(event(4,-10,50));assert.equal(control.sent.filter(m=>m.type==='relay_touch').length,before);
node('relayDockCanvas').onpointerdown(event(5,330,370));listeners.blur();
touch=control.sent.filter(m=>m.type==='relay_touch');assert(touch.at(-2).y>0.9);assert.equal(touch.at(-1).action,'cancel');
const oldCallback=media.onmessage,old=media;grant();media=sockets.at(-1);assert(old.closed);media.onopen();
const presented=hooks.getDiagnostics().presentedFrames;oldCallback({data:frame(2000000)});
assert.equal(hooks.getDiagnostics().presentedFrames,presented,'old socket callback rejected');
// A replay is distinguishable from a source-new output after media replacement.
media.onmessage({data:frame(1000000)});assert.equal(hooks.getDiagnostics().splitFirstSourceNewDecodedAt,0);
now+=34;media.onmessage({data:frame(1034000)});assert(hooks.getDiagnostics().splitFirstSourceNewDecodedAt>0);
media.onclose();const retry=[...timers.values()].find(t=>t.ms===500);assert(retry);retry.fn();assert.equal(control.sent.at(-1).type,'split_reconnect');
grant();media=sockets.at(-1);const late=media.onopen;hooks.cleanupWebRTC();late();
assert(media.closed);assert(!control.closed,'media Stop leaves control lifetime separate');
hooks.connectAndJoin();const legacy=sockets.at(-1);legacy.onopen();
legacy.onmessage({data:JSON.stringify({type:'joined',sessionId:'old-phone'})});
assert.equal(legacy.sent.at(-1).type,'relay_start','old phone falls back without changing default');
console.log('PASS browser split: negotiation, control isolation, fresh/replay clocks, late socket, retry/Stop, capture/cancel, DPR/scale, dock, sustained drag, unsupported second pointer');
