'use strict';
// V85 (CR-20261022-TAADA-STYLE-PLAY-RELEASE B/C/D): public car-identity API on app.karcast.app.
// The phone never reaches the VPS during a session (its VPN owns the VPS address), so this server
// verifies the phone (Play Integrity + nonce + rate limits) and fetches the identity from the VPS issuer.
const https=require('node:https'), crypto=require('node:crypto');
const PACKAGE='com.aistudio.teslastream.xkpmzq';
const ISSUER_HOST='car.karcast.app';
const NONCE_TTL_MS=5*60e3, STATUS_TTL_MS=60e3, TOKEN_MAX_AGE_MS=5*60e3;
const LIMITS={install:6,ip:30,windowMs:3600e3};
const INSTALL_ID=/^[a-f0-9]{32}$/;

const b64url=b=>Buffer.from(b).toString('base64url');
function sign(secret,ts,pathname){return crypto.createHmac('sha256',secret).update(`${ts}:${pathname}`).digest('hex');}

/**
 * Stateless nonce bound to the install id: base64url("<expiryMs>.<random>.<hmac>").
 * Play Integrity requires a URL-safe Base64 nonce of 16-500 characters.
 */
function issueNonce(secret,installId,now){
 const body=`${now+NONCE_TTL_MS}.${crypto.randomBytes(12).toString('hex')}`;
 return b64url(`${body}.${crypto.createHmac('sha256',secret).update(`${installId}:${body}`).digest('hex')}`);
}
function nonceValid(secret,installId,nonce,now){
 if(typeof nonce!=='string'||!/^[A-Za-z0-9_-]{16,500}$/.test(nonce))return false;
 const m=/^(\d{13})\.([a-f0-9]{24})\.([a-f0-9]{64})$/.exec(Buffer.from(nonce,'base64url').toString('latin1'));
 if(!m||Number(m[1])<now)return false;
 const want=Buffer.from(crypto.createHmac('sha256',secret).update(`${installId}:${m[1]}.${m[2]}`).digest('hex'),'hex');
 const got=Buffer.from(m[3],'hex');return want.length===got.length&&crypto.timingSafeEqual(want,got);
}

class RateLimiter{
 constructor(now){this.now=now;this.hits=new Map();}
 allow(key,max){
  const t=this.now(),list=(this.hits.get(key)||[]).filter(x=>t-x<LIMITS.windowMs);
  if(list.length>=max){this.hits.set(key,list);return false;}
  list.push(t);this.hits.set(key,list);return true;
 }
}

/** Checks a decoded Play Integrity payload against the request. Returns a reason string or null. */
function integrityProblem(payload,{nonce,certSha256,now}){
 const req=payload?.requestDetails||{},app=payload?.appIntegrity||{},dev=payload?.deviceIntegrity||{};
 if(req.requestPackageName!==PACKAGE)return 'package';
 if(req.nonce!==nonce)return 'nonce';
 if(!(Number(req.timestampMillis)>0)||Math.abs(now-Number(req.timestampMillis))>TOKEN_MAX_AGE_MS)return 'token_age';
 if(app.appRecognitionVerdict!=='PLAY_RECOGNIZED')return 'app_not_recognized';
 if(!certSha256||!(app.certificateSha256Digest||[]).includes(certSha256))return 'signing_cert';
 if(!(dev.deviceRecognitionVerdict||[]).includes('MEETS_DEVICE_INTEGRITY'))return 'device';
 return null;
}

/** Google decodeIntegrityToken with a service account (RS256 JWT → OAuth token), no dependencies. */
function googleDecoder(serviceAccountJson,request=httpsJson){
 const sa=JSON.parse(serviceAccountJson);
 let cached={token:null,exp:0};
 async function accessToken(now){
  if(cached.token&&cached.exp-60e3>now)return cached.token;
  const iat=Math.floor(now/1000);
  const unsigned=`${b64url(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64url(JSON.stringify({iss:sa.client_email,
   scope:'https://www.googleapis.com/auth/playintegrity',aud:'https://oauth2.googleapis.com/token',iat,exp:iat+3600}))}`;
  const jwt=`${unsigned}.${crypto.sign('RSA-SHA256',Buffer.from(unsigned),sa.private_key).toString('base64url')}`;
  const r=await request({host:'oauth2.googleapis.com',path:'/token',method:'POST',form:{grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt}});
  if(r.status!==200||!r.body?.access_token)throw new Error('oauth_failed');
  cached={token:r.body.access_token,exp:now+Number(r.body.expires_in||3600)*1000};return cached.token;
 }
 return async(integrityToken,now)=>{
  const token=await accessToken(now);
  const r=await request({host:'playintegrity.googleapis.com',path:`/v1/${PACKAGE}:decodeIntegrityToken`,method:'POST',
   headers:{authorization:`Bearer ${token}`},json:{integrity_token:integrityToken}});
  if(r.status!==200)throw new Error('decode_failed');
  return r.body?.tokenPayloadExternal;
 };
}

