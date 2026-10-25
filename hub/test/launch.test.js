'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const launch=require('../lib/launch');
test('CLI default label is preserved and never emits a model flag for any CLI actor',()=>{
 assert.equal(launch.CLI_DEFAULT_LABEL,'CLI預設');
 for(const ai of launch.AIS){assert.equal(launch.modelLabel(ai,launch.CLI_DEFAULT_LABEL),launch.CLI_DEFAULT_LABEL);assert.equal(launch.flagFor(ai,launch.CLI_DEFAULT_LABEL),'');}
 const turn=launch.buildArgv({ai:'codex',model:launch.CLI_DEFAULT_LABEL,effort:'高',prompt:'fixture'});assert.equal(turn.args.includes('--model'),false);assert.match(launch.startupInfo('codex',launch.CLI_DEFAULT_LABEL),/CLI の既定/);
});

test('Windows terminals disable auto-daemon for both versions and no-daemon only for active 0.164.0',{skip:process.platform!=='win32'},()=>{
 for(const codexVersion of [undefined,'0.154.0','0.164.0']){const {args}=launch.buildArgv({ai:'codex',codexVersion});assert.equal(args[args.indexOf('features.daemon_auto_start=false')-1],'-c');assert.equal(args.includes('--no-daemon'),codexVersion==='0.164.0');}
});
