'use strict';
const assert=require('node:assert/strict'), {EventEmitter}=require('node:events');
const Split=require('./split-media.cjs');
class Socket extends EventEmitter {
 constructor(){super();this.sent=[];this.binary=[];this.socket={writableLength:0};}
 send(s){this.sent.push(JSON.parse(s));} sendBinary(b){this.binary.push(Buffer.from(b));}
 close(){this.closed=true;this.emit('close');}
}
let now=0;
const phone=new Socket(),browser=new Socket();phone.splitMediaCapable=true;
const session={sessionId:'s1',phoneSocket:phone,browserSocket:browser};
const store={getSessionById:id=>id==='s1'?session:null,getSessionBySocket:s=>[session.phoneSocket,session.browserSocket].includes(s)?session:null};
const split=new Split(store,()=>now),request=type=>split.request(browser,{type,sessionId:'s1'});
const auth=(control)=>split.authorize({headers:{'sec-websocket-protocol':'karcast-v1, media_cap.'+control.sent.at(-1).capability}});
const packet=flags=>{const b=Buffer.alloc(18);b.set([75,67,1,flags]);return b;};
assert.throws(()=>split.request(new Socket(),{type:'split_start',sessionId:'s1'}));
request('split_start');const token=browser.sent.at(-1).capability;
const bm=new Socket(),pm=new Socket();split.bind(bm,auth(browser));split.bind(pm,auth(phone));
assert.equal(split.authorize({headers:{'sec-websocket-protocol':'media_cap.'+token}}),null,'single use');
assert(split.forward(pm,packet(1)));assert(split.forward(pm,packet(2)));
bm.socket.writableLength=1024*1024;bm.binary=[];
for(let i=0;i<10000;i++)assert.equal(split.forward(pm,packet(0)),false);
// Bulk congestion is on a different socket. Control can immediately carry ordered gestures.
for(const action of ['down','move','up'])phone.send(JSON.stringify({action}));
assert.deepEqual(phone.sent.slice(-3).map(m=>m.action),['down','move','up']);
bm.socket.writableLength=0;assert.equal(split.forward(pm,packet(0)),false);
assert.equal(phone.sent.at(-1).type,'request_keyframe');assert(split.forward(pm,packet(2)));
assert.equal(bm.binary.at(-1)[3],2);assert.equal(split.forward(bm,packet(2)),false,'role bound');
request('split_reconnect');assert(bm.closed);const bm2=new Socket();split.bind(bm2,auth(browser));
assert.equal(split.forward(pm,packet(0)),false,'new consumer waits for references');
split.forward(pm,packet(2));assert.equal(bm2.binary.at(-1)[3],2);
split.request(phone,{type:'split_reconnect',sessionId:'s1'});assert(pm.closed);
assert.equal(split.forward(pm,packet(2)),false,'late old socket cannot send');
const exp=phone.sent.at(-1).capability;now=10001;
assert.equal(split.authorize({headers:{'sec-websocket-protocol':'media_cap.'+exp}}),null,'expired grant');
request('split_reconnect');session.browserSocket=new Socket();
assert.equal(auth(browser),null,'replaced control generation');assert(bm2.closed);
session.browserSocket=browser;request('split_start');split.controlClosed(phone);assert.equal(auth(browser),null,'Stop/control loss');
phone.splitMediaCapable=false;request('split_start');assert.equal(browser.sent.at(-1).type,'split_unavailable');
assert.throws(()=>split.request(browser,{type:'split_reconnect',sessionId:'cross-session'}));
console.log('PASS split media: roles, one-use/expiry/session/control binding, congestion, reconnect, old callbacks, capability fallback');
