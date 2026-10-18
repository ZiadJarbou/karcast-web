"use strict";
const {performance}=require('node:perf_hooks');
const {createMessage,MSG_TYPES}=require('./tools/signal-server/protocol.cjs');
/** Only H264 admission changes; pairing, JSON control and the WSS stay owned. */
class RelayFreshness {
 constructor(now=()=>performance.now()){
  this.now=now;this.states=new WeakMap();
  this.counters={admitted:0,completed:0,expired:0,overflow:0,waitingForKey:0,writeErrors:0,maxCompletionAgeMs:0,maxOutstanding:0};
 }
 snapshot(){return {...this.counters};}
 write(browser,state,data){
  const token={at:this.now()};state.outstanding.add(token);
  this.counters.maxOutstanding=Math.max(this.counters.maxOutstanding,state.outstanding.size);
  let done=false,failed=false;
  const complete=error=>{
   if(done)return;done=true;state.outstanding.delete(token);
   // A late completion cannot alter a replacement socket/session's chain.
   if(this.states.get(browser)!==state)return;
   this.counters.completed++;
   this.counters.maxCompletionAgeMs=Math.max(this.counters.maxCompletionAgeMs,Math.max(0,this.now()-token.at));
   if(error){failed=true;this.counters.writeErrors++;state.needsKey=true;state.refreshRequested=false;}
  };
  try{browser.sendBinary(data,complete);this.counters.admitted++;}
  catch(error){complete(error);}
  return !failed;
 }
 forward(browser,phone,sessionId,data){
  if(!Buffer.isBuffer(data)||data.length<13||data.length>2*1024*1024+12||data[0]!==75||data[1]!==67||data[2]!==1)return false;
  let state=this.states.get(browser);
  if(!state||state.phone!==phone||state.sessionId!==sessionId){state={phone,sessionId,config:null,layout:null,needsKey:true,outstanding:new Set(),refreshRequested:false};this.states.set(browser,state);}
  const config=(data[3]&1)!==0,layout=(data[3]&4)!==0,key=(data[3]&2)!==0;
  if(config){if(data.length>64*1024+12)return false;state.config=Buffer.from(data);state.needsKey=true;}
  if(layout){if(data.length>524)return false;state.layout=Buffer.from(data);}
  const buffered=browser.socket?.writableLength||0,now=this.now();
  const oldest=state.outstanding.values().next().value;
  const expired=oldest&&now-oldest.at>250;
  if(buffered>256*1024||expired||state.outstanding.size>=4096){
   if(expired)this.counters.expired++;else this.counters.overflow++;
   if(!state.needsKey)state.refreshRequested=false;
   state.needsKey=true;return false;
  }
  if(config||layout)return this.write(browser,state,data);
  if(state.needsKey&&!key){
   this.counters.waitingForKey++;
   // V60: repeat the request every KEY_RETRY_MS while still waiting. A single
   // lost or unanswered request otherwise holds the relay until AA's next
   // natural IDR (field 14 Oct: 62s with no frames reaching the browser).
   if(!state.refreshRequested||now-(state.refreshRequestedAt||0)>=RelayFreshness.KEY_RETRY_MS){
    if(state.refreshRequested)this.counters.keyRetries=(this.counters.keyRetries||0)+1;
    state.refreshRequested=true;state.refreshRequestedAt=now;phone.send(createMessage(MSG_TYPES.REQUEST_KEYFRAME,{sessionId}));
   }
   return false;
  }
  if(key&&state.needsKey){if(state.layout&&!this.write(browser,state,state.layout))return false;if(state.config&&!this.write(browser,state,state.config))return false;}
  state.needsKey=false;state.refreshRequested=false;
  return this.write(browser,state,data);
 }
}
RelayFreshness.KEY_RETRY_MS=2000;
module.exports=RelayFreshness;
