'use strict';
new (require('./staging-server.cjs').StagingServer)().start().catch(()=>{process.exitCode=1;});
