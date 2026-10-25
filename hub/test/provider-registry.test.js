'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const registry=require('../lib/provider-registry');

test('native adapter authority is an unforgeable controller reference and grants only named operations',()=>{
  let enabled=true;
  const authority=registry.createNativeAuthority('grok',['chat','delegate'],()=>enabled);
  const options={platform:'win32',nativeAuthority:authority};
  assert.equal(registry.assertCapability('grok','chat',options).id,'grok');
  assert.equal(registry.status('grok',options).runtimeVerificationRequired,true);
  for(const fake of [{},JSON.parse(JSON.stringify(authority)),{actor:'grok',ready:true}]){
    assert.throws(()=>registry.assertCapability('grok','chat',{platform:'win32',nativeAuthority:fake}),{code:'PROVIDER_ADAPTER_UNVERIFIED'});
  }
  assert.throws(()=>registry.assertCapability('grok','terminal',options),{code:'ACTOR_CAPABILITY_UNAVAILABLE'});
  assert.throws(()=>registry.assertCapability('claude','chat',options),{code:'WINDOWS_PROVIDER_ISOLATION_UNVERIFIED'});
  enabled=false;assert.equal(registry.status('grok',options).ready,false);
  assert.throws(()=>registry.createNativeAuthority('codex',['chat'],()=>true),{code:'INVALID_NATIVE_AUTHORITY'});
});
test('Six exact actors preserve the Claude legacy owner alias without fuzzy matching',()=>{
  assert.deepEqual(registry.actorIds,['codex','claude','agy','grok','chatgpt','claude-chat']);
  assert.strictEqual(registry.resolveActor('claude-code'),registry.resolveActor('claude'));
  assert.equal(registry.resolveActor('claude').ownerKey,'claude-code');
  for(const actor of [null,undefined,{},[],1,'','CLAUDE','claude ','claude-chat-cli','discord:claude','__proto__','人'])assert.throws(()=>registry.resolveActor(actor),error=>error.status===400&&error.code==='UNKNOWN_ACTOR');
  assert.ok(Object.isFrozen(registry.resolveActor('codex')));assert.ok(Object.isFrozen(registry.resolveActor('codex').capabilities));
});
test('Manual web destinations and capabilities cannot become CLI execution',()=>{
  for(const [actor,url]of [['chatgpt','https://chatgpt.com/'],['claude-chat','https://claude.ai/']]){
    const row=registry.webActor(actor);assert.equal(row.url,url);assert.equal(row.transport,'web-manual');assert.equal(row.kind,'external-chat');
    assert.equal(registry.status(actor,{platform:'win32'}).ready,true);
    for(const capability of ['preview','confirm','result'])assert.equal(registry.assertCapability(actor,capability,{platform:'win32'}).id,actor);
    for(const capability of registry.CLI_CAPABILITIES)assert.throws(()=>registry.assertCapability(actor,capability,{platform:'win32'}),error=>error.code==='ACTOR_CAPABILITY_UNAVAILABLE');
    assert.throws(()=>registry.cliActor(actor),error=>error.code==='CLI_ACTOR_REQUIRED');
  }
  assert.throws(()=>registry.webActor('claude-code'),error=>error.code==='WEB_ACTOR_REQUIRED');
});
test('Native Windows keeps unverified providers blocked independently of their known role identity',()=>{
  assert.equal(registry.assertCapability('codex','spawn',{platform:'win32'}).id,'codex');
  assert.equal(registry.status('codex',{platform:'win32'}).runtimeVerificationRequired,true,'transport readiness never proves a binary/account/model');
  for(const actor of ['claude','claude-code','agy','grok']){
    assert.equal(registry.cliActor(actor).kind,'cli');assert.equal(registry.supports(actor,'chat'),true);
    assert.equal(registry.status(actor,{platform:'win32'}).ready,false);
    for(const capability of registry.CLI_CAPABILITIES)assert.throws(()=>registry.assertCapability(actor,capability,{platform:'win32'}),error=>error.status===409&&error.notStarted===true);
  }
  assert.equal(registry.assertCapability('claude-code','chat',{platform:'darwin'}).id,'claude');assert.equal(registry.assertCapability('agy','chat',{platform:'darwin'}).id,'agy');
  assert.throws(()=>registry.assertCapability('grok','chat',{platform:'darwin'}),error=>error.code==='PROVIDER_ADAPTER_UNVERIFIED');
  assert.throws(()=>registry.assertCapability('codex','unknown',{platform:'win32'}),error=>error.code==='ACTOR_CAPABILITY_UNAVAILABLE');
});
test('Exact snapshot validator rejects forged readiness, destination, capabilities and duplicate identities',()=>{
  const make=()=>JSON.parse(JSON.stringify(registry.list({platform:'win32'})));
  assert.equal(registry.validateSnapshot(make(),{platform:'win32'}),true);
  assert.equal(registry.validateSnapshot(make().reverse(),{platform:'win32'}),true);
  for(const mutate of [rows=>rows.pop(),rows=>rows[1].readiness.ready=true,rows=>rows[4].url='https://evil.invalid/',rows=>rows[5].capabilities.push('spawn'),rows=>rows[5].id='claude',rows=>rows[0].extra=true,rows=>delete rows[0].ownerKey,rows=>rows[0].readiness.extra=true]){
    const rows=make();mutate(rows);assert.throws(()=>registry.validateSnapshot(rows,{platform:'win32'}),error=>error.code==='INVALID_REGISTRY');
  }
});
test('Registry schema enumerates the runtime IDs, capabilities and fixed destinations with required fields',()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/provider-registry.schema.json'),'utf8'));
  assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');assert.equal(schema.items.additionalProperties,false);
  assert.deepEqual(schema.items.properties.id.enum,registry.actorIds);
  assert.deepEqual(schema.items.properties.ownerKey.enum,registry.ownerKeys);
  assert.deepEqual(schema.items.properties.capabilities.items.enum,[...registry.CLI_CAPABILITIES,...registry.WEB_CAPABILITIES]);
  assert.deepEqual(schema.items.properties.url.enum,[null,...registry.webIds.map(actor=>registry.webActor(actor).url)]);
  for(const row of registry.list({platform:'win32'}))assert.deepEqual(Object.keys(row).sort(),schema.items.required.slice().sort());
  assert.equal(schema.allOf.length,registry.actorIds.length);
});
test('Launch/model mapping keeps exact aliases and refuses web or unknown actors',()=>{
  const launch=require('../lib/launch');
  assert.equal(launch.flagFor('claude-code','Opus 5.5'),'claude-opus-5-5');
  assert.equal(launch.flagFor('claude','Opus 5.5'),'claude-opus-5-5');
  for(const actor of ['claude-chat','chatgpt','claude-extra','unknown']){
    assert.throws(()=>launch.flagFor(actor,'Opus 5.5'));
    assert.throws(()=>launch.buildArgv({ai:actor,model:'Opus 5.5',prompt:'synthetic'}));
    assert.throws(()=>launch.buildCommand({ai:actor,dir:'fixture',prompt:'synthetic'}));
    assert.throws(()=>launch.childEnv(actor,{}));
  }
  assert.throws(()=>launch.buildCommand({ai:'grok',dir:'fixture',cmd:'grok',prompt:'synthetic'}),error=>error.code==='PROVIDER_ADAPTER_UNVERIFIED');
});
test('Provider resolver rejects deferred native executables before filesystem lookup',()=>{
  const cli=require('../lib/cli-platform');
  for(const actor of ['claude','claude-code','agy','grok','claude-chat','chatgpt'])assert.throws(()=>cli.resolveProvider(actor,[],null,'win32'),error=>error.status===409);
  assert.throws(()=>cli.resolveProvider('unknown',[],null,'win32'),error=>error.code==='UNKNOWN_ACTOR');
});
test('Web role slots have no fabricated model and preserve known deferred CLI selections',()=>{
  const roles=require('../lib/roles'),slot=ai=>({name:'synthetic',main:{ai,model:'',effort:''},backup:{ai:'人',model:'',effort:''}});
  for(const actor of registry.webIds){
    assert.deepEqual(roles.validate({},[slot(actor)]),[]);
    for(const change of [{model:'Opus 5.5'},{effort:'高'}])assert.ok(roles.validate({},[{...slot(actor),main:{...slot(actor).main,...change}}]).length);
  }
  assert.deepEqual(roles.validate({grok:['synthetic-model']},[{...slot('grok'),main:{ai:'grok',model:'synthetic-model',effort:'高'}}]),[]);
  assert.ok(roles.validate({},[slot('claude-chat-cli')]).length);
});
test('Web phone labels and initial handoff settings preserve distinct actors without a verified website model',t=>{
  const os=require('node:os'),{ModelView}=require('../lib/model-view'),root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-registry-model-view-')),file=path.join(root,'view.json'),view=new ModelView(file);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const actor of registry.webIds){
    const spec={ai:actor,model:'app',effort:''};
    assert.deepEqual(view.setInitial(spec,{}).initialPick,spec);assert.deepEqual(new ModelView(file).initial(),spec);
    assert.equal(view.setPhone({key:actor+'|app',name:actor},{}).status,undefined);
    const before=fs.readFileSync(file);
    for(const bad of [{...spec,model:'verified-model'},{...spec,effort:'高'},{...spec,extra:true}])assert.equal(view.setInitial(bad,{}).status,400);
    assert.deepEqual(fs.readFileSync(file),before);
  }
  assert.deepEqual(view.phone().names,{'chatgpt|app':'chatgpt','claude-chat|app':'claude-chat'});
});
test('Grok CLI model order preserves older provider keys without accepting web as CLI models',()=>{
  const order=require('../public/model-order');
  const models={codex:['Sol'],grok:['synthetic-model']};assert.deepEqual(order.ordered(models),['codex|Sol','grok|synthetic-model']);
  assert.equal(order.valid(['grok|synthetic-model']),true);assert.equal(order.valid(['claude-chat|app']),false);assert.equal(order.valid(['chatgpt|app']),false);
});
test('Saved unknown or malformed initial actors fail closed without rewriting settings or changing provider',t=>{
  const os=require('node:os'),{ModelView}=require('../lib/model-view'),root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-initial-actor-')),file=path.join(root,'view.json'),view=new ModelView(file);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const bad of [null,[],{ai:'unknown',model:'Opus',effort:'高'},{ai:'claude-chat',model:'Opus',effort:'高'},{ai:'codex',model:'',effort:'高'},{ai:'codex',model:'Sol',effort:'bad'},{ai:'codex',model:'Sol',effort:'高',extra:true}]){
    fs.writeFileSync(file,JSON.stringify({initial:bad}));const before=fs.readFileSync(file);assert.throws(()=>view.initial());assert.deepEqual(fs.readFileSync(file),before);
  }
  fs.writeFileSync(file,'{broken');assert.throws(()=>view.initial());assert.equal(fs.readFileSync(file,'utf8'),'{broken');
  const legacy={ai:'claude-code',model:'Opus 5.5',effort:'高'};fs.writeFileSync(file,JSON.stringify({initial:legacy}));assert.deepEqual(view.initial(),{...legacy,ai:'claude'});
});
