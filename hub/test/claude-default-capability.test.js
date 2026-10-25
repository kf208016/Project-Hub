'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {CapabilityAuth}=require('../lib/capability-auth'),{validateArguments}=require('../lib/chatgpt');
test('Claude CLI default delegation remains issuer-only, exact model, task/run bound and once-only',()=>{
 const auth=new CapabilityAuth(),base={project:'synthetic',task:'t',runId:crypto.randomUUID(),root:path.resolve(os.tmpdir(),'synthetic-default'),rootFingerprint:'a'.repeat(64),tools:['hub_delegate'],delegationModel:'CLI預設',delegationActor:'claude'};
 for(const actor of [undefined,'codex'])assert.throws(()=>auth.issue({...base,delegationActor:actor}),e=>e.status===403);
 for(const model of ['', 'CLI預設 ', 'unknown label'])assert.throws(()=>auth.issue({...base,delegationModel:model}),e=>e.status===403);
 const grant=auth.issue(base),args={project:'synthetic',task:'t',model:'CLI預設',title:'review',text:'synthetic task'},req={token:grant.token,runId:base.runId,nonce:crypto.randomUUID(),tool:'hub_delegate',arguments:args};
 assert.equal(validateArguments('hub_delegate',args),true);
 for(const changes of [{model:'sonnet'},{actor:'grok'},{task:'other'}])assert.throws(()=>auth.consume({...req,arguments:{...args,...changes}}),e=>e.status===403);
 assert.equal(auth.consume(req).delegationModel,'CLI預設');assert.throws(()=>auth.consume({...req,nonce:crypto.randomUUID()}),e=>e.status===403);
 const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/mcp-settings.schema.json'),'utf8'));
 assert.equal(new RegExp(schema.properties.delegationModel.pattern).test('CLI預設'),true);
 assert.equal(new RegExp(schema.$defs.browserIssue.properties.delegationModel.pattern).test('CLI預設'),false);
 const rule=schema.allOf.find(rule=>rule.if?.properties?.delegationModel?.const==='CLI預設');assert.deepEqual(rule.then.required,['delegationActor']);assert.deepEqual(rule.then.properties.delegationActor.enum,['claude','grok']);
});

test('Grok CLI default delegation is issuer-bound, exact and once-only',()=>{
 const auth=new CapabilityAuth(),base={project:'synthetic',task:'t',runId:crypto.randomUUID(),root:path.resolve(os.tmpdir(),'synthetic-grok-default'),rootFingerprint:'a'.repeat(64),tools:['hub_delegate'],delegationModel:'CLI預設',delegationActor:'grok'};
 const grant=auth.issue(base),args={project:'synthetic',task:'t',model:'CLI預設',title:'review',text:'synthetic task'},req={token:grant.token,runId:base.runId,nonce:crypto.randomUUID(),tool:'hub_delegate',arguments:args};
 assert.equal(validateArguments('hub_delegate',args),true);
 for(const changes of [{model:'grok-4.6'},{actor:'claude'},{task:'other'}])assert.throws(()=>auth.consume({...req,arguments:{...args,...changes}}),e=>e.status===403);
 assert.equal(auth.consume(req).delegationActor,'grok');assert.throws(()=>auth.consume({...req,nonce:crypto.randomUUID()}),e=>e.status===403);
});


test('native MCP issuer preserves the Grok CLI default label and explicit actor',async()=>{
 const vm=require('node:vm'),launch=require('../lib/launch'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const fn=source.slice(source.indexOf('async function nativeProviderMcp('),source.indexOf('async function nativeProviderDispose('));
 let issued;const sentinel=Error('captured issuance'),context=vm.createContext({os,path,launch,ROOT:'C:\\Synthetic',MAX_WALL_MS:1800000,READ_TOOLS:['hub_get_task'],fs:{mkdirSync(){}},
  require:name=>{if(name==='./lib/native-runtime-base')return {resolve:async()=>({physicalBase:'C:\\Synthetic'})};if(name==='./lib/safe-path')return {localPath:x=>x};if(name==='./lib/scoped-file')return {identity:async()=>({rootFingerprint:'b'.repeat(64)})};assert.fail(name);},
  gpt:{settings:()=>({work:true})},store:{readProject:()=>({tasks:[{id:'task',completionHash:'c'.repeat(64)}]})},mcpCapabilities:{issue:options=>{issued=options;throw sentinel;}}});
 vm.runInContext(fn,context);
 await assert.rejects(context.nativeProviderMcp({actor:'grok',model:'CLI預設',project:'p',task:'task',runId:crypto.randomUUID()},{dir:'C:\\Synthetic',rootFingerprint:'a'.repeat(64),workspaceRun:'workspace'}),e=>e===sentinel);
 assert.equal(issued.delegationModel,'CLI預設');assert.equal(issued.delegationActor,'grok');assert.equal(issued.ttlMs,1800000);assert.equal(issued.maxCalls,500);
});

test('Windows same-task delegate admits explicit Grok CLI default through the model gate, unknown remains rejected',async()=>{
 const vm=require('node:vm'),launch=require('../lib/launch'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const fn=source.slice(source.indexOf('function delegateResult('),source.indexOf('async function api('));
 const sentinel=Object.assign(Error('workspace gate reached'),{workspaceRequired:true}),context=vm.createContext({launch,process:{platform:'win32'},
  store:{readProject:()=>({id:'p'}),taskFile:()=>'/synthetic/task',readTask:()=>({id:'t',state:'未着手'})},aiTools:{isOperating:()=>false},modelError:()=>'',delegateTerminalError:()=>'',chats:{busy:()=>null},nativeStartDir:async()=>{throw sentinel;}});
 vm.runInContext(fn,context);
 const body={project:'p',task:'t',ai:'grok',model:'CLI預設',title:'handoff',text:'synthetic'};
 await assert.rejects(context.delegateTask(body),e=>e===sentinel);
 await assert.rejects(context.delegateTask({...body,model:'unknown'}),e=>e.status===409&&e!==sentinel);
});
