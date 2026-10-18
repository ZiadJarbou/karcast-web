(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KarCastMicUplink=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const privateIp=s=>typeof s==='string'&&(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fd[\da-f]{2}:|fc[\da-f]{2}:|fe80:)/i.test(s));
 function eligible(stats){let pair;for(const s of stats.values())if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId);if(!pair||pair.state!=='succeeded')return false;const a=stats.get(pair.localCandidateId),b=stats.get(pair.remoteCandidateId);return a?.candidateType==='host'&&b?.candidateType==='host'&&privateIp(a.address||a.ip)&&privateIp(b.address||b.ip);}
 class Resampler{
  constructor(rate){this.step=rate/16000;this.cursor=0;this.pending=[];}
  push(input){const frames=[];while(this.cursor<input.length){const i=Math.floor(this.cursor),f=this.cursor-i;const v=input[i]*(1-f)+(input[Math.min(i+1,input.length-1)]||0)*f;this.pending.push(Math.round(Math.max(-1,Math.min(1,v))*32767));this.cursor+=this.step;if(this.pending.length===320){frames.push(this.pending);this.pending=[];}}this.cursor-=input.length;return frames;}
 }
 class Uplink{
  constructor(env,closed,changed){this.env=env;this.closed=closed;this.changed=changed;this.channel=null;this.request={requested:false};this.sequence=0;this.offset=0;this.rtt=Infinity;this.stats={captured:0,enqueued:0,sent:0,dropped:0,interruptions:0};this.active=false;}
  attach(peer){this.detach();this.peer=peer;const ch=this.channel=peer.createDataChannel('karcast-mic',{ordered:false,maxRetransmits:0});ch.onopen=()=>{for(let i=0;i<5;i++)this.env.setTimeout(()=>{if(ch.readyState==='open')ch.send(JSON.stringify({type:'clock_ping',clientMs:Date.now()}));},i*100);};
   ch.onmessage=e=>{try{if(typeof e.data!=='string')return;const j=JSON.parse(e.data);if(j.type==='clock_pong'){const now=Date.now(),rtt=now-j.clientMs;if(rtt>=0&&rtt<this.rtt){this.rtt=rtt;this.offset=j.phoneMs-(j.clientMs+now)/2;}}
    if(j.type==='mic_request'){const old=this.request;this.request=j;this.stats.android=j;if(this.active&&(!j.requested||old.token!==j.token||!j.privateEligible)){this.stats.interruptions++;this.stop();this.closed();}}
    if(j.type==='mic_start_ack'&&this.ack){const ack=this.ack;this.ack=null;ack(j.accepted&&j.token===this.request.token);}
   }catch(_){this.stats.dropped++;}};
   ch.onclose=()=>{this.stats.interruptions++;this.stop();this.closed();};
  }
  canStart(){return this.channel?.readyState==='open'&&this.request.requested&&this.request.privateEligible&&this.rtt<=200;}
  async start(stream){if(!this.canStart()||!(await this.peer.getStats().then(eligible)))throw new Error('Open AA voice input on a verified private connection first.');
   const token=this.request.token,accepted=await new Promise(resolve=>{this.ack=resolve;this.channel.send(JSON.stringify({type:'mic_start',token}));this.env.setTimeout(()=>{if(this.ack===resolve){this.ack=null;resolve(false);}},1000);});
   if(!accepted||token!==this.request.token||!this.request.requested)throw new Error('Android Auto microphone session is no longer available.');
   const Audio=this.env.AudioContext||this.env.webkitAudioContext;if(!Audio)throw new Error('Audio processing unavailable.');
   this.context=new Audio();await this.context.resume();if(token!==this.request.token||!this.request.requested){this.stop();throw new Error('Voice request ended.');}
   this.source=this.context.createMediaStreamSource(stream);this.processor=this.context.createScriptProcessor(2048,1,1);this.gain=this.context.createGain();this.gain.gain.value=0;this.source.connect(this.processor);this.processor.connect(this.gain);this.gain.connect(this.context.destination);
   const resampler=new Resampler(this.context.sampleRate);this.active=true;this.sequence=0;this.firstReported=false;this.stats.captureStartEpochMs=Date.now();
   this.processor.onaudioprocess=e=>{if(!this.active||token!==this.request.token||!this.request.requested)return;const captured=Date.now()+this.offset-e.inputBuffer.duration*1000;
    for(const samples of resampler.push(e.inputBuffer.getChannelData(0))){this.stats.captured++;const seq=this.sequence++;this.stats.enqueued++;this.stats.lastPcmEpochMs=Date.now();this.stats.lastEnqueueEpochMs=Date.now();if(seq===0)this.stats.firstPcmEpochMs=this.stats.lastPcmEpochMs;
     if(this.channel.readyState!=='open'||this.channel.bufferedAmount>8192){this.stats.dropped++;continue;}
     const packet=new ArrayBuffer(672),v=new DataView(packet);v.setInt32(0,0x4B434D31,true);v.setFloat64(4,token,true);v.setInt32(12,seq,true);v.setFloat64(16,captured,true);v.setFloat64(24,this.rtt/2,true);samples.forEach((s,i)=>v.setInt16(32+2*i,s,true));
     try{this.channel.send(packet);this.stats.sent++;this.stats.lastSendEpochMs=Date.now();}catch(_){this.stats.dropped++;}
    }
    if(!this.firstReported||this.stats.captured%50===0){this.firstReported=true;this.changed({...this.stats,clockOffsetMs:this.offset,clockUncertaintyMs:this.rtt/2,bufferedAmount:this.channel.bufferedAmount});}
   };
  }
  stop(){this.active=false;if(this.ack){this.ack(false);this.ack=null;}if(this.processor)this.processor.onaudioprocess=null;for(const node of [this.source,this.processor,this.gain])try{node?.disconnect();}catch(_){}try{this.context?.close();}catch(_){}this.context=null;this.source=null;this.processor=null;this.gain=null;
   try{if(this.channel?.readyState==='open')this.channel.send(JSON.stringify({type:'mic_stop',token:this.request.token}));}catch(_){}
  }
  detach(){this.stop();if(this.channel){this.channel.onopen=this.channel.onmessage=this.channel.onclose=null;try{this.channel.close();}catch(_){}this.channel=null;}this.request={requested:false};this.rtt=Infinity;}
 }
 return {Uplink,Resampler,eligible,privateIp};
});
