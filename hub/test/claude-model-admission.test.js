'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const launch=require('../lib/launch');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function controller(models,ai='claude'){
 const catalog={claude:{models:[],known:[]},grok:{models:[],known:[]},[ai]:{models,known:models}};launch.setDiscoveredModels(catalog);let refreshed=0,prepared=0;
 const context=vm.createContext({process:{platform:'win32'},launch,aiTools:{catalog:()=>catalog,staleModel:()=>false},
  providers:{resolveActor:()=>({kind:'cli',id:'claude'}),assertCapability(){}},nativeProviderOptions:()=>({}),
  ensureNativeCatalog:()=>refreshed++,nativeProviderService:{prepareTurn:async()=>prepared++},nativeRootPin:()=>({})});
 for(const name of ['modelError','nativeEffortError','prepareNativeProviderTurn']){
  const body=source.match(new RegExp('(?:async )?function '+name+'\\([^]*?^}', 'm'))?.[0];assert.ok(body,name);vm.runInContext(body,context);
 }
 return {context,refreshed:()=>refreshed,prepared:()=>prepared};
}
test('Claude catalog admits exact labels and IDs, preserves legacy aliases and refuses unknown or override-only labels',()=>{
 const rows=[{id:'claude-sonnet-5-5',label:'Sonnet 5.5',efforts:['low','high']},{id:'claude-haiku-5-5',label:'Haiku 5.5',efforts:['low']}];
 const {context:c}=controller(rows);
 for(const label of ['CLI預設','Sonnet','Opus 5.5','Fable 5.1','sonnet','claude-opus-5-5',...rows.flatMap(row=>[row.id,row.label])])assert.equal(c.modelError('claude',label),'',label);
 launch.setOverrides({claude:{Unknown:'invented-model'}});
 try{for(const label of ['Unknown','invented-model','',null])assert.match(c.modelError('claude',label),/Hub 使用的 Claude Code 目前不提供模型.*CLI預設, Sonnet 5.5, Haiku 5.5/);}finally{launch.setOverrides({});launch.setDiscoveredModels({});}
});
test('unsupported effort refuses before native preparation without downgrade, while default and unknown catalog skip',async()=>{
 const {context:c,prepared}=controller([{id:'claude-sonnet-5-5',label:'Sonnet 5.5',efforts:['low','high']}]);
 for(const model of ['Sonnet','Sonnet 5.5','claude-sonnet-5-5']){
  assert.equal(c.nativeEffortError('claude',model,'高'),'');
  assert.equal(c.nativeEffortError('claude',model,'low'),'');
  await assert.rejects(c.prepareNativeProviderTurn({ai:'claude',model,effort:'Ultra'}),e=>e.status===409&&e.notStarted&&e.message===`Claude Code 的「${model}」不支援思考強度「Ultra」。可用：low, high。`);
 }
 await assert.rejects(c.prepareNativeProviderTurn({ai:'claude',model:'unknown',effort:'low'}),e=>e.status===409);assert.equal(prepared(),0);
 await c.prepareNativeProviderTurn({ai:'claude',model:'CLI預設',effort:'Ultra'});assert.equal(prepared(),1);
 assert.equal(c.nativeEffortError('grok','Grok 4.6','Ultra'),'');
 const unknown=controller([]).context;assert.equal(unknown.nativeEffortError('claude','Sonnet','Ultra'),'');assert.equal(unknown.modelError('claude','Sonnet'),'');assert.match(unknown.modelError('claude','unknown'),/CLI/);
 launch.setDiscoveredModels({});
});

test('Grok admission accepts catalog label/id and legacy only; effort is checked before preparation',async()=>{
 const models=[{id:'grok-4.7',label:'Grok 4.7',efforts:['low','medium','high','xhigh']},{id:'grok-4.5',label:'Grok 4.5',efforts:['low','medium','high']}];
 const {context:c,prepared}=controller(models,'grok');
 for(const label of ['CLI預設','Grok 4.6','grok-4.6',...models.flatMap(row=>[row.id,row.label])])assert.equal(c.modelError('grok',label),'',label);
 launch.setOverrides({grok:{Unknown:'grok-made-up'}});
 try{for(const label of ['Unknown','grok-made-up','',null])assert.match(c.modelError('grok',label),/Hub 使用的 Grok CLI 目前不提供模型.*CLI預設, Grok 4.7, Grok 4.5/);}finally{launch.setOverrides({});}
 for(const model of ['Grok 4.5','grok-4.5']){
  assert.equal(c.nativeEffortError('grok',model,'高'),'');
  await assert.rejects(c.prepareNativeProviderTurn({ai:'grok',model,effort:'極高'}),e=>e.status===409&&e.notStarted&&e.message===`Grok CLI 的「${model}」不支援思考強度「極高」。可用：low, medium, high。`);
 }
 assert.equal(prepared(),0);assert.equal(c.nativeEffortError('grok','Grok 4.7','極高'),'');
 await c.prepareNativeProviderTurn({ai:'grok',model:'CLI預設',effort:'極高'});assert.equal(prepared(),1);
 const unknown=controller([],'grok').context;assert.equal(unknown.modelError('grok','Grok 4.6'),'');assert.match(unknown.modelError('grok','unknown'),/CLI預設, Grok 4.6/);assert.equal(unknown.nativeEffortError('grok','Grok 4.6','極高'),'');
 launch.setDiscoveredModels({});
});
