'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readHistory,readMeta}=require('../lib/chat-state-reader');
const chat=require('../lib/chat');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-chat-state-'));
  t.after(()=>{
    const actual=fs.realpathSync(root),parent=fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
    assert.ok(path.basename(actual).startsWith('hub-chat-state-'));
    fs.rmSync(actual,{recursive:true,force:true});
  });
  return root;
}
function rejected(code,status,file,marker='PRIVATE_STATE_FIXTURE_4E0'){
  return error=>{
    assert.equal(error.code,code);assert.equal(error.status,status);assert.equal(error.notStarted,true);
    assert.equal(Object.hasOwn(error,'cause'),false);
    for(const text of [String(error),JSON.stringify(error),String(error.stack)]){
      assert.equal(text.includes(file),false);assert.equal(text.includes(marker),false);
    }
    return true;
  };
}

test('only missing files default to fresh empty history or metadata',t=>{
  const root=fixture(t),file=path.join(root,'not-created.json');
  assert.deepEqual(readHistory(file),[]);
  const first=readMeta(file);first.sessions.claude='changed';first.models.codex='changed';
  assert.deepEqual(readMeta(file),{sessions:{},models:{}});
  assert.equal(fs.existsSync(file),false);
});

test('history preserves Unicode, legacy event objects, duplicate instructions and CRLF',t=>{
  const root=fixture(t),file=path.join(root,'history.jsonl');
  const rows=[{role:'user',text:'繼續模組A 🧪\n第二行',request:'accepted-1'},
    {role:'assistant',ai:'claude',text:'尚未完成',extension:{module:'A'}},
    {role:'user',text:'繼續模組A 🧪\n第二行',request:'accepted-2'},
    {legacyEvent:{state:'running'}}];
  const bytes=Buffer.from(' \r\n'+rows.map(row=>JSON.stringify(row)).join('\r\n')+'\r\n\t\r\n');
  fs.writeFileSync(file,bytes);assert.deepEqual(readHistory(file),rows);assert.deepEqual(fs.readFileSync(file),bytes);
});

test('empty history is valid but an existing empty metadata file is corrupt',t=>{
  const root=fixture(t),file=path.join(root,'empty.json');fs.writeFileSync(file,'');
  assert.deepEqual(readHistory(file),[]);
  assert.throws(()=>readMeta(file),rejected('CHAT_META_CORRUPT',409,file));
  fs.writeFileSync(file,' \r\n\t');
  assert.deepEqual(readHistory(file),[]);
  assert.throws(()=>readMeta(file),rejected('CHAT_META_CORRUPT',409,file));
});

test('one damaged history row rejects the whole read and preserves the original bytes',t=>{
  const root=fixture(t),file=path.join(root,'history.jsonl');
  const bytes=Buffer.from('{"role":"user","request":"already-accepted"}\n{"text":"PRIVATE_STATE_FIXTURE_4E0"');
  fs.writeFileSync(file,bytes);
  assert.throws(()=>readHistory(file),rejected('CHAT_HISTORY_CORRUPT',409,file));
  assert.deepEqual(fs.readFileSync(file),bytes);
});

test('history rejects non-object JSON rows rather than dropping or forwarding them',t=>{
  const root=fixture(t),file=path.join(root,'history.jsonl');
  for(const row of [null,[],false,0,'PRIVATE_STATE_FIXTURE_4E0']){
    fs.writeFileSync(file,JSON.stringify(row)+'\n');
    assert.throws(()=>readHistory(file),rejected('CHAT_HISTORY_CORRUPT',409,file));
  }
});

