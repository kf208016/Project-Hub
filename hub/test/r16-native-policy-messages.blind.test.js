'use strict';
// R16 / T2 + T3(chat.parse) + M1 blind acceptance: unregistered MCP tools are
// declined at once, the declined-tool notice text, and the new INCOMPLETE texts.
const test=require('node:test'),assert=require('node:assert/strict');
const {decide}=require('../lib/native-provider-tool-policy');

const ROOT='C:\\synthetic\\r16-work';
// server.js names: Claude sees mcp__hub__<tool>, Grok sees hub__<tool>.
const GRANT=['hub_list_tasks','hub_get_task','hub_get_chat','hub_read_file','hub_report','hub_ask_owner','hub_mark_step'];
function policy(actor,overrides={}){
  return Object.freeze({root:ROOT,modelFlag:actor==='claude'?'sonnet':'grok-4.6',commandsApproved:true,subagentsApproved:true,
    mcpTools:GRANT.map(name=>actor==='claude'?'mcp__hub__'+name:'hub__'+name),...overrides});
}
const useTool=(tool_name,tool_input={})=>({title:tool_name,kind:'other',rawInput:{variant:'UseTool',tool_name,tool_input}});

const INCOMPLETE={
  GROK_NATIVE_INCOMPLETE:'Grok 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。',
  CLAUDE_NATIVE_INCOMPLETE:'Claude 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。'
};
const DECLINED=title=>'工具操作被 Hub 拒絕，已略過（沒有執行）：'+title;
const EXPIRED=title=>'工具操作等待核准逾時，已略過（沒有執行）：'+title;
const CANCELLED=title=>'工具操作已取消（沒有執行）：'+title;
const messages=()=>require('../lib/native-provider-messages');
const {parse}=require('../lib/chat');

// ---- T2 policy ----

test('R16 T2 Grok UseTool outside the grant is declined at once (was manual)',()=>{
  for(const name of ['hub__hub_write_file','hub__hub_request_command','hub__hub_delegate','hub__hub_propose_task','mcp__hub__hub_report','mcp__search__web','other__x']){
    assert.equal(decide('grok',useTool(name,{project:'p',task:'t'}),policy('grok')),name.startsWith('hub__')?'accept':'decline',name);
  }
  assert.equal(decide('grok',useTool('hub__hub_report',{project:'p',task:'t',text:'x'}),policy('grok',{mcpTools:[]})),'accept');
});

test('R16 T2 Grok UseTool inside the grant is still accepted',()=>{
  for(const name of ['hub__hub_report','hub__hub_ask_owner','hub__hub_mark_step','hub__hub_get_task']){
    assert.equal(decide('grok',useTool(name,{project:'p',task:'t'}),policy('grok')),'accept',name);
  }
});

test('R16 T2 malformed Grok UseTool and other Grok decisions are unchanged',()=>{
  assert.equal(decide('grok',{title:'x',kind:'other',rawInput:{variant:'UseTool',tool_input:{}}},policy('grok')),'decline');
  assert.equal(decide('grok',{title:'x',kind:'other',rawInput:{variant:'UseTool',tool_name:'hub__hub_report'}},policy('grok')),'decline');
  assert.equal(decide('grok',{title:'x',kind:'other',rawInput:{variant:'UseTool',tool_name:'hub__hub_report',tool_input:[]}},policy('grok')),'decline');
  assert.equal(decide('grok',{title:'use_tool',kind:'tool',rawInput:{variant:'UseTool',tool_name:'hub__hub_report',tool_input:{}}},policy('grok')),'decline');
  for(const variant of ['TaskOutput','WaitTasks','KillTask','Dynamic'])assert.equal(decide('grok',{title:'write',kind:'edit',rawInput:{variant,file_path:'add.cjs'}},policy('grok')),'manual',variant);
  assert.equal(decide('grok',{title:'Edit',kind:'edit',rawInput:{variant:'Write',file_path:'add.cjs',content:'x'}},policy('grok')),'accept');
  assert.equal(decide('grok',{title:'Edit',kind:'edit',rawInput:{variant:'Write',file_path:'D:\\Product\\.ai\\tasks\\20261023-01.md',content:'x'}},policy('grok')),'accept');
});

test('R16 T2 Claude mcp__ tool outside the grant is declined at once (was manual)',()=>{
  for(const name of ['mcp__hub__hub_write_file','mcp__hub__hub_request_command','mcp__hub__hub_delegate','mcp__unknown__thing','mcp__filesystem__list','mcp__x']){
    assert.equal(decide('claude',{toolName:name,input:{project:'p',task:'t'}},policy('claude')),'decline',name);
  }
  assert.equal(decide('claude',{toolName:'mcp__hub__hub_report',input:{}},policy('claude',{mcpTools:[]})),'decline');
  assert.equal(decide('claude',{toolName:'hub__hub_report',input:{}},policy('claude')),'manual','Grok-style name is not an mcp__ name');
});

