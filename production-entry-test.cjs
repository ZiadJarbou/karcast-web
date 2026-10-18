'use strict';
// Boots the deploy entry exactly as Hostinger does (npm start -> index.js -> index.cjs) on a free port
// and checks that it is the production owner, not the staging/P0 server.
const assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),{spawn}=require('node:child_process');
const pkg=require('./package.json'),identity=require('./production-identity.json');
assert.equal(pkg.scripts.start,'node index.js');assert.equal(pkg.main,'index.js');
const freePort=()=>new Promise(r=>{const s=net.createServer().listen(0,()=>{const p=s.address().port;s.close(()=>r(p));});});
const get=(port,p,host='app.karcast.app')=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:p,headers:{Host:host}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({status:res.statusCode,body:b}));}).on('error',reject);});
(async()=>{
 const port=await freePort();
 const child=spawn(process.execPath,['index.js'],{cwd:__dirname,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 try{
  let health;
  for(let i=0;i<50&&!health;i++){try{health=await get(port,'/health');}catch(_){await new Promise(r=>setTimeout(r,100));}}
  assert.ok(health,'entry did not listen on PORT');
  const h=JSON.parse(health.body);
  assert.equal(h.service,'app.karcast.app');assert.equal(h.signalingOwner,'app.karcast.app');assert.equal(h.browserBuild,identity.browserBuild);
  assert.equal(h.staging,undefined);
  assert.equal((await get(port,'/p0a-build-identity.json')).status,404);
  assert.equal((await get(port,'/health','staging.karcast.app')).status,421);
  console.log('PASS production entry boots via index.js on PORT as app.karcast.app owner');
 }finally{child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
