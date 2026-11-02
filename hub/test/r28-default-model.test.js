'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const launch=require('../lib/launch'),roles=require('../lib/roles');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const win=process.platform==='win32'?test:test.skip;
function controller(slotRoles=[],platform=process.platform,extra={}){
  const catalog={claude:{models:[{id:'claude-fixture',label:'Fixture Claude'}],known:[]},grok:{models:[{id:'grok-fixture',label:'Fixture Grok'}],known:[]}};
  const c=vm.createContext({process:{platform},launch,roles,nativeProviderOptions:()=>({}),providers:{resolveActor:()=>({kind:'cli'}),assertCapability:()=>{}},ensureNativeCatalog:()=>{},rolesData:()=>({roles:slotRoles,agents:[]}),aiTools:{catalog:()=>catalog,staleModel:()=>false,isOperating:()=>false},...extra});
  for(const name of ['pickSpec','modelError']){
    const body=source.match(new RegExp('function '+name+'\\([^]*?^}', 'm'))?.[0];assert.ok(body);vm.runInContext(body,c);
  }
  return c;
}
win('R28 Windows CLI default fallback, slot precedence and explicit stale refusal',()=>{
  for(const ai of ['grok','claude']){
    const c=controller();assert.equal(c.pickSpec({},ai).model,launch.CLI_DEFAULT_LABEL);assert.equal(c.pickSpec({},ai).model,'CLI預設');
    assert.equal(c.modelError(ai,c.pickSpec({},ai).model),'');
    const model=c.pickSpec({model:'unknown-stale'},ai).model;assert.equal(model,'unknown-stale');assert.match(c.modelError(ai,model),/目前不提供模型/);
    for(const position of ['main','backup']){
      const slot={name:'role',main:{ai:'unrelated'},backup:{ai:'unrelated'},[position]:{ai:launch.AI_KEY[ai],model:'slot-model',effort:'高'}};
      assert.equal(controller([slot]).pickSpec({role:'role'},ai).model,'slot-model');
      assert.equal(controller([slot]).pickSpec({role:'role',model:'explicit'},ai).model,'explicit');
    }
  }
  assert.equal(controller().pickSpec({},'codex').model,'');assert.equal(controller().pickSpec({},'agy').model,launch.AGY_MODEL.label);
});
test('R28 non-Windows empty fallback stays unchanged',()=>{
  for(const ai of ['grok','claude','codex'])assert.equal(controller([],'linux').pickSpec({},ai).model,'');
});
win('R28 POST /api/start without model creates a Grok task with CLI default',async t=>{
  // Production route and model admission over local HTTP. Workspace and turn
  // preparation are synthetic: this test must never start a provider or a lease.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'r28-default-')),taskFile=path.join(root,'task.json');
  const project={id:'p',dir:root,phases:[],tasks:[]};let task;
  const store={readProject:()=>project,listProjects:()=>[project],taskFile:()=>taskFile,
    createTask:(_id,fields)=>{task={id:'t',...fields};return task;},readTask:()=>JSON.parse(fs.readFileSync(taskFile,'utf8')),
    updateTask:(_p,_t,fields)=>{Object.assign(task,fields);fs.writeFileSync(taskFile,JSON.stringify(task));}};
  const c=controller([],process.platform,{fs,path,store,DRY:true,providers:{isActor:()=>true,resolveActor:()=>({kind:'cli'}),assertCapability:()=>{}},
    start:{copyImages:()=>[],imagePrompt:(_ai,text)=>text,saveSpec:()=>{}},chats:{busy:()=>false},
    nativeStartDir:async()=>({dir:root}),taskPrompt:()=>'',modelPolicy:()=>({}),chatPermCmd:()=>'',
    chat:{buildTurn:turn=>{assert.equal(turn.model,'CLI預設');return {synthetic:true};}},failNativeWorkspace:async()=>{},record:()=>{},
    nativeWorkspaceError:error=>({error:error.message}),send:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  const begin=source.indexOf("  if (url.pathname === '/api/start') {"),end=source.indexOf("  if (url.pathname === '/api/ai-tools/check')",begin);
  vm.runInContext('globalThis.route=async(req,res,url,b)=>{'+source.slice(begin,end)+'};',c);
  const server=require('node:http').createServer(async(req,res)=>{try{let text='';for await(const chunk of req)text+=chunk;await c.route(req,res,new URL(req.url,'http://127.0.0.1'),JSON.parse(text));}catch(error){res.writeHead(500);res.end(error.message);}});
  t.after(async()=>{await new Promise(r=>server.close(r));assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/start',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'p',ai:'grok',text:'synthetic task',images:[]})});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.task,'t');assert.equal(store.readTask().model,'CLI預設');
});
