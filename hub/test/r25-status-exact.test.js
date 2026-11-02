'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {status}=require('../lib/grok-status');
test('status exposes exact expiry only and unavailable expiry is null without throws',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r25-status-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  assert.equal(status(home).login.exactExpiresAt,null);fs.mkdirSync(path.join(home,'.grok'));const file=path.join(home,'.grok/auth.json'),at=1800000000000;
  fs.writeFileSync(file,JSON.stringify({'https://auth.x.ai::test':{key:'synthetic-secret',refresh_token:'synthetic-refresh',expires_at:new Date(at).toISOString()}}));
  const result=status(home);assert.equal(result.login.exactExpiresAt,at);assert.ok(Object.isFrozen(result.login));assert.doesNotMatch(JSON.stringify(result),/synthetic|refresh_token|access_token|auth\.json/);
  fs.writeFileSync(file,'broken');assert.equal(status(home).login.exactExpiresAt,null);
  t.mock.method(fs,'readFileSync',()=>{throw Error('synthetic denied');});assert.equal(status(home).login.exactExpiresAt,null);
});
function htmlFunction(source){
  const start=source.indexOf('function grokStatusHtml('),end=source.indexOf('function grokLoginHintHtml(',start);
  const context=vm.createContext({esc:s=>String(s).replaceAll('<','&lt;'),grokLoginActionsHtml:()=>'',L:s=>s,Date});
  vm.runInContext(source.slice(start,end),context);return value=>context.grokStatusHtml(value);
}
test('status UI replaces the old parenthesis only for finite exact expiry',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),render=htmlFunction(source);
  const old=htmlFunction(execFileSync('git',['show','HEAD:hub/public/app.js'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'}));
  const sample={runtime:{version:'1.0.70'},auth:{present:true,mtime:'2026-10-28T00:00:00Z'},login:{state:'fresh',refreshAt:1800000000000}};
  for(const exactExpiresAt of [undefined,null,NaN,Infinity,'1800000000000']){const value={...sample,login:{...sample.login,exactExpiresAt}};assert.equal(render(value),old(value));}
  for(const exactExpiresAt of [0,1800000000000]){
    const html=render({...sample,login:{...sample.login,exactExpiresAt}}),when=new Date(exactExpiresAt).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
    assert.ok(html.includes('（有效至 '+when+'）'));assert.ok(!html.includes('Hub 不讀取內容'));assert.ok(html.includes('建議更新時間：'));
  }
});
