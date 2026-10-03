'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const values = new Map();
const saved = {getItem:k=>values.get(k), setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
function load(hash='',storage=saved){
 const nodes=new Map(),sockets=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,style:{},classList:{toggle(){}},setAttribute(){},addEventListener(){},getContext(){return{};},play(){return Promise.resolve();}});return nodes.get(id);};
 class Socket {static OPEN=1;constructor(url,protocols){this.url=url;this.protocols=protocols;this.readyState=1;this.sent=[];sockets.push(this);}send(s){this.sent.push(JSON.parse(s));}close(){}}
 const window={location:{search:'',hash,pathname:'/'},localStorage:storage,history:{replaceState(){}},addEventListener(){}};
 vm.runInNewContext(fs.readFileSync('public/app.js','utf8'),{window,document:{getElementById:node},location:{protocol:'https:',host:'app.karcast.app'},URLSearchParams,WebSocket:Socket,setTimeout(){},setInterval(){},clearTimeout(){},clearInterval(){}});
 window.__KARCAST_TEST_HOOKS__.connectAndJoin();
 if(sockets[0])sockets[0].onopen();
 return {sockets,node};
}
const token='a'.repeat(64);
const first=load('#pair_token='+token);
assert.equal(first.sockets[0].sent[0].pair_token,token);
assert(first.sockets[0].protocols.includes('pair_token.'+token));
assert.equal(saved.getItem('karcast_pair_token'),token);
const reloaded=load();
assert.equal(reloaded.sockets[0].sent[0].pair_token,token,'Reload must bind to the same phone');
values.clear();
const unpaired=load();assert.equal(unpaired.sockets.length,0);assert.equal(unpaired.node('pair-form').hidden,false);
const blocked=load('#pair_token='+token,{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});
assert.equal(blocked.sockets[0].sent[0].pair_token,token,'A pairing link still works when persistent storage is blocked');
console.log('PASS: browser fragment pairing, persistent reconnect, token handshake and explicit first pairing');
