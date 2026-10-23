'use strict';
// V85 (CR-20261022-TAADA-STYLE-PLAY-RELEASE B/D/F): car-identity API and status-driven car link on app.karcast.app.
// Google and the VPS issuer are replaced by fakes; nothing leaves the machine.
const assert=require('node:assert/strict');
const http=require('node:http');
const {CarIdentityService,issueNonce,nonceValid,integrityProblem,RateLimiter,PACKAGE,LIMITS}=require('./car-identity.cjs');
const {ProductionServer,CAR_LINK,RELAY_LINK}=require('./production-server.cjs');
const env={KARCAST_NONCE_SECRET:'n'.repeat(40),KARCAST_PLAY_CERT_SHA256:'ab'.repeat(32)};
const INSTALL='0123456789abcdef0123456789abcdef';
let now=1_800_000_000_000;
const goodPayload=nonce=>({requestDetails:{requestPackageName:PACKAGE,nonce,timestampMillis:String(now)},
 appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',certificateSha256Digest:['ab'.repeat(32)]},
 deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}});
const issued={status:'ok',serial:'0679c3',notAfter:'2027-01-13T04:42:26.000Z',sha256:'cd'.repeat(32),certChainPem:'-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',privateKeyPem:'-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----\n'};
function fakeIssuer(state){return async(p)=>{state.calls.push(p);
 if(state.down)throw new Error('down');
 const meta={status:state.status,serial:issued.serial,notAfter:issued.notAfter,sha256:issued.sha256};
 if(p.endsWith('/status'))return {status:200,body:meta};
 return state.status==='revoked'?{status:409,body:meta}:{status:200,body:{...issued,status:state.status}};};}

