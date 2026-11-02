'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {clearStaleRouteFile}=require('../lib/grok-auth-route');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'r28-route-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  return path.join(root,'route.json');
}
test('R28 missing route is harmless; small single-link file is removed',t=>{
  const file=fixture(t);assert.equal(clearStaleRouteFile(file),false);
  fs.writeFileSync(file,'x'.repeat(1024));assert.equal(clearStaleRouteFile(file),true);assert.equal(fs.existsSync(file),false);
});
for(const kind of ['oversize','hardlink','directory','symlink'])test('R28 unexpected route retained: '+kind,t=>{
  const file=fixture(t);
  if(kind==='directory')fs.mkdirSync(file);
  else if(kind==='symlink'){
    fs.writeFileSync(file+'.target','synthetic');
    try{fs.symlinkSync(file+'.target',file);}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Platform cannot create symlinks: '+error.code);return;}throw error;}
  }else{fs.writeFileSync(file,kind==='oversize'?'x'.repeat(1025):'synthetic');if(kind==='hardlink')fs.linkSync(file,file+'.link');}
  assert.throws(()=>clearStaleRouteFile(file),{message:'GROK_ROUTE_FILE_UNEXPECTED'});assert.ok(fs.lstatSync(file));
});
test('R28 server cleans unowned routes before wx and retains live/undisposed ownership',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const line=source.split('\n').find(line=>line.includes('.clearStaleRouteFile(routeFile)'));
  assert.ok(line);assert.match(source.slice(source.indexOf(line)+line.length),/^\n\s*const routeFd=fs.openSync\(routeFile,'wx',0o600\);/);
  for(const owned of [false,true]){
    const calls=[],routeFile='synthetic-route';
    vm.runInNewContext(line,{routeFile,nativeProviderResources:new Map(owned?[['run',{routeFile}]]:[]),r:{project:'p',task:'t',runId:'r'},
      require:()=>({clearStaleRouteFile:file=>{assert.equal(file,routeFile);calls.push('clear');return true;}}),record:(action,b,extra)=>{assert.equal(action,'grok-route-stale');assert.equal(extra.runId,'r');assert.equal(b.ai,'grok');calls.push('record');}});
    assert.deepEqual(calls,owned?[]:['clear','record']);
  }
});
