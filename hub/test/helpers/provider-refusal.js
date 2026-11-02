'use strict';
const assert=require('node:assert/strict'),providers=require('../../lib/provider-registry');
async function providerRefusal(res){
 let refusal;assert.throws(()=>providers.assertCapability('claude','chat',{platform:'win32'}),error=>{refusal=error;return error.code==='WINDOWS_PROVIDER_ISOLATION_UNVERIFIED'&&error.status===409;});
 assert.equal(res.status,409,await res.clone().text());assert.deepEqual(await res.json(),{error:refusal.message});
}
module.exports={providerRefusal};
