'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {marginFromEnv,loginState}=require('../lib/grok-login');
const {MAX_WALL_MS}=require('../lib/native-turn-limits');
test('R24 default margin covers max wall plus five minutes and exact freshness boundary',t=>{
  const ttl=21300000,mtime=1800000000000,margin=marginFromEnv(undefined,ttl);
  assert.equal(margin,2100000);assert.equal(margin-MAX_WALL_MS,300000);
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r24-margin-')),file=path.join(home,'.grok','auth.json');
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'synthetic');fs.utimesSync(file,mtime/1000,mtime/1000);
  t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
  for(const [age,state]of [[ttl-2100000,'expiring'],[ttl-2100001,'fresh']]){
    const login=loginState({home,now:mtime+age});assert.equal(login.state,state);
    assert.equal(login.refreshAt,mtime+ttl-2100000);
  }
});
