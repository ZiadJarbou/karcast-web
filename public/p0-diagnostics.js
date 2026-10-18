(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KarCastP0=api.create(root);})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function create(env){
  const enabled=!!env.location&&env.location.hostname==='staging.karcast.app'&&new URLSearchParams(env.location.search).get('p0')==='1';
  const id=()=>env.crypto.randomUUID();let runId=enabled?id():'NONE',seq=0,db=null,ready=false,memory=[],lost=0,busy=false,lastDraw=null,lastPTS=null,maxGap=0,draws=0,offset=null,uncertainty=null,lastSource=0,provider=()=>({}),lastSample=null,clockMs=null,storageError='';
  const status={enabled,runId,acked:0,pending:0,lost:0,storage:'INITIALIZING',lastAckEpochMs:null};
  const snapshot=()=>Object.assign({},status,{lost,maxGapMs:maxGap,lastPtsUs:lastPTS,clockOffsetMs:offset,clockUncertaintyMs:uncertainty,clockSampleEpochMs:clockMs});
  function event(kind,data={}){
   if(!enabled)return;const p=provider();const r={sequence:++seq,wallEpochMs:env.Date.now(),monoMs:env.performance.now(),timeOriginMs:env.performance.timeOrigin,event:kind,sessionId:p.sessionId||'UNKNOWN',socketId:p.peerId||'BROWSER_UNKNOWN',data};
   if(db&&ready){try{const tx=db.transaction(['events','meta'],'readwrite'),store=tx.objectStore('events');store.put(r);tx.objectStore('meta').put(seq,'sequence');const count=store.count();count.onsuccess=()=>{if(count.result>20000){const cursor=store.openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c){c.delete();lost++;status.pending=Math.max(0,status.pending-1);}};}};tx.onerror=()=>{lost++;storageError='WRITE_FAILED';};}catch(_){lost++;storageError='WRITE_FAILED';}}
   else {memory.push(r);if(memory.length>256){memory.shift();lost++;}}
   status.pending++;return r;
  }
  function frame(ptsUs,semantics='CANVAS_DRAW_SUBMISSION'){if(!enabled)return;const now=env.performance.now();if(lastDraw!==null){const gap=now-lastDraw;maxGap=Math.max(maxGap,gap);if(gap>1000)event('PRESENTATION_GAP',{gapMs:gap,fromMonoMs:lastDraw,toMonoMs:now,lastPtsUs:lastPTS,ptsUs,sourceFrames:provider().sourceFrames,semantics});}lastDraw=now;lastPTS=ptsUs;draws++;}
  function batch(){return new Promise(resolve=>{if(!db){resolve(memory.slice(0,32));return;}try{const tx=db.transaction('events','readonly'),items=[];const q=tx.objectStore('events').openCursor();q.onsuccess=()=>{const c=q.result;if(c&&items.length<32){items.push(c.value);c.continue();}else resolve(items);};q.onerror=()=>resolve([]);}catch(_){resolve([]);}});}
  async function upload(){
   if(!enabled||busy||!ready)return;busy=true;
   try{const items=await batch();if(!items.length)return;const start=env.Date.now();const response=await env.fetch('/p0/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId,events:items}),signal:env.AbortSignal.timeout(3000)});if(!response.ok)throw new Error('HTTP');const reply=await response.json();
    if(reply.runId!==runId||!Array.isArray(reply.acked)||reply.acked.some(n=>!items.some(e=>e.sequence===n)))throw new Error('ACK');
    if(db){const tx=db.transaction('events','readwrite');for(const n of reply.acked)tx.objectStore('events').delete(n);}else memory=memory.filter(e=>!reply.acked.includes(e.sequence));
    status.acked+=reply.acked.length;status.pending=Math.max(0,status.pending-reply.acked.length);status.lastAckEpochMs=env.Date.now();status.lastAckRttMs=env.Date.now()-start;
   }catch(_){status.lastUploadFailureEpochMs=env.Date.now();}finally{busy=false;}
  }
  async function calibrate(){if(!enabled)return;try{let best=null;for(let i=0;i<3;i++){const before=env.Date.now();const r=await env.fetch('/p0/time',{signal:env.AbortSignal.timeout(3000)});const j=await r.json();const after=env.Date.now(),rtt=after-before;if(!best||rtt<best.rtt)best={rtt,offset:j.serverEpochMs-(before+after)/2};}offset=best.offset;uncertainty=best.rtt/2;clockMs=env.Date.now();event('CLOCK_CALIBRATION',{serverMinusBrowserMs:offset,uncertaintyMs:uncertainty});}catch(_){event('COVERAGE_GAP',{reason:'CLOCK_ALIGNMENT_UNAVAILABLE'});}}
  function sample(){if(!enabled)return;const p=provider(),now=env.performance.now(),wall=env.Date.now();if(lastSample!==null&&now-lastSample>12500)event('COVERAGE_GAP',{reason:'BROWSER_SCHEDULING_GAP',sampleGapMs:now-lastSample});lastSample=now;const source=p.sourceFrames||0;
   const indicator=env.document?.getElementById?.('p0-status');if(indicator){indicator.textContent=`P0 ACK ${status.acked} pending ${status.pending} loss ${lost} ${status.storage}`;indicator.style.color=status.lastAckEpochMs&&wall-status.lastAckEpochMs<15000?'#9f9':'#ffb';}
   const sourceDelta=source-lastSource;event('BROWSER_HEALTH',Object.assign({},p,{draws,lastDrawMonoMs:lastDraw,lastPtsUs:lastPTS,maxGapMs:maxGap,sourceDelta,pageVisibility:env.document?.visibilityState,drawSemantics:'CANVAS_DRAW_SUBMISSION',telemetry:snapshot(),storageError}));lastSource=source;
   if(lastDraw!==null&&now-lastDraw>1000)event('PRESENTATION_NOT_ADVANCING',{observedDurationMs:now-lastDraw,sourceDelta,sourceFrames:source,pageVisibility:env.document?.visibilityState,classification:sourceDelta>0?'SOURCE_ADVANCING':'SOURCE_STATIC_OR_UNKNOWN'});
   if(lost)event('COVERAGE_GAP',{reason:'BROWSER_STORAGE_OR_MEMORY_LOSS',lost});
  }
  async function initialize(){
   if(!enabled)return;
   try{const request=env.indexedDB.open('karcast-v39-field-'+(new URLSearchParams(env.location.search).get('field')||runId),1);request.onupgradeneeded=()=>{request.result.createObjectStore('events',{keyPath:'sequence'});request.result.createObjectStore('meta');};
    request.onsuccess=()=>{db=request.result;status.storage='INDEXEDDB';let recoveredSequence=0;const tx=db.transaction(['meta','events'],'readwrite'),meta=tx.objectStore('meta'),q=meta.get('run');q.onsuccess=()=>{if(q.result){runId=q.result;status.runId=runId;}else meta.put(runId,'run');};const sequence=meta.get('sequence');sequence.onsuccess=()=>{recoveredSequence=sequence.result||0;};const count=tx.objectStore('events').count();count.onsuccess=()=>{status.pending=count.result;};tx.oncomplete=()=>{const early=memory;memory=[];seq=recoveredSequence;ready=true;for(const r of early)event(r.event,r.data);event('BROWSER_PAGE_START',{visibility:env.document?.visibilityState});};tx.onerror=()=>{db=null;ready=true;status.storage='UNAVAILABLE_MEMORY_ONLY';};};
    request.onerror=()=>{status.storage='UNAVAILABLE_MEMORY_ONLY';ready=true;event('COVERAGE_GAP',{reason:'INDEXEDDB_UNAVAILABLE'});};
   }catch(_){status.storage='UNAVAILABLE_MEMORY_ONLY';ready=true;event('COVERAGE_GAP',{reason:'INDEXEDDB_UNAVAILABLE'});}
   env.document?.addEventListener('visibilitychange',()=>event('PAGE_VISIBILITY',{visibility:env.document.visibilityState}));
   env.addEventListener?.('pagehide',()=>event('BROWSER_PAGE_HIDE'));
   env.setInterval(()=>{sample();upload();},5000);env.setInterval(calibrate,60000);calibrate();
   // Marker controls affect telemetry only, never Android Auto or playback.
   if(env.document){const bar=env.document.createElement('div');bar.id='p0-markers';bar.style='position:fixed;top:0;right:0;max-width:45vw;z-index:10000;font:11px sans-serif;background:#222;color:white;display:flex;flex-wrap:wrap';const indicator=env.document.createElement('span');indicator.id='p0-status';indicator.style='width:100%';indicator.textContent='P0 INITIALIZING';bar.appendChild(indicator);for(const name of ['BASELINE','MIN10','MIN20','MIN30','VOICE_OK','VOICE_FAIL','WHATSAPP_SEEN','TEAMS_SEEN','TEST_END']){const b=env.document.createElement('button');b.textContent=name;b.onclick=()=>event('MANUAL_OBSERVATION',{action:name});bar.appendChild(b);}env.document.body.appendChild(bar);}
  }
  const safe=f=>(...args)=>{try{return f(...args);}catch(_){lost++;}};
  const api={event:safe(event),frame:safe(frame),snapshot,bind:f=>{provider=f;},sample:safe(sample),upload,calibrate,initialize};initialize();return api;
 }
 return {create};
});
