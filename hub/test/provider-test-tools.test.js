'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const tools=require('../lib/provider-test-tools');
function fixture(t,source){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-fixed-assert-'));assert.equal(path.dirname(root),os.tmpdir());t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'add.js'),source);return root;}
test('synthetic stage programs pass only after source whitelist validation',async t=>{
 for(const stage of [1,2]){const root=fixture(t,stage===1?'module.exports = (a, b) => a + b;\n':'module.exports=(a,b)=>a+b+1;');const result=await tools.verify(root,{stage});assert.equal(result.passed,true);assert.equal(result.exitCode,0);assert.match(result.sourceSHA256,/^[a-f0-9]{64}$/);assert.equal(result.synthetic,true);}
});
test('extra statements, imports, credential reads and Unicode separators are refused without execution',async t=>{
 const root=fixture(t,'');const marker=path.join(root,'must-not-exist');
 const sources=['module.exports=(a,b)=>a+b;require("fs").writeFileSync('+JSON.stringify(marker)+',"bad");','module.exports=(a,b)=>{return require("fs").readFileSync(".credentials.json")};','module.exports=(a,b)=>a+b;/* extra */','module.exports=(a,b)=>a+b;\u00a0'];
 for(const source of sources){fs.writeFileSync(path.join(root,'add.js'),source);await assert.rejects(tools.verify(root,{stage:1}),e=>e.code==='E_BAD_SOURCE');assert.equal(fs.existsSync(marker),false);}
});
test('stage, unexpected model arguments and invalid UTF8 fail closed',async t=>{
 const root=fixture(t,'module.exports=(a,b)=>a+b;');
 for(const args of [{stage:'1'},{stage:3},{stage:1,path:'other.js'},{stage:1,command:'node'},[],null])await assert.rejects(tools.verify(root,args));
 fs.writeFileSync(path.join(root,'add.js'),Buffer.from([0xff]));await assert.rejects(tools.verify(root,{stage:1}));
});
test('fixed command environment has no auth, preload or proxy inheritance',t=>{
 const root=fixture(t,'module.exports=(a,b)=>a+b;');const plan=tools.createPlan(root,1);
 assert.equal(plan.command,process.execPath);assert.equal(plan.options.shell,false);
 for(const name of ['USERPROFILE','APPDATA','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','HTTPS_PROXY','NODE_OPTIONS','HUB_TEST_TOKEN'])assert.equal(Object.hasOwn(plan.options.env,name),false);
 assert.doesNotMatch(plan.args[1],/require\(|eval\(|import\(/);
});
test('shared strict decoder rejects duplicate keys, invalid JSON and unsafe numbers',()=>{
 for(const value of ['{"stage":1,"stage":2}','{"stage":01}','{"stage":1e999}','{"x":"\\ud800"}','{"x":"a\n"}'])assert.throws(()=>tools.parseStrictJSON(value));
});
test('MCP pipeline drains queued EOF, rejects duplicate request and unknown tool',{timeout:10000},async t=>{
 const root=fixture(t,'module.exports=(a,b)=>a+b;');const child=spawn(process.execPath,[require.resolve('../lib/provider-test-tools'),root],{windowsHide:true});t.after(()=>child.kill());
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
 const rows=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'verify_add',arguments:{stage:1}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'verify_add',arguments:{stage:1}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'shell',arguments:{command:'anything'}}}];
 child.stdin.end(rows.map(r=>JSON.stringify(r)).join('\n')+'\n');assert.equal(await closed,0,stderr);
 const output=stdout.trim().split('\n').map(JSON.parse);assert.equal(output.filter(r=>r.result?.content).length,1);assert.equal(JSON.parse(output.find(r=>r.result?.content).result.content[0].text).passed,true);assert.ok(output.some(r=>r.id===3&&r.error?.code===-32600));assert.ok(output.some(r=>r.id===4&&r.error?.code===-32602));
});
