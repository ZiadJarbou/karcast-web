'use strict';

/**
 * Hostinger Production Entry Point for app.karcast.app
 *
 * Immediately creates and starts UnifiedAppServer upon load.
 * Does NOT wrap startup in `if (require.main === module)` because
 * Hostinger loads entry modules via require/loader wrappers.
 */

const UnifiedAppServer = require('./server-core.js');

const server = new UnifiedAppServer();

server.start().then(port => {
  console.log(`Unified app.karcast.app application listening on http/ws port ${port}`);
}).catch(err => {
  console.error('Failed to start app.karcast.app server:', err);
  process.exit(1);
});

module.exports = server;
