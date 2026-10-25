'use strict';
// Deliberate contract/validator checks, not a full JSON Schema implementation.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {WebChat,LIMITS}=require('../lib/web-chat');
const {validateRecord,decode,scalar}=require('../lib/web-chat-receipts');
const {fixture,approved}=require('./helpers/web-chat-fixture');
const dir=path.join(__dirname,'../windows'),contract=JSON.parse(fs.readFileSync(path.join(dir,'web-chat-contract.schema.json'),'utf8'));
test('schemas fix actor/state/key allowlists, byte bounds and references without claiming full conformance',()=>{
  assert.equal(contract.$schema,'https://json-schema.org/draft/2020-12/schema');
  for(const [name,keys]of [['preview',['actor','project','task','text']],['confirm',['actor','project','task','receiptId','previewToken','expectedTaskHash','expectedPromptSHA256','confirm']],['result',['actor','project','task','receiptId','taskHash','promptSHA256','requestId','resultSHA256','text','token']],['lookup',['actor','project','task','receiptId']]]){
    assert.equal(contract.$defs[name].additionalProperties,false);assert.deepEqual(contract.$defs[name].required,keys);assert.deepEqual(contract.$defs[name].properties.actor.enum,['chatgpt','claude-chat']);const wrapper=JSON.parse(fs.readFileSync(path.join(dir,'web-chat-'+name+'.schema.json'),'utf8'));assert.equal(wrapper.$ref,'web-chat-contract.schema.json#/$defs/'+name);
  }
  assert.equal(contract.$defs.receipt.additionalProperties,false);assert.equal(contract.$defs.receipt.properties.version.const,2);assert.equal(contract.$defs.receipt.properties.taskHashAlgorithm.const,'hub-completion-crlf-to-lf-v1');assert.equal(contract.$defs.preview.properties.text.maxLength,LIMITS.input);assert.equal(contract.$defs.result.properties.text.maxLength,LIMITS.result);
  for(const name of ['identity','blob','extraction','transaction'])assert.equal(contract.$defs[name].additionalProperties,false);
});
test('documented valid and invalid examples run against the actual admission validator',async t=>{
  const f=fixture(t),s=new WebChat(f.options),examples=JSON.parse(fs.readFileSync(path.join(dir,'web-chat-examples.json'),'utf8'));
  for(const example of [examples.validPreview,examples.validClaudePreview])assert.equal((await s.preview({...example,owner:'fixture-owner',project:'p',task:'t'})).ok,true);
  for(const example of examples.invalidPreview){const input={...example,owner:'fixture-owner',project:'p',task:'t'};if(Object.hasOwn(example,'owner'))input.ownerFromWire=example.owner;await assert.rejects(s.preview(input));}
  assert.deepEqual(examples.limitsUTF8Bytes,{input:LIMITS.input,prompt:LIMITS.prompt,result:LIMITS.result,row:LIMITS.row,task:LIMITS.task,metadata:LIMITS.metadata,log:LIMITS.log});
});
test('live generated receipts validate while cross-file, state, purpose/hash and unknown keys fail closed',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),record=(await s.receipts.read(a.preview.receiptId)).value;assert.equal(validateRecord(record),record);
  const change=fn=>{const value=structuredClone(record);fn(value);assert.throws(()=>validateRecord(value));};
  change(v=>v.extra=true);change(v=>v.actor='grok');change(v=>v.destination='https://evil.example');change(v=>v.taskHashAlgorithm='raw');change(v=>v.sourceManifest[0].identity.relative='.ai/tasks/other.md');change(v=>v.promptBlob.relative='other/prompt.txt');change(v=>v.state='committed');change(v=>v.resultExpiresAt++);change(v=>v.sourceManifest[0].identity.rootFingerprint='b'.repeat(64));change(v=>v.truncation.push({arbitrary:true}));
});
test('wire decoder rejects replacement/BOM loss/NUL/scalar errors instead of altering hashed bytes',()=>{
  assert.equal(decode(Buffer.from('繁體中文😀'),100),'繁體中文😀');assert.equal(decode(Buffer.from([0xef,0xbb,0xbf,0x61]),100),'\ufeffa');
  for(const bytes of [Buffer.from([0xff]),Buffer.from([0xc0,0xaf]),Buffer.from([0xed,0xa0,0x80]),Buffer.from([0x00])])assert.throws(()=>decode(bytes,100));assert.throws(()=>scalar('\ud800'));assert.throws(()=>scalar('\udc00'));
});