function httpsJson({host,path,method='GET',headers={},json,form}){
 return new Promise((resolve,reject)=>{
  const body=json?JSON.stringify(json):form?new URLSearchParams(form).toString():null;
  const h={...headers};if(body){h['content-type']=json?'application/json':'application/x-www-form-urlencoded';h['content-length']=Buffer.byteLength(body);}
  const req=https.request({host,path,method,headers:h,timeout:10000},res=>{let b='';res.setEncoding('utf8');
   res.on('data',d=>{b+=d;if(b.length>262144)req.destroy(new Error('too_large'));});
   res.on('end',()=>{let parsed=null;try{parsed=b?JSON.parse(b):null;}catch(_){}resolve({status:res.statusCode,body:parsed});});});
  req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',reject);if(body)req.write(body);req.end();
 });
}

/** HMAC-authenticated fetch from the VPS issuer. */
function issuerClient(secret,request=httpsJson){
 return async(pathname,now)=>{
  const ts=String(Math.floor(now/1000));
  return request({host:ISSUER_HOST,path:pathname,headers:{authorization:`KarCast-HMAC ${ts}.${sign(secret,ts,pathname)}`}});
 };
}

const META=b=>({status:b.status,serial:b.serial,notAfter:b.notAfter,sha256:b.sha256});

class CarIdentityService{
 /**
  * env: KARCAST_ISSUER_SECRET, KARCAST_NONCE_SECRET, KARCAST_PLAY_INTEGRITY_SA (JSON), KARCAST_PLAY_CERT_SHA256.
  * Missing pieces fail closed (503) instead of serving without checks.
  */
 constructor({env=process.env,now=()=>Date.now(),issuer,decoder,log=l=>console.log(l)}={}){
  this.now=now;this.log=log;
  this.nonceSecret=env.KARCAST_NONCE_SECRET||'';
  this.certSha256=(env.KARCAST_PLAY_CERT_SHA256||'').toLowerCase().replace(/:/g,'');
  this.issuer=issuer||(env.KARCAST_ISSUER_SECRET?issuerClient(env.KARCAST_ISSUER_SECRET):null);
  this.decoder=decoder||(env.KARCAST_PLAY_INTEGRITY_SA?googleDecoder(env.KARCAST_PLAY_INTEGRITY_SA):null);
  this.limiter=new RateLimiter(now);
  this.statusCache={value:null,at:0};
 }
 /** Cached VPS status for the car-page redirect and the phone; null when never known. */
 async status(){
  const t=this.now();
  if(this.statusCache.value&&t-this.statusCache.at<STATUS_TTL_MS)return this.statusCache.value;
  if(!this.issuer)return this.statusCache.value;
  try{const r=await this.issuer('/internal/car-identity/status',t);
   if(r.status===200&&r.body?.status){this.statusCache={value:META(r.body),at:t};}
  }catch(_){/* keep the last known value */}
  return this.statusCache.value;
 }
 /** Last known status without network, for the synchronous page redirect. */
 knownStatus(){return this.statusCache.value?.status||null;}
 challenge(body){
  if(!this.nonceSecret)return [503,{error:'unconfigured'}];
  if(!INSTALL_ID.test(body?.installId||''))return [400,{error:'install_id'}];
  return [200,{nonce:issueNonce(this.nonceSecret,body.installId,this.now())}];
 }
 async identity(body,ip){
  const t=this.now();
  if(!this.nonceSecret||!this.issuer||!this.decoder||!this.certSha256)return [503,{error:'integrity_unconfigured'}];
  const installId=body?.installId||'';
  if(!INSTALL_ID.test(installId))return [400,{error:'install_id'}];
  const ipHash=crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0,16);
  if(!this.limiter.allow('i:'+installId,LIMITS.install)||!this.limiter.allow('a:'+ipHash,LIMITS.ip))return [429,{error:'rate_limited'}];
  if(!nonceValid(this.nonceSecret,installId,body.nonce,t))return [403,{error:'nonce'}];
  if(typeof body.integrityToken!=='string'||body.integrityToken.length>16384||!body.integrityToken)return [400,{error:'integrity_token'}];
  let verdict;
  try{verdict=integrityProblem(await this.decoder(body.integrityToken,t),{nonce:body.nonce,certSha256:this.certSha256,now:t});}
  catch(e){verdict='decode_error';}
  if(verdict){this.log(JSON.stringify({event:'identity_refused',installId,ipHash,reason:verdict}));return [403,{error:'integrity',reason:verdict}];}
  let r;try{r=await this.issuer('/internal/car-identity',t);}catch(_){return [502,{error:'issuer_unreachable'}];}
  if(r.status===409)return [409,{error:'revoked',...(r.body?META(r.body):{})}];
  if(r.status!==200||!r.body?.privateKeyPem)return [502,{error:'issuer'}];
  this.statusCache={value:META(r.body),at:t};
  this.log(JSON.stringify({event:'identity_issued',installId,ipHash,serial:r.body.serial}));
  return [200,{...META(r.body),certChainPem:r.body.certChainPem,privateKeyPem:r.body.privateKeyPem}];
 }
}
module.exports={CarIdentityService,issueNonce,nonceValid,integrityProblem,googleDecoder,issuerClient,RateLimiter,PACKAGE,LIMITS};
