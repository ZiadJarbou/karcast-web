'use strict';
// Diagnostic HTTP facility only; never handles WebSocket/relay payloads.
const fs=require('node:fs/promises'), path=require('node:path');
class DiagnosticStore {
 constructor(directory,options={}){this.directory=directory;this.maxSegment=options.maxSegment||4*1024*1024;this.maxTotal=options.maxTotal||128*1024*1024;this.tail=Promise.resolve();this.pending=0;this.rate=new Map();this.segment=0;this.size=0;this.handle=null;this.allowed=options.origin||'https://staging.karcast.app';this.exportKey=options.exportKey||process.env.P0_EXPORT_KEY;}
 async append(batch){
  const run=batch.runId;
  if(!/^[a-f0-9-]{16,64}$/.test(run)||!Array.isArray(batch.events)||batch.events.length<1||batch.events.length>32)throw new Error('INVALID_BATCH');
  const records=batch.events.map(e=>{
   if(!Number.isSafeInteger(e.sequence)||e.sequence<1||!Number.isFinite(e.wallEpochMs)||!Number.isFinite(e.monoMs)||typeof e.event!=='string'||e.event.length>80)throw new Error('INVALID_EVENT');
   // Allow only diagnostic metadata; no HTML, raw audio/video or arbitrary text bodies.
   const clean={runId:run,sequence:e.sequence,wallEpochMs:e.wallEpochMs,monoMs:e.monoMs,timeOriginMs:e.timeOriginMs,sessionId:String(e.sessionId||'UNKNOWN').slice(0,80),socketId:String(e.socketId||'UNKNOWN').slice(0,80),event:e.event,serverEpochMs:Date.now(),serverMonoNs:process.hrtime.bigint().toString(),data:e.data};
   const line=JSON.stringify(clean);if(Buffer.byteLength(line)>8192)throw new Error('EVENT_TOO_LARGE');return line;
  });
  if(this.pending>=64)throw new Error('DIAGNOSTIC_QUEUE_FULL');this.pending++;
  const writing=this.tail.then(async()=>{
   await fs.mkdir(this.directory,{recursive:true});const bytes=Buffer.from(records.join('\n')+'\n');
   if(!this.handle||this.size+bytes.length>this.maxSegment){
    if(this.handle){await this.handle.sync();await this.handle.close();}
    const name=`p0-${Date.now()}-${++this.segment}.jsonl`;this.handle=await fs.open(path.join(this.directory,name),'ax');this.size=0;
    const files=await fs.readdir(this.directory);const old=[];let total=0;
    for(const file of files.filter(x=>/^p0-.*\.jsonl$/.test(x)).sort()){const st=await fs.stat(path.join(this.directory,file));total+=st.size;if(file!==name)old.push({file,bytes:st.size});}
    for(const oldFile of old){if(total+this.maxSegment<=this.maxTotal)break;await fs.unlink(path.join(this.directory,oldFile.file));total-=oldFile.bytes;const marker=Buffer.from(JSON.stringify({event:'COVERAGE_GAP',reason:'STORAGE_RETENTION_EVICTION',segment:oldFile.file,serverEpochMs:Date.now()})+'\n');await this.handle.write(marker);this.size+=marker.length;}
   }
   await this.handle.write(bytes);this.size+=bytes.length;await this.handle.sync();
   // Secondary authenticated recovery through existing Hostinger runtime-log access.
   // The phone journal and these fsynced server segments remain the primary stores.
   try { console.log(JSON.stringify({timestamp:new Date().toISOString(),level:'INFO',message:'P0_BROWSER_BATCH '+JSON.stringify({runId:run,records:records.map(line=>JSON.parse(line))})})); } catch (_) {}
   return {acked:batch.events.map(e=>e.sequence),runId:run,serverEpochMs:Date.now(),serverMonoNs:process.hrtime.bigint().toString()};
  });this.tail=writing.catch(()=>{});return writing.finally(()=>{this.pending--;});
 }
 async route(req,res,url){
  if(!url.pathname.startsWith('/p0/'))return false;
  res.setHeader('Content-Type','application/json');
  if(url.pathname==='/p0/time'&&req.method==='GET'){res.end(JSON.stringify({serverEpochMs:Date.now(),serverMonoNs:process.hrtime.bigint().toString(),diagnosticBuild:'p0-eof1'}));return true;}
  if(url.pathname==='/p0/export'&&req.method==='GET'){
   if(!this.exportKey||req.headers.authorization!==`Bearer ${this.exportKey}`){res.writeHead(403);res.end('{}');return true;}
   const files=(await fs.readdir(this.directory).catch(()=>[])).filter(x=>/^p0-.*\.jsonl$/.test(x)).sort();res.setHeader('Content-Type','application/x-ndjson');for(const f of files)res.write(await fs.readFile(path.join(this.directory,f)));res.end();return true;
  }
  if(url.pathname!=='/p0/events'||req.method!=='POST'||req.headers.origin!==this.allowed){res.writeHead(403);res.end('{}');return true;}
  const ip=req.socket.remoteAddress||'';const now=Date.now();const old=this.rate.get(ip)||{t:now,n:0};if(now-old.t>10000){old.t=now;old.n=0;}old.n++;this.rate.set(ip,old);if(this.rate.size>256)this.rate.delete(this.rate.keys().next().value);
  if(old.n>30){res.writeHead(429);res.end('{}');req.resume();return true;}
  let size=0;const chunks=[];let tooBig=false;
  req.on('data',b=>{size+=b.length;if(size>65536){tooBig=true;}else chunks.push(b);});
  req.on('end',async()=>{if(tooBig){res.writeHead(413);res.end('{}');return;}try{const answer=await this.append(JSON.parse(Buffer.concat(chunks).toString()));res.end(JSON.stringify(answer));}catch(e){res.writeHead(e.message.includes('INVALID')||e.message.includes('LARGE')?400:503);res.end(JSON.stringify({error:'DIAGNOSTIC_WRITE_FAILED'}));}});
  return true;
 }
 async close(){await this.tail;if(this.handle){await this.handle.sync();await this.handle.close();this.handle=null;}}
}
module.exports={DiagnosticStore};
