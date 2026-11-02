'use strict';
// Reviewed artifacts only. A matching hash is not real-machine acceptance.
const REVIEWED=Object.freeze({
  '0.154.0':Object.freeze({binaryHash:'be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde',vendorHash:'d348d8f114f6244458beb40c578b41656030e7e3c66b9e8866c01f7d4a6b7ae7',lifetimeProfile:'native-command-lifetime-0.154.0'}),
  '0.164.0':Object.freeze({binaryHash:'6f267830b029ee25d9339864aa867cd45de9f8fd4c5ea007d2e63c13a0c66d36',vendorHash:'b2efa5f01d47b2ea423b08c1f0b250e4ee6d606d78c26b940a9ec0dc910b60de',lifetimeProfile:'native-command-lifetime-0.154.0'})
});
const reviewed=version=>typeof version==='string'&&Object.hasOwn(REVIEWED,version)?REVIEWED[version]:null;
const versionForHash=hash=>Object.keys(REVIEWED).find(version=>REVIEWED[version].binaryHash===hash)||null;
module.exports={REVIEWED,reviewed,versionForHash};
