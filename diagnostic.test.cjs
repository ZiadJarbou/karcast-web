'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {DiagnosticStore}=require('./diagnostic-store.cjs');
const {create}=require('./public/p0-diagnostics.js');
const run='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const event=n=>({sequence:n,wallEpochMs:1000+n,monoMs:n,event:'BROWSER_HEALTH',sessionId:'s',socketId:'peer',data:{presentedFrames:n}});
test('HTTP acknowledgment follows persistent write; process replacement retains prior events',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'karcast-p0-'));const a=new DiagnosticStore(dir);const ack=await a.append({runId:run,events:[event(1)]});assert.deepEqual(ack.acked,[1]);await a.close();
 const before=await fs.readdir(dir);const original=await fs.readFile(path.join(dir,before[0]));const b=new DiagnosticStore(dir);await b.append({runId:run,events:[event(2)]});await b.close();assert.deepEqual(await fs.readFile(path.join(dir,before[0])),original);
 const data=(await Promise.all((await fs.readdir(dir)).map(f=>fs.readFile(path.join(dir,f),'utf8')))).join('\n');assert.match(data,/"sequence":1/);assert.match(data,/"sequence":2/);
});
test('malformed/oversized diagnostics rejected without changing any transport',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'karcast-p0-'));const a=new DiagnosticStore(dir);
 await assert.rejects(()=>a.append({runId:'../../invalid',events:[event(1)]}));await assert.rejects(()=>a.append({runId:run,events:[{...event(1),data:{x:'x'.repeat(9000)}}]}));await a.close();assert.deepEqual(await fs.readdir(dir),[]);
});
test('server diagnostic retention stays bounded and emits coverage markers',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'karcast-p0-'));const a=new DiagnosticStore(dir,{maxSegment:2048,maxTotal:8192});
 for(let i=1;i<80;i++)await a.append({runId:run,events:[{...event(i),data:{padding:'x'.repeat(600)}}]});await a.close();
 const files=await fs.readdir(dir);const bytes=await Promise.all(files.map(f=>fs.readFile(path.join(dir,f))));assert.ok(bytes.reduce((n,b)=>n+b.length,0)<=8192);assert.match(bytes.map(b=>b.toString()).join(''),/STORAGE_RETENTION_EVICTION/);
});
function environment(){let mono=0,wall=10000;const intervals=[];return {location:{hostname:'staging.karcast.app',search:'?metrics=1&p0=1'},crypto:{randomUUID:()=>run},performance:{now:()=>mono,timeOrigin:10000},Date:{now:()=>wall},AbortSignal:{timeout:()=>({})},setInterval:f=>{intervals.push(f);return 1;},fetch:async()=>{throw new Error('offline');},advance:n=>{mono+=n;wall+=n;},intervals};}
test('browser diagnostics offline/unsupported storage never calls recovery or socket operations',async()=>{
 const env=environment();let closes=0,restarts=0;env.WebSocket=()=>{closes++;};env.recoverRawVideo=()=>{restarts++;};const d=create(env);d.bind(()=>({sessionId:'s',peerId:'p',sourceFrames:20}));
 d.frame(123);env.advance(1500);d.frame(456);d.sample();await d.upload();assert.equal(closes,0);assert.equal(restarts,0);assert.equal(d.snapshot().maxGapMs,1500);assert.equal(d.snapshot().storage,'UNAVAILABLE_MEMORY_ONLY');assert.ok(d.snapshot().pending>0);
});
test('bounded memory loss remains observable when IndexedDB is unavailable',()=>{
 const env=environment();const d=create(env);for(let n=0;n<600;n++)d.event('SAMPLE');assert.ok(d.snapshot().lost>=344);assert.equal(d.snapshot().storage,'UNAVAILABLE_MEMORY_ONLY');
});
test('browser upload removes only confirmed acknowledged events',async()=>{
 const env=environment();env.fetch=async(url,options)=>url==='/p0/time'?{json:async()=>({serverEpochMs:10000})}:{ok:true,json:async()=>({runId:run,acked:JSON.parse(options.body).events.map(e=>e.sequence)})};const d=create(env);d.event('MANUAL_OBSERVATION',{action:'MAPS_VISIBLE'});await d.upload();assert.ok(d.snapshot().acked>0);assert.ok(d.snapshot().lastAckEpochMs);
});
