'use strict';
// V60 change request A (opt-in ?present=latest): never freeze on a late newest
// picture, skip superseded late pictures, keep references for backlogs under
// LIVE_BACKLOG_LIMIT_MS, label real stalls. Default policy stays covered by the
// unchanged V59 suites (freshness, startup-freshness, transit-rebase, tesla).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = fs.readFileSync('recovery-episode-test.js', 'utf8').split('(async()=>{')[0]
  .replace('?pair_code=123456', '?present=latest&pair_code=123456');
assert(fixture.includes('?present=latest&pair_code=123456'), 'fixture query rewrite applied');
const harness = new Function('require', 'process', fixture + '\nreturn harness;')(require, process);

async function steady(path) {
  const h = harness(path); await h.ready();
  h.packet(true, 1000000); h.drain();
  h.advance(2100); h.packet(false, 3100000); h.drain();
  return h;
}

(async () => {
  for (const path of ['direct', 'relay']) {
    // 1. A steadily delayed source (450ms late, the case that froze in V59) keeps presenting.
    const late = await steady(path);
    assert.equal(late.hooks.getDiagnostics().presentLatest, 1);
    const before = late.hooks.getDiagnostics().presentedFrames;
    // Path delay rises by 450ms and stays there; source timestamps keep advancing.
    late.advance(450);
    for (let i = 1; i <= 60; i++) { late.advance(33); late.packet(false, 3100000 + i * 33000); late.drain(); }
    const shown = late.hooks.getDiagnostics().presentedFrames - before;
    assert(shown >= 55, `${path}: delayed source keeps presenting newest pictures (${shown}/60)`);
    assert(late.hooks.getDiagnostics().latePresentations > 0, `${path}: late presentations are counted`);

    // 2. A catch-up burst decodes every reference but draws only the newest (plus at most
    //    one picture that ends a >1s gap); superseded late pictures are skipped.
    const burst = await steady(path);
    const b0 = burst.hooks.getDiagnostics().presentedFrames, d0 = burst.stats().decoded;
    burst.advance(1500);
    for (let i = 1; i <= 45; i++) burst.packet(false, 3100000 + i * 33333);
    burst.drain();
    const drawn = burst.hooks.getDiagnostics().presentedFrames - b0;
    assert.equal(burst.stats().decoded - d0, 45, `${path}: every burst picture is decoded (references kept)`);
    // Only the on-time tail (<250ms) plus at most one gap-ending late picture is drawn.
    assert(drawn >= 1 && drawn <= 10, `${path}: superseded late burst pictures are skipped, drew ${drawn}`);
    assert.equal(burst.hooks.getDiagnostics().pendingVideoFrames, 0);

    // 3. A backlog under 3s is not retired: no decoder reset, no extra keyframe request.
    const backlog = await steady(path);
    const refreshes0 = backlog.refreshes();
    for (let i = 1; i <= 30; i++) backlog.packet(false, 3100000 + i * 33333);
    backlog.advance(1200);
    backlog.packet(false, 3100000 + 31 * 33333);
    assert.equal(backlog.refreshes(), refreshes0, `${path}: a 1.2s backlog keeps its reference chain`);
    assert(backlog.hooks.getDiagnostics().pendingVideoFrames > 0, `${path}: backlog still queued for decode`);
    backlog.drain();
    assert(backlog.hooks.getDiagnostics().presentedFrames > 0);

    // 4. A real stall is labelled: pictures arrive but none is drawn for >2.5s.
    const stall = await steady(path);
    for (let i = 1; i <= 10; i++) { stall.advance(300); stall.packet(false, 3100000 + i * 33333); }
    stall.health();
    assert.equal(stall.hooks.getDiagnostics().stallOverlayShown, 1, `${path}: stalled video is labelled`);
    // A 3s-silent decoder is reset by the existing watchdog; recovery delivers a new IDR.
    stall.advance(33); stall.packet(true, 3100000 + 11 * 33333); stall.drain(); stall.health();
    assert.equal(stall.hooks.getDiagnostics().stallOverlayShown, 0, `${path}: label clears after presentation`);

    // 5. A static Android Auto screen (no pictures arriving) is never labelled.
    const idle = await steady(path);
    idle.advance(6000); idle.health();
    assert.notEqual(idle.hooks.getDiagnostics().stallOverlayShown, 1, `${path}: static screen is not a stall`);
  }
  console.log('PASS V60 present=latest: delayed source presents, bursts draw newest, sub-3s backlog kept, stalls labelled, static screen unlabelled');
})().catch(e => { console.error(e); process.exitCode = 1; });
