'use strict';
// Production counterpart of isolated-staging-test.cjs: same upgrade boundary, app.karcast.app owner.
const assert=require('node:assert/strict');
const {validateUpgrade,ASSETS}=require('./production-server.cjs');
const base={method:'GET',url:'/ws',headers:{host:'app.karcast.app',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':'AAAAAAAAAAAAAAAAAAAAAA=='}};
const request=(headers,extra={})=>({...base,...extra,headers:{...base.headers,...headers}});
const cap='media_cap.'+'b'.repeat(64), pair='pair_token.'+'a'.repeat(64);
assert.equal(validateUpgrade(base),true,'native phone registration without browser Origin (V68 Play app and older installed builds)');
assert.equal(validateUpgrade(request({host:'app.karcast.app:443'})),true,'explicit port on the production Host');
assert.equal(validateUpgrade(request({origin:'https://app.karcast.app','sec-websocket-protocol':'karcast-v1'})),true,'browser without saved pairing');
assert.equal(validateUpgrade(request({origin:'https://app.karcast.app','sec-websocket-protocol':'karcast-v1, '+pair})),true,'browser with saved pairing');
assert.equal(validateUpgrade(request({'sec-websocket-protocol':'karcast-v1, '+cap},{url:'/ws/media'})),true,'native split media');
assert.equal(validateUpgrade(request({origin:'https://app.karcast.app','sec-websocket-protocol':'karcast-v1, '+cap},{url:'/ws/media'})),true,'browser split media');
for(const [h,extra,why] of [
 [{host:'staging.karcast.app'},{},'staging Host'],
 [{host:'evil.example'},{},'foreign Host'],
 [{origin:'https://staging.karcast.app','sec-websocket-protocol':'karcast-v1'},{},'staging Origin'],
 [{origin:'https://evil.example','sec-websocket-protocol':'karcast-v1'},{},'foreign Origin'],
 [{origin:'http://app.karcast.app','sec-websocket-protocol':'karcast-v1'},{},'insecure Origin'],
 [{origin:'https://app.karcast.app'},{},'browser without karcast-v1'],
 [{'sec-websocket-protocol':'unrecognized'},{},'unknown protocol'],
 [{'sec-websocket-protocol':'karcast-v1, '+cap},{},'media capability on control path'],
 [{'sec-websocket-protocol':'karcast-v1, '+pair},{url:'/ws/media'},'pair token on media path'],
 [{'sec-websocket-key':'invalid'},{},'invalid key'],
 [{'sec-websocket-version':'8'},{},'old WebSocket version'],
 [{upgrade:'h2c'},{},'non-websocket upgrade'],
 [{},{method:'POST'},'non-GET'],
 [{},{url:'/'},'root path'],
 [{},{url:'/ws?x=1'},'query string'],
 [{},{url:'/p0/events'},'diagnostic path'],
]) assert.equal(validateUpgrade(request(h,extra)),false,why);
for(const p0 of ['p0-diagnostics.js','p0a-signaling.js','p0a-build-identity.json']) assert.equal(ASSETS.has(p0),false,p0+' must not be served in production');
const src=require('node:fs').readFileSync(require.resolve('./production-server.cjs'),'utf8').split(/\r?\n/).filter(l=>!l.trim().startsWith('//')).join('\n');
assert.equal(/diagnostic-store|DiagnosticStore|staging\.karcast\.app/.test(src),false,'no P0 store or staging owner in the production entry');
console.log('PASS production upgrade boundary: app origin accepted, staging/evil/unknown rejected, no P0 assets');
