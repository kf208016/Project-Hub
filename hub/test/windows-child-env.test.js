'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{childEnv}=require('../lib/launch');
const win=process.platform==='win32'?test:test.skip;
win('Native chat and terminal providers never inherit owner Hub credentials or control flags',()=>{
 const source={HUB_LOCAL_TOKEN:'synthetic-owner-login',HUB_INSTANCE_SECRET:'synthetic-instance',hub_secret:'synthetic-mixedcase',HUB_AI_HOME:'C:\\synthetic-owner-config',HUB_DRY_RUN:'1',HUB_MCP_CREDENTIAL_FILE:'C:\\synthetic-private-credential',OPENAI_API_KEY:'synthetic-provider-auth',PATH:'synthetic-path',TEMP:'C:\\synthetic-temp',USERPROFILE:'C:\\synthetic-profile'};
 for(const ai of ['codex','claude','agy']){const env=childEnv(ai,source);assert.equal(Object.keys(env).some(key=>/^HUB_/i.test(key)),false);assert.equal(env.PATH,source.PATH);assert.equal(env.TEMP,source.TEMP);assert.equal(env.USERPROFILE,source.USERPROFILE);assert.equal(env.OPENAI_API_KEY,ai==='agy'?undefined:source.OPENAI_API_KEY);}
 assert.equal(source.HUB_LOCAL_TOKEN,'synthetic-owner-login');assert.equal(source.HUB_DRY_RUN,'1');
});
