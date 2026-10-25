'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildTurn}=require('../lib/chat'),launch=require('../lib/launch'),registry=require('../lib/provider-registry');

function options(ai,extra={}){
  return{ai,model:ai==='agy'?launch.AGY_MODEL.label:ai==='codex'?'GPT-6.1-Sol':'Fable 5.1',meta:{},rows:[],text:'合成規劃；不執行命令',basePrompt:'BASE',policy:'POLICY',...extra};
}
function typed(code,status){return error=>error.code===code&&error.status===status&&error.notStarted===true;}

test('legacy turn planner rejects Grok before argv, metadata or prompt planning even with custom command and noEffort',()=>{
  const untouchedMeta=new Proxy({},{get(){throw Error('metadata must not be read for an unsupported adapter');}});
  for(const extra of [{perm:'grok',noEffort:true},{},{perm:'codex',effort:'高',noEffort:true},{perm:'grok --synthetic',meta:untouchedMeta}]){
    assert.throws(()=>buildTurn(options('grok',extra)),typed('PROVIDER_ADAPTER_UNVERIFIED',409));
  }
  assert.throws(()=>buildTurn({ai:'grok'}),typed('PROVIDER_ADAPTER_UNVERIFIED',409));
});

test('legacy turn planner rejects unknown and web actors before reading provider session state',()=>{
  for(const ai of [null,undefined,{},[],1,'','CLAUDE','claude ','grok-cli','__proto__','人']){
    assert.throws(()=>buildTurn({ai,perm:'codex',noEffort:true}),typed('UNKNOWN_ACTOR',400));
  }
  for(const ai of ['chatgpt','claude-chat'])assert.throws(()=>buildTurn({ai,perm:'claude',noEffort:true}),typed('CLI_ACTOR_REQUIRED',400));
});

test('Claude legacy alias produces the canonical Claude plan for new and resumed sessions',()=>{
  for(const resume of [false,true])for(const perm of [undefined,'claude --synthetic-policy']){
    const meta=resume?{sessions:{claude:'claude-session',codex:'unrelated-session'},models:{claude:'previous-model'}}:{};
    const rows=[{role:'assistant',ai:'claude',text:'ALREADY_SEEN'},{role:'user',text:'UNSEEN_CONTEXT'}];
    const canonical=options('claude',{meta,rows,effort:'高',perm}),alias={...canonical,ai:'claude-code'},before=structuredClone(alias);
    const turn=buildTurn(alias);assert.deepEqual(turn,buildTurn(canonical));assert.deepEqual(alias,before);
    assert.equal(turn.command,'claude');assert.equal(turn.args.includes('-p'),true);assert.equal(turn.args.includes('--verbose'),true);assert.equal(turn.args.includes('exec'),false);
    assert.equal(turn.resume,resume);assert.equal(turn.sessionId,resume?'claude-session':'');assert.equal(turn.args.includes('--resume'),resume);
    assert.equal(turn.args[turn.args.indexOf('--model')+1],'claude-fable-5-1');assert.equal(turn.args[turn.args.indexOf('--effort')+1],'high');
    assert.equal(turn.stdin.includes('ALREADY_SEEN'),!resume);assert.equal(turn.stdin.includes('UNSEEN_CONTEXT'),true);
  }
});

test('Codex Claude and Agy keep their own argument shape, defaults, model and resume behavior',()=>{
  const defaults={...launch.DEFAULT_CMD},readiness=registry.list({platform:'win32'});
  for(const ai of ['codex','claude','agy'])for(const resume of [false,true]){
    const input=options(ai,{effort:'高'});input.meta=resume?{sessions:{[ai]:'owned-session'},models:{[ai]:input.model}}:{};
    const turn=buildTurn(input);assert.equal(turn.command,ai);assert.equal(turn.resume,resume);assert.equal(turn.sessionId,resume?'owned-session':'');
    assert.equal(turn.args.includes('exec'),ai==='codex');assert.equal(turn.args.includes('--json'),ai==='codex');assert.equal(turn.args.includes('-p'),ai==='claude');
    assert.equal(turn.args.includes('--resume'),ai==='claude'&&resume);assert.equal(turn.args.includes('--conversation'),ai==='agy'&&resume);
    assert.equal(turn.args[turn.args.indexOf('--model')+1],launch.flagFor(ai,input.model));
    if(ai==='agy'){assert.equal(turn.stdin,'');assert.ok(turn.args.some(value=>value.startsWith('--print=')&&value.includes(input.text)));}
    else assert.ok(turn.stdin.includes(input.text));
    if(ai==='codex'){assert.equal(turn.args.at(-1),'-');assert.ok(turn.args.includes('model_reasoning_effort=high'));}
    else assert.ok(turn.args.includes('--dangerously-skip-permissions')); // Existing defaults are preserved, not admitted for execution.
  }
  assert.deepEqual(launch.DEFAULT_CMD,defaults);assert.deepEqual(registry.list({platform:'win32'}),readiness);
  assert.equal(registry.status('claude',{platform:'win32'}).ready,false);assert.equal(registry.status('grok',{platform:'win32'}).ready,false);
});

test('canonicalization retains Codex model-change restart and Claude cross-model resume',()=>{
  const meta={sessions:{codex:'codex-session',claude:'claude-session'},models:{codex:'different-model',claude:'different-model'}};
  assert.equal(buildTurn(options('codex',{meta})).resume,false);
  assert.equal(buildTurn(options('claude-code',{meta})).resume,true);
});
