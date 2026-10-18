'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
let fixture=fs.readFileSync('recovery-episode-test.js','utf8').split('(async()=>{')[0];
fixture=fixture.replace('const nodes=new Map();','const draws=[]; const rect={left:0,top:0,width:1440,height:900}; const nodes=new Map();')
 .replace('hidden:true,style:{},','hidden:true,style:{setProperty(){}},getBoundingClientRect(){return rect;},')
 .replace('drawImage(){','drawImage(...args){draws.push(args);')
 .replace('return{packet,drain,hooks,node,','return{packet,drain,hooks,node,draws,rect,socket:()=>socket,');
const harness=new Function('require','process',fixture+'\nreturn harness;')(require,process);
(async()=>{
 for(const path of ['direct','relay']) {
  const h=harness(path); await h.ready();
  const join=h.socket().sent.find(m=>m.type==='join');
  assert.deepEqual(JSON.parse(JSON.stringify(join.viewport)),{schema:2,width:1440,height:900});
  for(const layout of [
   {schema:2,width:1280,height:720,left:370,top:0,visibleWidth:540,visibleHeight:720},
   {schema:2,width:1280,height:720,left:0,top:200,visibleWidth:1280,visibleHeight:320}
  ]) {
   const t=harness(path);await t.ready(); t.hooks.applyVideoLayout(layout);
   t.packet(true,1000000); t.drain();
   assert.equal(t.draws.length,1,'One full native scene draw; no duplicated/relocated dock');
   assert.deepEqual(t.draws[0].slice(1,5),[layout.left,layout.top,layout.visibleWidth,layout.visibleHeight]);
   const g=t.hooks.presentationGeometry(t.rect,1280,720);
   assert.equal(g.dockHeight,0);
   assert.equal(g.width/g.frameHeight,layout.visibleWidth/layout.visibleHeight);
   for(const [x,y] of [[0,0],[1,1],[.01,.5],[.99,.5],[.5,.99]]) {
    const p=t.hooks.getTouchPoint({clientX:g.left+x*g.width,clientY:g.top+y*g.frameHeight});
    assert(p);assert(Math.abs(p.x-x)<1e-8);assert(Math.abs(p.y-y)<1e-8);
   }
   assert.equal(t.hooks.getTouchPoint({clientX:g.left-1,clientY:g.top+10}),null);
   assert.equal(t.hooks.getTouchPoint({clientX:g.left+10,clientY:g.top-1}),null);
   const wrong={...layout,left:1};t.hooks.applyVideoLayout(wrong);
   t.hooks.applyVideoLayout({width:1280,height:720,left:148,top:0,visibleWidth:984,visibleHeight:720,dockHeight:72});
   assert.equal(t.hooks.presentationGeometry(t.rect,1280,720).width,g.width,'Late malformed/legacy layout cannot mutate pinned scene');
   t.rect.width=768;t.rect.height=1024;t.hooks.updatePresentationLayout();
   assert.equal(t.hooks.presentationGeometry(t.rect,1280,720).width/t.hooks.presentationGeometry(t.rect,1280,720).frameHeight,layout.visibleWidth/layout.visibleHeight);
  }
 }
 console.log('PASS responsive AA: DIRECT/RELAY viewport handshake, single full-scene crop, bottom/side edge mapping, letterbox rejection, pinned resize and malformed metadata');
})().catch(e=>{console.error(e);process.exitCode=1;});
