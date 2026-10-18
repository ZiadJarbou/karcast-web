'use strict';
const fs = require('node:fs');
const helper = fs.readFileSync('transit-rebase-test.js', 'utf8').split('(async () => {')[0];
const resumed = new Function('require', 'process', helper + '\nreturn resumed;')(require, process);
const sources = {
  v37Deployed: '../../../p0-a-deployment-20261006/app.js',
  v50Before: '../../../v50-reference-continuity-20261008-07/candidate/server/public/app.js',
  v50Fixed: 'public/app.js'
};
(async () => {
  const rows = [];
  for (const [version, source] of Object.entries(sources)) {
    process.env.KARCAST_SOURCE = source;
    for (const path of ['direct', 'relay']) {
      for (const replayCount of [0, 1]) {
        const r = await resumed(path, replayCount, 450);
        rows.push({version, source, path, replayCount, ...r,
          oldReplayDisplayed: r.afterReplay > r.before,
          livePictureDisplayed: r.afterLive > r.afterReplay});
      }
    }
  }
  fs.writeFileSync('../../v37-v50-arrival-order-comparison.json', JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows, null, 2));
})().catch(e => {console.error(e); process.exitCode = 1;});
