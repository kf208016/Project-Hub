'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {ReviewedWorkspace}=require('../lib/reviewed-workspace');
const win=process.platform==='win32'?test:test.skip;
const DELAYS=[25,50,100,200,300,400,500];

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
function replaceSync(...args){return require('../lib/atomic-replace').replaceSync(...args);}

test.describe('atomic-replace and workspace save',{concurrency:1},()=>{
  test('replaceSync retries EPERM twice then returns 3 with the first two default delays',t=>{
    const dir=tmpDir(t,'hub-atomic-');
    const tmp=path.join(dir,'a.tmp'),dest=path.join(dir,'a.json');
    fs.writeFileSync(tmp,'payload\n');
    const sleeps=[],orig=fs.renameSync;let n=0;
    fs.renameSync=(from,to)=>{n++;if(n<=2)throw errno('EPERM');return orig(from,to);};
    try{
      const attempts=replaceSync(tmp,dest,{sleep:ms=>sleeps.push(ms)});
      assert.equal(attempts,3);
      assert.deepEqual(sleeps,DELAYS.slice(0,2));
      assert.equal(fs.readFileSync(dest,'utf8'),'payload\n');
    }finally{fs.renameSync=orig;}
  });

  test('replaceSync always EBUSY throws after 8 attempts and removes the tmp file',t=>{
    const dir=tmpDir(t,'hub-atomic-');
    const tmp=path.join(dir,'b.tmp'),dest=path.join(dir,'b.json');
    fs.writeFileSync(tmp,'payload\n');
    const sleeps=[],orig=fs.renameSync;let n=0;
    fs.renameSync=()=>{n++;throw errno('EBUSY');};
    try{
      assert.throws(()=>replaceSync(tmp,dest,{sleep:ms=>sleeps.push(ms)}),e=>e.code==='EBUSY'&&e.attempts===8);
      assert.equal(n,8);
      assert.deepEqual(sleeps,DELAYS);
      assert.equal(fs.existsSync(tmp),false);
    }finally{fs.renameSync=orig;}
  });

  test('replaceSync ENOENT does not retry',t=>{
    const dir=tmpDir(t,'hub-atomic-');
    const tmp=path.join(dir,'c.tmp'),dest=path.join(dir,'c.json');
    fs.writeFileSync(tmp,'payload\n');
    const sleeps=[],orig=fs.renameSync;let n=0;
    fs.renameSync=()=>{n++;throw Object.assign(Error('ENOENT'),{code:'ENOENT'});};
    try{
      assert.throws(()=>replaceSync(tmp,dest,{sleep:ms=>sleeps.push(ms)}),e=>e.code==='ENOENT'&&e.attempts===1);
      assert.equal(n,1);
      assert.deepEqual(sleeps,[]);
      assert.equal(fs.existsSync(tmp),false);
    }finally{fs.renameSync=orig;}
  });

  win('ReviewedWorkspace.save maps persistent EPERM to WORKSPACE_RECORD_WRITE_FAILED without a path or errno',t=>{
    const f=workspace(t);const orig=fs.renameSync;
    fs.renameSync=(from,to)=>{throw Object.assign(Error("EPERM: operation not permitted, rename '"+from+"' -> '"+to+"'"),{code:'EPERM'});};
    try{
      assert.throws(()=>f.ws.save(f.record()),e=>{
        assert.equal(e.code,'WORKSPACE_RECORD_WRITE_FAILED');
        assert.doesNotMatch(String(e.message),/[A-Za-z]:[\\/]/);
        assert.doesNotMatch(String(e.message),/EPERM/i);
        assert.equal(String(e.message).includes(f.ws.records),false);
        return true;
      });
      const leftovers=fs.existsSync(f.ws.records)?fs.readdirSync(f.ws.records).filter(n=>n.endsWith('.tmp')):[];
      assert.deepEqual(leftovers,[]);
    }finally{fs.renameSync=orig;}
  });

  win('ReviewedWorkspace.save removes a stale matching tmp and keeps a fresh one and a non-matching name',t=>{
    const f=workspace(t);
    fs.mkdirSync(f.ws.records,{recursive:true});
    const stale=path.join(f.ws.records,'d'.repeat(64)+'.json.12345678-1234-1234-1234-123456789abc.tmp');
    const fresh=path.join(f.ws.records,'e'.repeat(64)+'.json.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp');
    const other=path.join(f.ws.records,'notes.tmp');
    fs.writeFileSync(stale,'stale');fs.writeFileSync(fresh,'fresh');fs.writeFileSync(other,'keep');
    const old=new Date(Date.now()-11*60*1000);
    fs.utimesSync(stale,old,old);
    f.ws.save(f.record());
    assert.equal(fs.existsSync(stale),false);
    assert.equal(fs.existsSync(fresh),true);
    assert.equal(fs.existsSync(other),true);
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
