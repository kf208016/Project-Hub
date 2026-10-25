'use strict';
// Real helper -> authenticated egress -> exact loopback task MCP. No model,
// existing account, provider auth, browser owner token or external connection.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const egress=require('../lib/provider-egress'),relay=require('../lib/native-mcp-proxy');
for(const physical of [false,true])test('real stdio MCP helper reaches only the scoped Hub through the authenticated proxy ('+(physical?'physical package cache':'direct base')+')',{timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-mcp-relay-')),token=crypto.randomBytes(32).toString('base64url'),runId=crypto.randomUUID(),fp='a'.repeat(64),seen=[];
  let child,broker;
  const hub=http.createServer((req,res)=>{
    seen.push({url:req.url,headers:req.headers});assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(req.headers['x-hub-mcp-run'],runId);assert.equal(req.headers['proxy-authorization'],undefined);
    if(req.url==='/api/mcp/tools'){res.setHeader('content-type','application/json');res.end(JSON.stringify({tools:[{name:'hub_get_task',inputSchema:{type:'object'}}]}));return;}
    assert.equal(req.url,'/api/mcp/call');assert.match(req.headers['x-hub-mcp-nonce'],/^[a-f0-9-]{36}$/);let data='';req.on('data',b=>data+=b);req.on('end',()=>{assert.equal(JSON.parse(data).name,'hub_get_task');res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'synthetic task'}));});
  });
  t.after(async()=>{if(child){child.stdin.end();if(child.exitCode===null)await new Promise(r=>{child.once('close',r);setTimeout(()=>child.kill(),1000).unref();});}if(broker)await broker.close();await new Promise(r=>hub.close(r));const absolute=fs.realpathSync(dir);assert.equal(path.dirname(absolute).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(absolute).startsWith('hub-native-mcp-relay-'));fs.rmSync(absolute,{recursive:true,force:true});});
  await new Promise(r=>hub.listen(0,'127.0.0.1',r));const port=hub.address().port;
  broker=await egress.create({provider:'claude',maxWallMs:10000,handleHttp:relay.create({port,token,runId}).handle});
  const relativeBase=physical?'AppData/Local/Packages/SyntheticFamily_123/LocalCache/Local/ProjectHub/runtime':'AppData/Local/ProjectHub/runtime';
  const target=path.join(dir,relativeBase,fp,'claude/mcp',runId+'.json');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify({version:1,actor:'claude',rootFingerprint:fp,runId,port,token}));
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('HUB_'))delete env[key];Object.assign(env,{HUB_MCP_TASK_CREDENTIAL_FILE:target,HTTP_PROXY:broker.proxyUrl});
  child=spawn(process.execPath,[path.join(__dirname,'../mcp.js')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();let data='',id=0;const pending=new Map();
  child.stdout.on('data',b=>{data+=b;const lines=data.split('\n');data=lines.pop();for(const line of lines)if(line){const row=JSON.parse(line);pending.get(row.id)?.(row);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('synthetic MCP timeout')),5000);pending.set(n,value=>{clearTimeout(timer);pending.delete(n);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
  assert.equal((await rpc('tools/list')).result.tools[0].name,'hub_get_task');assert.equal((await rpc('tools/call',{name:'hub_get_task',arguments:{project:'synthetic',task:'t'}})).result.content[0].text,'synthetic task');
  assert.equal(seen.length,2);
  const proxy=new URL(broker.proxyUrl),basic='Basic '+Buffer.from(proxy.username+':'+proxy.password).toString('base64');
  const get=(url,auth=basic)=>new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:proxy.port,path:url,headers:{Host:'127.0.0.1:'+port,'Proxy-Authorization':auth,Authorization:'Bearer '+token,'X-Hub-Mcp-Run':runId},agent:false},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});q.on('error',reject);q.end();});
  assert.equal(await get('http://127.0.0.1:'+port+'/api/quit'),404);
  assert.equal(await get('http://127.0.0.1:'+port+'/api/mcp/tools','Basic bad'),403);
  assert.equal(await get('http://127.0.0.1:'+(port===65535?1024:port+1)+'/api/mcp/tools'),404);
  assert.equal(seen.length,2,'No forbidden request reached Hub');
});
