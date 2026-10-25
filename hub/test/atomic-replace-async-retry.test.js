'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {ReviewedWorkspace}=require('../lib/reviewed-workspace');
const win=process.platform==='win32'?test:test.skip;

function tmpDir(t,prefix){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),prefix));
  t.after(()=>{
    const actual=fs.realpathSync(root);
    assert.equal(path.dirname(actual).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
    fs.rmSync(actual,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  });
  return root;
}
function errno(code){const e=Error(code+": operation not permitted, rename 'C:\\\\blocked\\\\a.tmp'");e.code=code;return e;}
function patchRename(t,impl){
  t.mock.method(fs,'renameSync',impl);
  t.mock.method(fs.promises,'rename',async(from,to)=>impl(from,to));
}

test.describe('replaceAsync and workspace saveAsync',{concurrency:1},()=>{
  test('replaceAsync exists, returns a Promise, retries EPERM twice then resolves to 3 with injected async sleep [25,50]',async t=>{
    const {replaceAsync}=require('../lib/atomic-replace');
    assert.equal(typeof replaceAsync,'function');
    const dir=tmpDir(t,'hub-atomic-async-');
    const tmp=path.join(dir,'a.tmp'),dest=path.join(dir,'a.json');
    fs.writeFileSync(tmp,'payload\n');
    const sleeps=[],orig=fs.renameSync;let n=0;
    patchRename(t,(from,to)=>{n++;if(n<=2)throw errno('EPERM');return orig(from,to);});
    const result=replaceAsync(tmp,dest,{sleep:async ms=>{sleeps.push(ms);}});
    assert.equal(typeof result.then,'function');
    assert.equal(await result,3);
    assert.deepEqual(sleeps,[25,50]);
    assert.equal(fs.readFileSync(dest,'utf8'),'payload\n');
  });

  test('replaceAsync real retry does not block the event loop',async t=>{
    const {replaceAsync}=require('../lib/atomic-replace');
    assert.equal(typeof replaceAsync,'function');
    const dir=tmpDir(t,'hub-atomic-async-loop-');
    const tmp=path.join(dir,'b.tmp'),dest=path.join(dir,'b.json');
    fs.writeFileSync(tmp,'payload\n');
    const orig=fs.renameSync;let n=0;
    patchRename(t,(from,to)=>{n++;if(n<=1)throw errno('EPERM');return orig(from,to);});
    let immediateRan=false,settledBeforeImmediate=false;
    setImmediate(()=>{immediateRan=true;});
    const pending=replaceAsync(tmp,dest);
    const saw=pending.then(()=>{if(!immediateRan)settledBeforeImmediate=true;});
    await pending;await saw;
    assert.equal(immediateRan,true);
    assert.equal(settledBeforeImmediate,false);
  });

  win('ReviewedWorkspace.saveAsync maps ENOSPC and EPERM without leftover tmp',async t=>{
    assert.equal(typeof ReviewedWorkspace.prototype.saveAsync,'function');
    for(const code of ['ENOSPC','EPERM']){
      const f=workspace(t),orig=fs.renameSync;
      const fail=(from,to)=>{throw Object.assign(Error(code+": operation not permitted, rename '"+from+"' -> '"+to+"'"),{code});};
      fs.renameSync=fail;
      const origAsync=fs.promises.rename.bind(fs.promises);
      fs.promises.rename=async(from,to)=>fail(from,to);
      try{
        await assert.rejects(()=>f.ws.saveAsync(f.record()),e=>{
          assert.equal(e.code,'WORKSPACE_RECORD_WRITE_FAILED');
          assert.doesNotMatch(String(e.message),/[A-Za-z]:[\\/]/);
          if(code==='ENOSPC'){
            assert.match(String(e.message),/ENOSPC/);
            assert.equal(String(e.message).includes('防毒'),false);
          }else{
            assert.match(String(e.message),/防毒/);
          }
          return true;
        });
        const leftovers=fs.existsSync(f.ws.records)?fs.readdirSync(f.ws.records).filter(n=>n.endsWith('.tmp')):[];
        assert.deepEqual(leftovers,[]);
      }finally{
        fs.renameSync=orig;
        fs.promises.rename=origAsync;
      }
    }
  });
});

function workspace(t){
  const tmp=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(tmp,'hub-workspace-review-')),base=path.join(root,'project');
  fs.mkdirSync(base);
  t.after(()=>{
    assert.ok(root.startsWith(tmp+path.sep));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  });
  const d={project:'p',task:'one',title:'Synthetic task',taskHash:'task-1',base,workRoot:path.join(root,'Work','p')};
  const ws=new ReviewedWorkspace({root,resolve:()=>({...d})});
  function record(){
    return {
      version:1,id:randomUUID(),at:new Date().toISOString(),project:'p',task:'one',title:d.title,taskHash:d.taskHash,
      base:path.resolve(base),workRoot:path.resolve(d.workRoot),mode:'isolated',kind:'non-git',
      original:{allContent:'a'.repeat(64),head:null},
      execution:{configHash:'b'.repeat(64),hooks:[],blockers:[]},
      secrets:{rootFingerprint:'c'.repeat(64),files:[]},
      trackedSecrets:[],state:'planned',complete:false,error:'',supplied:[]
    };
  }
  return {root,base,d,ws,record};
}
