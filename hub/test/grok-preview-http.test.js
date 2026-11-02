'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {NativeProviderService}=require('../lib/native-provider-service'),host=require('../lib/provider-native-host'),artifacts=require('../lib/native-cli-update'),safe=require('../lib/safe-path'),scoped=require('../lib/scoped-file');
require('../lib/native-provider-binary');require('../lib/native-provider-messages');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
test('actual preview route returns 409 and bounded Grok digest through service and approvals',async t=>{
 const ownerHome='C:\\Users\\synthetic',binding={project:'p',task:'t',dir:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),run:'run'};
 t.mock.method(safe,'localPath',p=>p);t.mock.method(scoped,'identity',async()=>({rootFingerprint:'b'.repeat(64)}));
 t.mock.method(fs,'lstatSync',(_p,o)=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:o?.bigint?1n:1,size:o?.bigint?12n:12,dev:1n}));
 t.mock.method(artifacts,'digestFile',file=>file.endsWith('codex.exe')?artifacts.KNOWN:'012345abcdef'+'0'.repeat(52));
 const service=new NativeProviderService({resolveWorkspace:async()=>binding,profile:async()=>({ownerHome,runtimeBase:ownerHome+'\\AppData\\Local\\ProjectHub',providerFile:'C:\\Synthetic\\grok.exe',codexFile:'C:\\Synthetic\\codex.exe',codexSHA256:artifacts.KNOWN,nodeFile:process.execPath,gitDirectory:'C:\\Synthetic\\git',hubLibDirectory:'C:\\Synthetic\\lib',systemRoot:'C:\\Windows'}),modelFlag:()=> 'grok-4.6',effortFlag:()=> 'medium',supervisedSpawn:()=>assert.fail('no spawn')});
 const start=source.indexOf("  if(url.pathname.startsWith('/api/native-provider/')){"),end=source.indexOf('  const transactionReadRoutes=',start),errorFunction=source.split('\n').find(line=>line.startsWith('function nativeWorkspaceError('));
 assert.ok(start>=0&&end>start);assert.ok(errorFunction);
 const context=vm.createContext({require:require('node:module').createRequire(path.join(__dirname,'../server.js')),nativeProviderService:service,localOwner:()=>true,fromRemote:()=>false,reqCtx:{getStore:()=>null},send:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}});
 const handler=vm.runInContext(errorFunction+'\n(async(req,res,url,b)=>{'+source.slice(start,end)+'})',context);
 const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);await handler(req,res,new URL(req.url,'http://127.0.0.1'),JSON.parse(Buffer.concat(chunks)));}catch(error){res.writeHead(500);res.end(error.code||'unexpected');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));assert.ok(![4545,4546].includes(server.address().port));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/native-provider/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:'grok',project:'p',task:'t',model:'Grok 4.6',effort:'高'})}),data=await response.json();
 assert.equal(response.status,409);assert.equal(data.code,'NATIVE_GROK_VERSION_UNREVIEWED');assert.equal(data.notStarted,true);assert.match(data.error,/012345abcdef/);assert.match(data.error,/請勿回滾/);assert.equal(service.active(),0);
});

test('Grok approval sanitizer retains only validated own data details',async()=>{
 const code='NATIVE_GROK_VERSION_UNREVIEWED',scope={actor:'grok',project:'p',task:'t',model:'Grok 4.6',effort:'高'},{NativeProviderApprovals}=require('../lib/native-provider-approvals');
 for(const detail of [{hashPrefix:'012345abcdef'},{override:'bad'},{hashPrefix:'PRIVATE'},{get hashPrefix(){throw Error('GETTER');}}]){
  const error=Object.defineProperties(Object.assign(Error('PRIVATE'),{code}),Object.getOwnPropertyDescriptors(detail));
  const store=new NativeProviderApprovals({describe:()=>{throw error;}});
  await assert.rejects(store.preview(scope),e=>e.code===code&&e.status===409&&e.notStarted&&!e.message.includes('PRIVATE')&&!e.message.includes('GETTER')&&(Object.getOwnPropertyDescriptor(detail,'hashPrefix')?.value!=='012345abcdef'||e.message.includes('012345abcdef')));
 }
});
