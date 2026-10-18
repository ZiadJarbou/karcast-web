'use strict';
new (require('./production-server.cjs').ProductionServer)().start().catch(()=>{process.exitCode=1;});
