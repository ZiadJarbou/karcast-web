'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {NotificationQueue, Microphone, microphoneCapability, install} = require('./public/session-features.js');
const sample = (id, ttlMs=20000) => ({type:'notification',id,app:'Test Chat',sender:'Sample',preview:'Hello',ttlMs});
test('bounded queue expires old items and rejects malformed payloads', () => {
  let now=0; const q=new NotificationQueue(()=>now,4);
  for(let i=0;i<10;i++) assert.equal(q.push(sample(String(i))),true);
  assert.equal(q.items.length,4); assert.equal(q.next().id,'6');
  assert.equal(q.push(sample('9')),false);
  assert.equal(q.push({...sample('bad'),preview:{html:'bad'}}),false);
  assert.equal(q.push(sample('expired',-1)),false);
  now=20001; assert.equal(q.next(),null);
});
test('microphone feature detection never invokes getUserMedia automatically', () => {
  let calls=0; const env={isSecureContext:true,navigator:{mediaDevices:{getUserMedia(){calls++;}}}};
  assert.equal(microphoneCapability(env).getUserMedia,true); new Microphone(env); assert.equal(calls,0);
});
test('missing API and insecure contexts fail clearly', async () => {
  for(const env of [{isSecureContext:true,navigator:{}},{isSecureContext:false,navigator:{mediaDevices:{}}}]) {
    const m=new Microphone(env); await m.request(); assert.equal(m.state,'Microphone Unavailable');
  }
});
test('denial records exact error, with no repeated automatic prompts', async () => {
  let calls=0; const m=new Microphone({isSecureContext:true,navigator:{mediaDevices:{getUserMedia:async()=>{calls++;throw Object.assign(new Error('Denied by test'),{name:'NotAllowedError'});}}}});
  await m.request(); assert.equal(m.state,'Microphone Permission Denied'); assert.equal(m.result.errorName,'NotAllowedError'); assert.equal(calls,1);
});
test('only live unmuted audio tracks are active and stop releases tracks', async () => {
  let stopped=0; const track={readyState:'live',enabled:true,muted:false,stop(){stopped++;},addEventListener(){}};
  const m=new Microphone({isSecureContext:true,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]})}}});
  await m.request(); assert.equal(m.state,'Microphone Active'); m.stop(); assert.equal(stopped,1); assert.equal(m.state,'Microphone Off');
});
test('empty tracks and late permission resolution after shutdown fail safely', async () => {
  const m=new Microphone({isSecureContext:true,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[],getAudioTracks:()=>[]})}}});
  await m.request(); assert.equal(m.state,'Microphone Unavailable');
  let resolve,stopped=0; const late=new Microphone({isSecureContext:true,navigator:{mediaDevices:{getUserMedia:()=>new Promise(r=>resolve=r)}}});
  const request=late.request(); late.stop(); resolve({getTracks:()=>[{stop(){stopped++;}}]}); await request;
  assert.equal(late.state,'Microphone Off'); assert.equal(stopped,1);
});
function fakeDom(fail=false) {
  const elements=[], listeners={}, timers=new Map(); let n=0;
  function element(tag) { return {tag,children:[],hidden:false,textContent:'',append(...x){this.children.push(...x);},appendChild(x){this.children.push(x);},replaceChildren(...x){this.children=x;},setAttribute(){}}; }
  const doc={visibilityState:'visible',body:element('body'),createElement(tag){if(fail)throw Error('UI unavailable');const e=element(tag);elements.push(e);return e;},addEventListener(k,f){listeners[k]=f;}};
  doc.body.classList={values:new Set(),add(name){this.values.add(name);}};
  const env={document:doc,isSecureContext:false,navigator:{},addEventListener(){}};
  const peer={createDataChannel(label, options){assert.equal(label,'karcast-features'); assert.equal(options.maxRetransmits,0);return peer.channel={readyState:'open',bufferedAmount:0,send(){},close(){}};}};
  return {doc,env,peer,elements,listeners,timers};
}
test('overlay uses text nodes, dismisses manually and rejects malformed events', () => {
  const dom=fakeDom(), feature=install(dom.env,()=>({uiState:'CONNECTED',mediaStarted:true}));feature.attach(dom.peer);
  assert(dom.doc.body.classList.values.has('karcast-controls-reserved'),'Toolbar reserves its own space outside native AA');
  dom.peer.channel.onmessage({data:JSON.stringify(sample('one'))});
  const card=dom.elements.find(e=>e.id==='karcast-notification'); assert.equal(card.hidden,false); assert.equal(card.children[0].textContent,'Test Chat');
  card.children.find(e=>e.textContent==='Dismiss').onclick(); assert.equal(card.hidden,true);
  dom.peer.channel.onmessage({data:'{bad'});assert.equal(card.hidden,true);feature.detach();
});
test('optional UI failure and transport failure cannot throw into video caller', () => {
  const dom=fakeDom(true); const feature=install(dom.env,()=>{throw Error('sample');});
  assert.doesNotThrow(()=>feature.attach({createDataChannel(){throw Error('transport');}}));
  assert.doesNotThrow(()=>feature.transition('CONNECTED','RECONNECTING','test')); assert.doesNotThrow(()=>feature.detach());
});
test('overlay automatically expires without requesting browser Notification permission', async () => {
  const dom=fakeDom(), feature=install(dom.env,()=>({uiState:'CONNECTED',mediaStarted:true}));feature.attach(dom.peer);
  dom.peer.channel.onmessage({data:JSON.stringify(sample('short',40))});
  const card=dom.elements.find(e=>e.id==='karcast-notification'); assert.equal(card.hidden,false);
  await new Promise(r=>setTimeout(r,70)); assert.equal(card.hidden,true); feature.detach();
});
