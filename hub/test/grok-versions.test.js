'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const v=require('../lib/grok-versions');
test('exact reviewed artifacts and nested immutable lookup contract',()=>{
 const expected={
 '1.0.34':{binaryHash:'021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94',bytes:151293256,versionString:'grok 1.0.34 (3736acbc8658)',helpers:{}},
 '1.0.70':{binaryHash:'1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326',bytes:176011920,versionString:'grok 1.0.70 (f50904eaee6c)',helpers:{'agent.exe':'1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326','grove.exe':'aa11dd2e214fef7f49ebe6509a3e8dd88b597344a5fc77857c7bf03ce0d8d7a7','grove-credential.exe':'772355911d4deee3c3b36439e850c4be6ceb3f7604086f74140f797a3a55e4c6','grove-fsmonitor.exe':'df4f522f115cf7246d9449cd905ff61e0c2e8c0c1f9939d12326209f22009480'}}};
 assert.deepEqual(v.REVIEWED,expected);assert.deepEqual(v.PREFERRED,['1.0.70','1.0.34']);assert.deepEqual(v.HASHES,v.PREFERRED.map(x=>expected[x].binaryHash));
 for(const obj of [v.REVIEWED,v.PREFERRED,v.HASHES,...Object.values(v.REVIEWED).flatMap(x=>[x,x.helpers])])assert.ok(Object.isFrozen(obj));
 for(const [version,item] of Object.entries(expected)){assert.equal(v.reviewed(version),v.REVIEWED[version]);assert.equal(v.versionForHash(item.binaryHash),version);assert.equal(v.versionForHash(item.binaryHash.toUpperCase()),null);}
 for(const value of [undefined,null,{},42,'toString','__proto__','1.0.7'])assert.equal(v.reviewed(value),null);
 for(const value of [undefined,null,{},42,'0'.repeat(64),'a'.repeat(63)])assert.equal(v.versionForHash(value),null);
});
