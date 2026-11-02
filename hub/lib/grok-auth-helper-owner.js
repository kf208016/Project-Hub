'use strict';
const home = require('node:os').homedir();
try {
  process.stdout.write(require('./grok-owner-token').mintJson({home}));
  process.exitCode = 0;
} catch (error) {
  process.stderr.write('grok-auth-helper-owner: ' + (error.code || 'UNAVAILABLE') + '\n');
  process.exitCode = 1;
}
