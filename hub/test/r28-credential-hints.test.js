'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decide}=require('../lib/native-provider-tool-policy');
const policy={root:'C:\\SyntheticWorkspace',commandsApproved:true,subagentsApproved:true,modelFlag:'grok-4.6',mcpTools:[]};
for(const command of ['grok-auth-helper-sandbox.cmd','%GROK_AUTH_PROVIDER_COMMAND%','$env:GROK_AUTH_PATH','dir hub-grok-auth*','git status']){
  test('R28 credential command review: '+command,()=>{
    assert.equal(decide('grok',{title:'Synthetic command',kind:'execute',rawInput:{variant:'Bash',command}},policy),command==='git status'?'accept':'manual');
  });
}
