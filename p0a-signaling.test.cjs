'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {create}=require('./public/p0a-signaling.js');
function env(){const records=[];let sockets=0,retries=0;return {records,location:{hostname:'staging.karcast.app',search:'?p0=1'},navigator:{userAgent:'Tesla browser'},crypto:{randomUUID:crypto.randomUUID,subtle:crypto.webcrypto.subtle},KarCastP0:{event:(n,d)=>records.push({n,d}),snapshot:()=>({runId:'11111111-2222-3333-4444-555555555555'})},WebSocket:()=>{sockets++},scheduleReconnect:()=>{retries++},counts:()=>({sockets,retries})};}
test('observer flags/correlation never send, create socket, reconnect or store payload',async()=>{
 const e=env(),t=create(e);t.session('session-high-entropy');t.mark('BROWSER_REGISTERED');t.mark('OFFER_CREATED',{sdp:'SECRET SDP',token:'secret'});t.mark('OFFER_SUBMITTED',{accepted:true});t.mark('ANSWER_RECEIVED');t.mark('DATA_CHANNEL_OPEN');
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.deepEqual(e.counts(),{sockets:0,retries:0});const s=t.snapshot(10);assert.equal(s.presentedFrames,10);assert.equal(s.browserClass,'TESLA_UA');assert.equal(s.registered,true);assert.match(s.sessionHash,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(e.records).includes('SECRET SDP'));assert.ok(!JSON.stringify(e.records).includes('session-high-entropy'));
});
test('throwing recorder cannot affect caller or recovery',()=>{const e=env();e.KarCastP0.event=()=>{throw Error('storage failure')};const t=create(e);assert.doesNotThrow(()=>t.mark('ANSWER_RECEIVED'));assert.deepEqual(e.counts(),{sockets:0,retries:0});});
test('missing crypto and failing snapshot do not interrupt signaling caller',()=>{const e=env();e.crypto.subtle=undefined;e.KarCastP0.snapshot=()=>{throw Error('observer failure')};const t=create(e);assert.doesNotThrow(()=>t.session('session'));assert.equal(t.snapshot().browserRunId,'UNKNOWN');assert.deepEqual(e.counts(),{sockets:0,retries:0});});
test('session hash completion cannot overwrite newer correlation',async()=>{
 const e=env(),pending=[];e.crypto.subtle={digest:()=>new Promise(resolve=>pending.push(resolve))};const t=create(e);t.session('old');t.session('new');pending[1](new Uint8Array(32).fill(2));await Promise.resolve();pending[0](new Uint8Array(32).fill(1));await Promise.resolve();assert.equal(t.snapshot().sessionHash,'02'.repeat(32));
});

test('absent/disabled parameters and non-staging host are fully inert',()=>{
 for(const [hostname,search] of [['staging.karcast.app',''],['staging.karcast.app','?metrics=1'],['staging.karcast.app','?p0=0'],['app.karcast.app','?p0=1']]){
  const e=env();e.location={hostname,search};e.crypto={get randomUUID(){throw Error('must not access crypto')},get subtle(){throw Error('must not hash')}};
  const t=create(e);t.session('SECRET');t.mark('BROWSER_REGISTERED');assert.equal(t.snapshot(9),undefined);
  assert.deepEqual(e.records,[]);assert.deepEqual(e.counts(),{sockets:0,retries:0});
  assert.equal(JSON.stringify({type:'presence',p0a:t.snapshot()}),'{"type":"presence"}');
 }
});

test('optional presence correlation contains no raw session/SDP/token/notification',async()=>{
 const e=env(),t=create(e);t.session('private-session-identifier');t.mark('WS_ATTEMPT');t.mark('OFFER_CREATED',{sdp:'SDP_SENTINEL',token:'TOKEN_SENTINEL',notification:'NOTIFICATION_SENTINEL',address:'IP_SENTINEL'});
 await new Promise(r=>setTimeout(r,20));const data=JSON.stringify({records:e.records,presence:t.snapshot(12)});
 for(const secret of ['private-session-identifier','SDP_SENTINEL','TOKEN_SENTINEL','NOTIFICATION_SENTINEL','IP_SENTINEL'])assert.ok(!data.includes(secret));
 assert.match(t.snapshot().sessionHash,/^[a-f0-9]{64}$/);
});