test('invalid UTF-8 and BOM are rejected without replacement or silent removal',t=>{
  const root=fixture(t),file=path.join(root,'state.json');
  for(const bytes of [Buffer.from([0xc3,0x28]),Buffer.from([0xef,0xbb,0xbf]),
    Buffer.from('\ufeff\n{}'),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{}')])]){
    fs.writeFileSync(file,bytes);
    assert.throws(()=>readHistory(file),rejected('CHAT_HISTORY_CORRUPT',409,file));
    assert.throws(()=>readMeta(file),rejected('CHAT_META_CORRUPT',409,file));
    assert.deepEqual(fs.readFileSync(file),bytes);
  }
  fs.writeFileSync(file,'{}\n\ufeff\n{}');
  assert.throws(()=>readHistory(file),rejected('CHAT_HISTORY_CORRUPT',409,file));
});

test('metadata preserves valid legacy fields and separate provider sessions',t=>{
  const root=fixture(t),file=path.join(root,'state.json');
  for(const meta of [{},{rulesSent:{claude:{sid:'original',restore:true}}},
    {sessions:{claude:'claude-session',codex:'codex-session',grok:'grok-session'},
      models:{claude:'原模型',codex:'',grok:'原Grok模型'},extension:{preserve:[1,true,'資料']}}]){
    const bytes=Buffer.from(JSON.stringify(meta));fs.writeFileSync(file,bytes);
    assert.deepEqual(readMeta(file),meta);assert.deepEqual(fs.readFileSync(file),bytes);
  }
});

test('damaged metadata and session/model maps fail without starting a fresh conversation',t=>{
  const root=fixture(t),file=path.join(root,'state.json');
  const invalid=[null,[],0,'PRIVATE_STATE_FIXTURE_4E0',{sessions:null},{sessions:[]},
    {sessions:{claude:''}},{sessions:{claude:123}},{sessions:{claude:'bad\0id'}},
    {sessions:{claude:'\ud800'}},{models:[]},{models:null},{models:{grok:{}}},
    {models:{grok:'bad\0model'}},{models:{grok:'\udc00'}}];
  for(const meta of invalid){
    const bytes=Buffer.from(JSON.stringify(meta));fs.writeFileSync(file,bytes);
    assert.throws(()=>readMeta(file),rejected('CHAT_META_CORRUPT',409,file));
    assert.deepEqual(fs.readFileSync(file),bytes);
  }
  fs.writeFileSync(file,'{"sessions":');
  assert.throws(()=>readMeta(file),rejected('CHAT_META_CORRUPT',409,file));
});

test('optional provider binding rejects missing or conflicting native identity without rewriting',t=>{
  const root=fixture(t),file=path.join(root,'state.json');
  const binding=require('../lib/provider-session-binding');
  const scope={project:'p',task:'one',actor:'claude',runtimeProfileId:'runtime-v1',
    accountProfileId:'local-profile-1',rootFingerprint:'a'.repeat(64)};
  const valid=binding.bind({models:{codex:'existing'},extension:{keep:true}},scope,'session-one');
  fs.writeFileSync(file,JSON.stringify(valid));assert.deepEqual(readMeta(file),valid);
  for(const bad of [{...valid,sessions:{}},{...valid,sessions:{claude:'other'}},
    {...valid,providerBindings:{claude:{...valid.providerBindings.claude,extra:true}}},
    {...valid,providerBindings:{claude:{...valid.providerBindings.claude,accountProfileId:'bad\0profile'}}}]){
    const bytes=Buffer.from(JSON.stringify(bad));fs.writeFileSync(file,bytes);
    assert.throws(()=>readMeta(file),rejected('CHAT_META_CORRUPT',409,file));
    assert.deepEqual(fs.readFileSync(file),bytes);
  }
});

test('I/O failures are different from missing or corrupt state and retain the input',t=>{
  const root=fixture(t),directory=path.join(root,'directory');fs.mkdirSync(directory);
  assert.throws(()=>readHistory(directory),rejected('CHAT_HISTORY_READ_FAILED',503,directory));
  assert.throws(()=>readMeta(directory),rejected('CHAT_META_READ_FAILED',503,directory));
  assert.equal(fs.statSync(directory).isDirectory(),true);
});

test('ChatRunner refuses corrupt task session state before appending or spawning',t=>{
  const root=fixture(t),dir=path.join(root,'.ai','chat');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'one.json'),bytes=Buffer.from('{"sessions":"PRIVATE_STATE_FIXTURE_4E0"}');
  fs.writeFileSync(file,bytes);
  const runner=new chat.ChatRunner({dirOf:()=>root});
  assert.throws(()=>runner.send({project:'p',task:'one',pdir:root,dir:root,ai:'codex',
    model:'GPT-6.1-Sol',text:'接續任務',basePrompt:'fixture',perm:'codex',request:'accepted-2'}),
    rejected('CHAT_META_CORRUPT',409,file));
  assert.equal(runner.busy('p','one'),null);
  assert.equal(fs.existsSync(path.join(dir,'one.jsonl')),false);
  assert.deepEqual(fs.readFileSync(file),bytes);
});

