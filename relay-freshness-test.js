"use strict";
const assert=require('node:assert/strict');
const UnifiedAppServer=require('./server-core');
const server=new UnifiedAppServer();
const phone={sent:[],send(m){this.sent.push(m);}};
const browser={socket:{writableLength:0},sent:[],sendBinary(b){this.sent.push(Buffer.from(b));return true;}};
const session={sessionId:'live',phoneSocket:phone,browserSocket:browser};
server.sessionStore.getSessionBySocket=s=>s===phone?session:null;
const packet=flags=>{const b=Buffer.alloc(18);b.set([75,67,1,flags]);b[16]=flags===2?0x65:0x41;return b;};
try{
 server.handleWsBinary(phone,packet(1));server.handleWsBinary(phone,packet(2));browser.sent=[];
 browser.socket.writableLength=600*1024;
 for(let i=0;i<100;i++)server.handleWsBinary(phone,packet(0));
 assert.equal(browser.sent.length,0,'Backpressure discards whole stale video AUs while keeping signaling');
 browser.socket.writableLength=0;server.handleWsBinary(phone,packet(0));assert.equal(browser.sent.length,0,'Missing references wait for an IDR');
 server.handleWsBinary(phone,packet(2));assert(browser.sent.some(b=>b[3]===1),'Recovery sends codec configuration');assert.equal(browser.sent.at(-1)[3],2);
 const count=browser.sent.length;server.handleWsBinary({},packet(2));assert.equal(browser.sent.length,count,'Wrong owner cannot inject video');
 assert.equal(session.browserSocket,browser,'Freshness does not replace the browser or pairing');
 // An age budget also bounds small queues that drain too slowly.
 const RelayFreshness=require('./relay-freshness.cjs');let now=0;const gate=new RelayFreshness(()=>now);
 const completions=[];
 const paced={socket:{writableLength:1},sent:[],sendBinary(b,done){this.sent.push(b);completions.push(done);return true;}};
 gate.forward(paced,phone,'paced',packet(1));gate.forward(paced,phone,'paced',packet(2));paced.sent=[];
 now=251;assert.equal(gate.forward(paced,phone,'paced',packet(0)),false);assert.equal(paced.sent.length,0);
 paced.socket.writableLength=0;completions.splice(0).forEach(done=>done());gate.forward(paced,phone,'paced',packet(2));assert.equal(paced.sent.at(-1)[3],2);
 const otherPhone={send(){}};paced.sent=[];gate.forward(paced,otherPhone,'renewed',packet(0));assert.equal(paced.sent.length,0,'New owner waits for its own keyframe');
 gate.forward(paced,otherPhone,'renewed',packet(2));assert(!paced.sent.some(b=>b[3]===1),'Retired codec headers never enter a different owner');
 console.log('PASS: relay admission, dependency recovery, codec headers, queue age, owner isolation, live signaling');
}finally{server.sessionStore.destroy();}

