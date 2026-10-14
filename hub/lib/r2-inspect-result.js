'use strict';
// Validator for this schema's deliberately small closed subset; not a general
// JSON Schema engine. The native helper independently validates the same frame.
const schema=require('../windows/worker-r2-inspect-result.schema.json');
const {canonical}=require('./worker-channel');
function check(yes){if(!yes)throw Object.assign(Error('R2_INSPECT_OUTPUT_REJECTED'),{code:'R2_INSPECT_OUTPUT_REJECTED'});}
function matchesType(value,type){
  return type==='null'?value===null:type==='integer'?Number.isSafeInteger(value):type==='boolean'?typeof value==='boolean':type==='string'?typeof value==='string'&&value.isWellFormed()&&!value.includes('\0'):type==='array'?Array.isArray(value):type==='object'?value!==null&&!Array.isArray(value)&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)):false;
}
function walk(value,rule,depth=0){
  check(depth<=16);
  if(rule.$ref){check(rule.$ref.startsWith('#/$defs/'));const def=schema.$defs[rule.$ref.slice(8)];check(def);walk(value,def,depth+1);}
  if(rule.allOf)for(const item of rule.allOf)walk(value,item,depth+1);
  if(Object.hasOwn(rule,'const'))check(value===rule.const);
  if(rule.enum)check(rule.enum.includes(value));
  if(rule.type)check([].concat(rule.type).some(type=>matchesType(value,type)));
  if(value===null)return;
  if(typeof value==='number'){if(rule.minimum!==undefined)check(value>=rule.minimum);if(rule.maximum!==undefined)check(value<=rule.maximum);}
  if(typeof value==='string'&&rule.pattern)check(new RegExp(rule.pattern+'(?![\\s\\S])').test(value));
  if(rule.properties){
    if(rule.required)check(rule.required.every(key=>Object.hasOwn(value,key)));
    if(rule.additionalProperties===false)check(Object.keys(value).every(key=>Object.hasOwn(rule.properties,key)));
    for(const [key,item]of Object.entries(rule.properties))if(Object.hasOwn(value,key))walk(value[key],item,depth+1);
  }
  if(Array.isArray(value)){
    if(rule.minItems!==undefined)check(value.length>=rule.minItems);if(rule.maxItems!==undefined)check(value.length<=rule.maxItems);
    if(rule.prefixItems)for(let i=0;i<Math.min(value.length,rule.prefixItems.length);i++)walk(value[i],rule.prefixItems[i],depth+1);
    if(rule.items===false)check(value.length<=(rule.prefixItems?.length||0));
  }
}
function validateResult(value,grant){
  walk(value,schema);
  check(value.nonce===grant.runNonce&&value.uid===grant.uid&&value.bootId===grant.bootId);
  check(Buffer.byteLength(canonical(value))+4<=131072);
  return value;
}
module.exports={validateResult};