test('public chat readers preserve task separation and expose damaged history',t=>{
  const root=fixture(t),dir=path.join(root,'.ai','chat');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'one.json'),JSON.stringify({sessions:{claude:'session-one'}}));
  fs.writeFileSync(path.join(dir,'two.json'),JSON.stringify({sessions:{claude:'session-two'}}));
  assert.equal(chat.readMeta(root,'one').sessions.claude,'session-one');
  assert.equal(chat.readMeta(root,'two').sessions.claude,'session-two');
  const file=path.join(dir,'one.jsonl');fs.writeFileSync(file,'{"role":"user"}\nBROKEN');
  assert.throws(()=>chat.read(root,'one'),rejected('CHAT_HISTORY_CORRUPT',409,file));
});

test('reconnecting an accepted request never silently reruns an unknown or failed tool turn',t=>{
  const root=fixture(t),dir=path.join(root,'.ai','chat');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'one.jsonl'),input={project:'p',task:'one',pdir:root,dir:root,ai:'codex',model:'GPT-6.1-Sol',
    text:'繼續模組',basePrompt:'fixture',perm:'codex',request:'same-request'};
  const user={role:'user',request:input.request,text:input.text,to:'codex',model:input.model};
  for(const replies of [[],[{role:'assistant',request:input.request,text:'partial',error:'interrupted'}]]){
    const bytes=Buffer.from([user,...replies].map(x=>JSON.stringify(x)).join('\n')+'\n');fs.writeFileSync(file,bytes);
    const runner=new chat.ChatRunner({dirOf:()=>root});
    assert.throws(()=>runner.send(input),{code:'CHAT_REQUEST_ALREADY_ACCEPTED',status:409,notStarted:true});
    assert.equal(runner.busy('p','one'),null);assert.deepEqual(fs.readFileSync(file),bytes);
    assert.throws(()=>runner.send({...input,text:'different'}),{code:'CHAT_REQUEST_CONFLICT',status:409,notStarted:true});
  }
  const rows=[user,{role:'assistant',request:input.request,ai:'codex',model:input.model,text:'completed',error:''}];
  fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const runner=new chat.ChatRunner({dirOf:()=>root});const cached=runner.send(input);
  assert.equal(cached.ai,'codex');assert.equal(runner.busy('p','one'),null);
  // A later accepted duplicate from an older version cannot borrow an earlier
  // completion as evidence that its own execution succeeded.
  fs.appendFileSync(file,JSON.stringify(user)+'\n');
  assert.throws(()=>runner.send(input),{code:'CHAT_REQUEST_ALREADY_ACCEPTED'});
});


test('readMeta accepts retired binding history and empty actor containers',t=>{
  const file=path.join(fixture(t),'meta.json'),meta=require('../lib/provider-session-binding').retire({sessions:{grok:'legacy'},extension:{keep:true}},'grok',{code:'SESSION_BINDING_REQUIRED',at:new Date().toISOString()});
  fs.writeFileSync(file,JSON.stringify(meta));assert.deepEqual(readMeta(file),meta);
});
