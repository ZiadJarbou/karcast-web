"use strict";
const assert=require('node:assert/strict');
const RelayFreshness=require('./relay-freshness.cjs');
const WsSocket=require('./tools/signal-server/ws_frame.cjs');
const EventEmitter=require('node:events');
let now=0;
const gate=new RelayFreshness(()=>now), callbacks=[];
const browser={socket:{writableLength:1},sendBinary(data,done){callbacks.push(done);return false;}};
const phone={send(){}};
const packet=flags=>Buffer.from([75,67,1,flags,0,0,0,0,0,0,0,0,0x65]);
gate.forward(browser,phone,'owned',packet(2));
for(let i=1;i<=50;i++){
  for(const done of callbacks.splice(0))if(done)done();
  now=i*33;
  assert.equal(gate.forward(browser,phone,'owned',packet(0)),true,
    'A continuously nonzero queue with completed old writes is fresh');
}
// A genuinely unfinished write still expires at the exact old 250ms limit.
for(const done of callbacks.splice(0))if(done)done();
now=2000;gate.forward(browser,phone,'owned',packet(0));
now=2250;assert.equal(gate.forward(browser,phone,'owned',packet(0)),true);
now=2251;assert.equal(gate.forward(browser,phone,'owned',packet(0)),false);
for(const done of callbacks.splice(0))if(done)done();
assert.equal(gate.forward(browser,phone,'owned',packet(0)),false,'Lost references still wait for IDR');
assert.equal(gate.forward(browser,phone,'owned',packet(2)),true);
browser.socket.writableLength=256*1024+1;
assert.equal(gate.forward(browser,phone,'owned',packet(0)),false,'Existing byte bound retained');
browser.socket.writableLength=0;
const old=callbacks.splice(0);
const replacementPhone={send(){}};
gate.forward(browser,replacementPhone,'replacement',packet(2));
for(const done of old)if(done)done(new Error('old owner'));
assert.equal(gate.forward(browser,replacementPhone,'replacement',packet(0)),true,'Late error cannot invalidate replacement chain');
assert.equal(gate.forward(browser,{send(){}},'another',packet(0)),false);
// WsSocket must forward actual completion, even when write returns false
// (false means accepted backpressure, not that the message was discarded).
const tcp=new EventEmitter();tcp.writable=true;tcp.writableLength=1;
let complete;tcp.write=(data,done)=>{complete=done;return false;};
const ws=new WsSocket(tcp);let ended=false;
assert.equal(ws.sendBinary(packet(2),()=>{ended=true;}),false);
assert.equal(ended,false);assert.equal(typeof complete,'function');complete();assert.equal(ended,true);
console.log('PASS actual relay write age, continuous drain, expiry, byte bound, owner isolation and socket completion');