test('R16 T2 Claude mcp__ tool inside the grant is still accepted',()=>{
  for(const name of ['mcp__hub__hub_report','mcp__hub__hub_ask_owner','mcp__hub__hub_mark_step','mcp__hub__hub_get_task']){
    assert.equal(decide('claude',{toolName:name,input:{project:'p',task:'t'}},policy('claude')),'accept',name);
  }
});

test('R16 T2 unknown non-MCP Claude tools still go to manual',()=>{
  for(const name of ['NotebookEdit','SomeFutureTool','AskUserQuestion','mcp_hub_report','mcpTool','hub_report']){
    assert.equal(decide('claude',{toolName:name,input:{}},policy('claude')),'manual',name);
  }
  assert.equal(decide('claude',{toolName:'Write',input:{file_path:'src\\a.js',content:'x'}},policy('claude')),'accept');
  assert.equal(decide('claude',{toolName:'Edit',input:{file_path:'D:\\Product\\.ai\\tasks\\20261023-01.md',old_string:'a',new_string:'b'}},policy('claude')),'decline');
});

// ---- toolDeclinedText and INCOMPLETE texts ----

test('R16 toolDeclinedText is exported and gives the exact three sentences',()=>{
  const {toolDeclinedText}=messages();
  assert.equal(typeof toolDeclinedText,'function');
  for(const title of ['Write D:\\outside\\x.txt','hub__hub_write_file','工具 標題']){
    assert.equal(toolDeclinedText('declined',title),DECLINED(title));
    assert.equal(toolDeclinedText('expired',title),EXPIRED(title));
    assert.equal(toolDeclinedText('cancelled',title),CANCELLED(title));
  }
});

test('R16 M1 the two INCOMPLETE codes use the new sentence with the code suffix',()=>{
  const {messageFor,messageOrFallback}=messages();
  for(const [code,text] of Object.entries(INCOMPLETE)){
    assert.equal(messageFor(code),`${text}（代碼：${code}）`,code);
    assert.equal(messageOrFallback(code),`${text}（代碼：${code}）`,code);
  }
});

test('R16 M1 other native texts are unchanged',()=>{
  const {messageFor}=messages();
  assert.equal(messageFor('GROK_NATIVE_CANCELLED'),'Grok 這一回合已停止。（代碼：GROK_NATIVE_CANCELLED）');
  assert.equal(messageFor('CLAUDE_NATIVE_CANCELLED'),'Claude 這一回合已停止。（代碼：CLAUDE_NATIVE_CANCELLED）');
  assert.equal(messageFor('GROK_NATIVE_REMOTE_ERROR'),'Grok 服務端回報錯誤，這一回合已停止。請稍後再試。（代碼：GROK_NATIVE_REMOTE_ERROR）');
  assert.equal(messageFor('NOT_A_NATIVE_CODE'),null);
});

test('R16 M1 a turn.failed INCOMPLETE renders the new text and keeps its code',()=>{
  for(const [code,text] of Object.entries(INCOMPLETE))for(const ai of ['codex','grok']){
    const done=parse(ai,{type:'turn.failed',error:{message:code}}).filter(e=>e.kind==='done');
    assert.equal(done.length,1);assert.equal(done[0].error,`${text}（代碼：${code}）`);assert.equal(done[0].code,code);
  }
});

// ---- chat.parse of hub.tool_declined ----

test('R16 chat.parse turns hub.tool_declined into a NATIVE_TOOL_DECLINED notice',()=>{
  const {toolDeclinedText}=messages();
  const expected={declined:DECLINED,expired:EXPIRED,cancelled:CANCELLED};
  // Native bridges are parsed through the normalized (codex) path.
  for(const ai of ['codex','grok'])for(const reason of ['declined','expired','cancelled']){
    const title='Write D:\\outside\\x.txt';
    const events=parse(ai,{type:'hub.tool_declined',title,reason});
    const notices=events.filter(e=>e.kind==='notice');
    assert.deepEqual(notices,[{kind:'notice',code:'NATIVE_TOOL_DECLINED',text:expected[reason](title)}],ai+' '+reason);
    assert.equal(notices[0].text,toolDeclinedText(reason,title));
    assert.equal(events.some(e=>e.kind==='done'),false,'a notice never ends the turn');
    assert.equal(events.some(e=>e.kind==='text'||e.kind==='textSnapshot'),false,'a notice is not part of the reply');
  }
});

test('R16 chat.parse ignores malformed hub.tool_declined rows',()=>{
  for(const row of [
    {type:'hub.tool_declined',title:'x',reason:'denied'},
    {type:'hub.tool_declined',title:'x',reason:''},
    {type:'hub.tool_declined',title:'x'},
    {type:'hub.tool_declined',title:42,reason:'declined'},
    {type:'hub.tool_declined',title:null,reason:'declined'},
    {type:'hub.tool_declined',reason:'declined'}
  ]){
    assert.equal(parse('codex',row).some(e=>e.kind==='notice'),false,JSON.stringify(row));
  }
});
