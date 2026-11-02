'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readOwnerToken, expiryOf, mintJson} = require('../lib/grok-owner-token');
const at = Date.parse('2030-01-01T00:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-owner-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  fs.mkdirSync(path.join(home, '.grok'));
  const file = path.join(home, '.grok', 'auth.json');
  return {home, file, write: data => fs.writeFileSync(file, JSON.stringify(data))};
}
const entry = {key:'synthetic-access', expires_at:new Date(at).toISOString(), refresh_token:'synthetic-refresh'};
test('owner OIDC preferred, legacy fallback, frozen minimal result and no logging', t => {
  const f = fixture(t), calls=[];
  for (const k of Object.keys(console)) if (typeof console[k] === 'function') t.mock.method(console,k,(...args)=>calls.push(args));
  f.write({'https://accounts.x.ai/sign-in':{...entry,key:'legacy'},'https://auth.x.ai::synthetic':entry});
  const result=readOwnerToken(f);
  assert.deepEqual(result,{key:'synthetic-access',expiresAt:at});assert.ok(Object.isFrozen(result));
  assert.deepEqual(expiryOf(f),{expiresAt:at,code:null});
  f.write({'https://accounts.x.ai/sign-in':entry});assert.equal(readOwnerToken(f).key,entry.key);
  assert.deepEqual(calls,[]);
});
test('owner rejects missing and malformed credentials without leaking contents', t => {
  const f=fixture(t);
  assert.throws(()=>readOwnerToken(f),{code:'GROK_OWNER_TOKEN_MISSING',message:'GROK_OWNER_TOKEN_MISSING'});
  const invalid=[[],null,{}, {'https://auth.x.ai::test':[]}, ...[undefined,'','x\0secret','x\nsecret','x'.repeat(8193)].map(key=>({'https://auth.x.ai::test':{...entry,key}})),{'https://auth.x.ai::test':{...entry,expires_at:'secret-invalid'}}];
  for(const data of invalid){f.write(data);assert.throws(()=>readOwnerToken(f),{code:'GROK_OWNER_TOKEN_INVALID',message:'GROK_OWNER_TOKEN_INVALID'});}
  fs.writeFileSync(f.file,'secret-not-json');assert.equal(expiryOf(f).code,'GROK_OWNER_TOKEN_INVALID');
  fs.writeFileSync(f.file,Buffer.alloc(4*1024*1024+1));assert.throws(()=>readOwnerToken(f),{code:'GROK_OWNER_TOKEN_INVALID'});
  fs.unlinkSync(f.file);fs.mkdirSync(f.file);assert.equal(expiryOf(f).code,'GROK_OWNER_TOKEN_INVALID');
  assert.deepEqual(expiryOf(null),{expiresAt:null,code:'GROK_OWNER_TOKEN_INVALID'});
});
test('owner rejects symlinks and hardlinks via lstat metadata', t => {
  const f=fixture(t);f.write({'https://auth.x.ai::test':entry});
  const stat=fs.lstatSync(f.file);
  for(const extra of [{isSymbolicLink:()=>true},{nlink:2}]){
    const mock=t.mock.method(fs,'lstatSync',()=>({...stat,...extra}));
    assert.throws(()=>readOwnerToken(f),{code:'GROK_OWNER_TOKEN_INVALID'});mock.mock.restore();
  }
  fs.linkSync(f.file,path.join(f.home,'hardlink'));assert.throws(()=>readOwnerToken(f),{code:'GROK_OWNER_TOKEN_INVALID'});
});
test('mint floors remaining seconds, subtracts margin and clamps to one', t => {
  const f=fixture(t);f.write({'https://auth.x.ai::test':entry});
  assert.equal(mintJson({...f,now:at-120999}),'{"access_token":"synthetic-access","expires_in":60}');
  assert.equal(JSON.parse(mintJson({...f,now:at-120999,marginSec:10})).expires_in,110);
  for(const now of [at-1000,at,at+1000])assert.equal(JSON.parse(mintJson({...f,now})).expires_in,1);
});