(async()=>{
 // Nonce: bound to install id, expires, tamper-proof.
 const n=issueNonce(env.KARCAST_NONCE_SECRET,INSTALL,now);
 assert.ok(nonceValid(env.KARCAST_NONCE_SECRET,INSTALL,n,now));
 assert.ok(!nonceValid(env.KARCAST_NONCE_SECRET,'f'.repeat(32),n,now),'other install');
 assert.ok(!nonceValid(env.KARCAST_NONCE_SECRET,INSTALL,n,now+5*60e3+1),'expired');
 assert.ok(!nonceValid('x'.repeat(40),INSTALL,n,now),'other secret');
 assert.match(n,/^[A-Za-z0-9_-]{16,500}$/,'Play Integrity nonce format');
 assert.ok(!nonceValid(env.KARCAST_NONCE_SECRET,INSTALL,n.slice(0,-2)+'AA',now),'tampered');
 // Integrity verdict rules.
 const opts={nonce:n,certSha256:'ab'.repeat(32),now};
 assert.equal(integrityProblem(goodPayload(n),opts),null);
 const bad=(f)=>{const p=goodPayload(n);f(p);return integrityProblem(p,opts);};
 assert.equal(bad(p=>p.requestDetails.requestPackageName='evil'),'package');
 assert.equal(bad(p=>p.requestDetails.nonce='other'),'nonce');
 assert.equal(bad(p=>p.requestDetails.timestampMillis=String(now-6*60e3)),'token_age');
 assert.equal(bad(p=>p.appIntegrity.appRecognitionVerdict='UNRECOGNIZED_VERSION'),'app_not_recognized');
 assert.equal(bad(p=>p.appIntegrity.certificateSha256Digest=['00'.repeat(32)]),'signing_cert');
 assert.equal(bad(p=>p.deviceIntegrity.deviceRecognitionVerdict=[]),'device');
 // Rate limiter window.
 const rl=new RateLimiter(()=>now);for(let i=0;i<3;i++)assert.ok(rl.allow('k',3));assert.ok(!rl.allow('k',3));
 now+=LIMITS.windowMs;assert.ok(rl.allow('k',3),'window slides');

 // Fail closed when not configured.
 const bare=new CarIdentityService({env:{},now:()=>now});
 assert.equal(bare.challenge({installId:INSTALL})[0],503);
 assert.equal((await bare.identity({installId:INSTALL},'1.2.3.4'))[0],503);

 // Full HTTP path through the production server.
 const state={status:'ok',calls:[],down:false},logs=[];
 let decoded=null;
 const svc=new CarIdentityService({env,now:()=>now,issuer:fakeIssuer(state),decoder:async()=>decoded,log:l=>logs.push(JSON.parse(l))});
 const server=new ProductionServer({port:0,carIdentity:svc});await server.start();const port=server.server.address().port;
 const call=(p,{method='GET',body,host='app.karcast.app'}={})=>new Promise((resolve,reject)=>{
  const data=body===undefined?null:(typeof body==='string'?body:JSON.stringify(body));
  const req=http.request({host:'127.0.0.1',port,path:p,method,headers:{Host:host,...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},res=>{
   let b='';res.on('data',d=>b+=d);res.on('end',()=>{let j=null;try{j=JSON.parse(b);}catch(_){}resolve({status:res.statusCode,headers:res.headers,body:j,raw:b});});});
  req.on('error',reject);if(data)req.write(data);req.end();});
 try{
  // Car link follows the status; query requests serve the page.
  assert.ok(CAR_LINK.endsWith('&fallback=relay'),'M1: page may fall back to the internet relay');
  for(const p of ['/','/car','/car/']){const r=await call(p);assert.equal(r.status,302,p);assert.equal(r.headers.location,CAR_LINK);}
  assert.equal((await call(CAR_LINK)).status,200,'link target serves the page');
  assert.equal((await call('/i18n.js')).status,200,'V82 page asset');
  assert.equal((await call('/p0-diagnostics.js')).status,404,'P0 stays out of production');
  const health=(await call('/health')).body;assert.equal(health.carLink,'v85-1');assert.equal(health.carIdentity,'ok');
  // Status: public, never carries the key.
  const st=await call('/api/v1/car-identity/status');assert.equal(st.status,200);assert.equal(st.body.privateKeyPem,undefined);
  // Challenge → identity.
  assert.equal((await call('/api/v1/car-identity/challenge',{method:'POST',body:{installId:'bad'}})).status,400);
  assert.equal((await call('/api/v1/car-identity/challenge',{method:'POST',body:'{oops'})).status,400);
  assert.equal((await call('/api/v1/car-identity/challenge')).status,404,'GET not allowed');
  const ch=await call('/api/v1/car-identity/challenge',{method:'POST',body:{installId:INSTALL}});assert.equal(ch.status,200);
  const nonce=ch.body.nonce;
  decoded=goodPayload(nonce);decoded.appIntegrity.appRecognitionVerdict='UNEVALUATED';
  const refused=await call('/api/v1/car-identity',{method:'POST',body:{installId:INSTALL,nonce,integrityToken:'t'}});
  assert.equal(refused.status,403);assert.equal(refused.body.reason,'app_not_recognized');assert.equal(refused.body.privateKeyPem,undefined);
  assert.ok(logs.some(l=>l.event==='identity_refused'));
  assert.equal((await call('/api/v1/car-identity',{method:'POST',body:{installId:INSTALL,nonce:'1.2.3',integrityToken:'t'}})).status,403,'bad nonce');
  decoded=goodPayload(nonce);
  const ok=await call('/api/v1/car-identity',{method:'POST',body:{installId:INSTALL,nonce,integrityToken:'t'}});
  assert.equal(ok.status,200);assert.equal(ok.body.privateKeyPem,issued.privateKeyPem);assert.equal(ok.body.sha256,issued.sha256);
  assert.ok(logs.some(l=>l.event==='identity_issued'&&l.installId===INSTALL&&!('privateKeyPem' in l)),'issuance logged without key');
  // Rate limit per install.
  let last;for(let i=0;i<LIMITS.install;i++)last=await call('/api/v1/car-identity',{method:'POST',body:{installId:INSTALL,nonce,integrityToken:'t'}});
  assert.equal(last.status,429);
  // Revocation: identity refused, car link switches to the internet relay after the status cache expires.
  state.status='revoked';now+=61e3;
  const other='fedcba9876543210fedcba9876543210';
  const n2=(await call('/api/v1/car-identity/challenge',{method:'POST',body:{installId:other}})).body.nonce;decoded=goodPayload(n2);
  const rev=await call('/api/v1/car-identity',{method:'POST',body:{installId:other,nonce:n2,integrityToken:'t'}});
  assert.equal(rev.status,409);assert.equal(rev.body.privateKeyPem,undefined);
  assert.equal((await call('/')).headers.location,RELAY_LINK,'revoked → internet relay link');
  assert.equal((await call('/car')).headers.location,RELAY_LINK);
  // Issuer unreachable: last known status is kept.
  state.down=true;now+=61e3;assert.equal((await call('/')).headers.location,RELAY_LINK,'keeps last known status');
  state.down=false;state.status='ok';now+=61e3;assert.equal((await call('/')).headers.location,CAR_LINK,'back to local after re-issue');
  // Boundaries.
  assert.equal((await call('/api/v1/car-identity/status',{host:'evil.example'})).status,421);
  assert.equal((await call('/','POST' && {method:'POST'})).status,405);
  console.log('PASS v85 car-identity API, integrity checks, rate limits, revocation and status-driven car link');
 }finally{await server.stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
