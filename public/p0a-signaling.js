(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.KarCastP0A=api.create(root);})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function create(env){
  const enabled=env.location?.hostname==='staging.karcast.app'&&new URLSearchParams(env.location?.search||'').get('p0')==='1';
  if(!enabled)return {session(){},mark(){},snapshot(){return undefined;}};
  let pageId='UNKNOWN';try{pageId=env.crypto.randomUUID();}catch(_){}
  const state={pageId,browserSocketId:'UNKNOWN',wsGeneration:0,sessionHash:'UNKNOWN',registered:false,offerCreated:false,offerSubmitted:false,answerReceived:false,iceStarted:false,dataOpen:false};
  let owner=0;
  const event=(name,data={})=>{try{if(enabled)env.KarCastP0?.event('P0A_'+name,Object.assign({pageId:state.pageId,sessionHash:state.sessionHash},data));}catch(_) {}};
  function session(value){
   const version=++owner;
   for(const key of ['registered','offerCreated','offerSubmitted','answerReceived','iceStarted','dataOpen'])state[key]=false;
   state.sessionHash='UNKNOWN';
   // Hash only the high-entropy server session ID. Never retain a token, code or SDP.
   try { Promise.resolve(env.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value||''))).then(bytes=>{
    if(version!==owner)return;state.sessionHash=Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');
    event('SESSION_IDENTIFIED');
   }).catch(()=>event('COVERAGE_GAP',{reason:'SESSION_HASH_UNAVAILABLE'})); } catch(_) {event('COVERAGE_GAP',{reason:'SESSION_HASH_UNAVAILABLE'});}
  }
  function mark(name,detail={}){
   if(name==='WS_ATTEMPT'){state.wsGeneration++;try{state.browserSocketId=env.crypto.randomUUID();}catch(_){state.browserSocketId='UNKNOWN';}}
   const flags={BROWSER_REGISTERED:'registered',OFFER_CREATED:'offerCreated',OFFER_SUBMITTED:'offerSubmitted',ANSWER_RECEIVED:'answerReceived',ICE_STARTED:'iceStarted',DATA_CHANNEL_OPEN:'dataOpen'};
   if(flags[name])state[flags[name]]=true;
   // Detail is allowlisted; arbitrary error/close strings are never persisted.
   const safe={};for(const k of ['code','attempt','accepted'])if(['number','boolean'].includes(typeof detail[k]))safe[k]=detail[k];
   event(name,safe);
  }
  function snapshot(frames=0){let run='UNKNOWN';try{run=env.KarCastP0?.snapshot()?.runId||'UNKNOWN';}catch(_){}return Object.assign({},state,{browserRunId:run,presentedFrames:frames,
   browserClass:/Tesla/i.test(env.navigator?.userAgent||'')?'TESLA_UA':'OTHER_OR_UNKNOWN'});}
  event('PAGE_GENERATION');return {session,mark,snapshot};
 }
 return {create};
});
