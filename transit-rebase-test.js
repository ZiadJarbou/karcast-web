'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Reuse the browser/transport fixture, including real app.js execution.
const fixture = fs.readFileSync('recovery-episode-test.js', 'utf8').split('(async()=>{')[0];
const harness = new Function('require', 'process', fixture + '\nreturn harness;')(require, process);

async function resumed(path, replayCount, extraTransitMs) {
  const h = harness(path); await h.ready();
  h.packet(true, 1000000); h.drain();
  h.advance(2100); h.packet(false, 3100000); h.drain();
  const before = h.hooks.getDiagnostics().presentedFrames;
  h.advance(2600);
  for (let i = 0; i < replayCount; i++) {
    h.packet(i === 0, 1000000 + i * 33333); h.drain(); h.advance(1);
  }
  const afterReplay = h.hooks.getDiagnostics().presentedFrames;
  h.advance(33);
  h.packet(false, 3100000 + (2600 + replayCount + 33 - extraTransitMs) * 1000); h.drain();
  return { before, afterReplay, afterLive: h.hooks.getDiagnostics().presentedFrames,
    refreshes: h.refreshes(), age: h.hooks.getDiagnostics().frameAgeMs };
}

(async () => {
  for (const path of ['direct', 'relay']) {
    for (const extraTransitMs of [450, 1000]) {
      const liveFirst = await resumed(path, 0, extraTransitMs);
      assert.equal(liveFirst.afterLive, liveFirst.before + 1,
        `${path}: the existing quiet-path rebase accepts a newly advancing source picture`);
      for (const replayCount of [1, 8, 60]) {
        const replayFirst = await resumed(path, replayCount, extraTransitMs);
        assert.equal(replayFirst.afterReplay, replayFirst.before,
          `${path}: old reference replay never reaches presentation`);
        assert.equal(replayFirst.afterLive, replayFirst.before + 1,
          `${path}: ${replayCount} old replay pictures must not consume quiet-path clock recalibration (${extraTransitMs}ms new path offset)`);
        assert(replayFirst.age <= 250, 'Fresh continuation still obeys the display budget');
        assert.equal(replayFirst.refreshes, liveFirst.refreshes,
          'An ignored duplicate cannot turn a valid continuation into another GOP replay');
      }
    }
    const continuous = harness(path); await continuous.ready();
    continuous.packet(true, 1000000); continuous.drain();
    continuous.advance(2100); continuous.packet(false, 3100000); continuous.drain();
    const beforeDelay = continuous.hooks.getDiagnostics().presentedFrames;
    // A continuously advancing slow source is not a quiet-path transition.
    // It may not learn away accumulated transit delay every few pictures.
    for (let i = 1; i <= 60; i++) {
      continuous.advance(33);
      continuous.packet(false, 3100000 + i * 33000 - 450000); continuous.drain();
    }
    assert.equal(continuous.hooks.getDiagnostics().presentedFrames, beforeDelay,
      `${path}: continuous delayed source progress cannot reset the transit floor to display stale pictures`);
  }
  console.log('PASS DIRECT/RELAY: cached-first and live-first resumption agree; old pictures never display');
})().catch(e => { console.error(e); process.exitCode = 1; });
