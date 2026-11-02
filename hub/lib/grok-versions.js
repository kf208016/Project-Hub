'use strict';
// Reviewed artifacts only. A matching hash is not real-machine acceptance.
const REVIEWED=Object.freeze({
  '1.0.34':Object.freeze({binaryHash:'021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94',bytes:151293256,versionString:'grok 1.0.34 (3736acbc8658)',helpers:Object.freeze({})}),
  '1.0.70':Object.freeze({binaryHash:'1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326',bytes:176011920,versionString:'grok 1.0.70 (f50904eaee6c)',helpers:Object.freeze({
    'agent.exe':'1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326',
    'grove.exe':'aa11dd2e214fef7f49ebe6509a3e8dd88b597344a5fc77857c7bf03ce0d8d7a7',
    'grove-credential.exe':'772355911d4deee3c3b36439e850c4be6ceb3f7604086f74140f797a3a55e4c6',
    'grove-fsmonitor.exe':'df4f522f115cf7246d9449cd905ff61e0c2e8c0c1f9939d12326209f22009480'
  })})
});
const PREFERRED=Object.freeze(['1.0.70','1.0.34']);
const HASHES=Object.freeze(PREFERRED.map(version=>REVIEWED[version].binaryHash));
const reviewed=version=>typeof version==='string'&&Object.hasOwn(REVIEWED,version)?REVIEWED[version]:null;
const versionForHash=hash=>typeof hash==='string'&&/^[0-9a-f]{64}$/.test(hash)?PREFERRED.find(version=>REVIEWED[version].binaryHash===hash)||null:null;
module.exports={REVIEWED,PREFERRED,HASHES,reviewed,versionForHash};
