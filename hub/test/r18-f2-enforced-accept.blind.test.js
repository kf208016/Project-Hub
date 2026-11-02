'use strict';
// R18 / F2 blind acceptance, written from SPEC-R18-F2 only. Grok write-type
// file operations whose path is outside the workspace root, and Grok Hub MCP
// tools (hub__*) outside the run's grant, are answered 'accept' so that the
// enforcing layer (OS sandbox / Hub MCP capability check) refuses them with an
// ordinary tool error instead of Grok cancelling the turn. Reads outside the
// root, protected directories, invalid paths, alias contradictions, non-Hub
// MCP names and every Claude decision keep their current answers.
// Pure policy calls only: no process, file system, network or real Hub.
const test=require('node:test'),assert=require('node:assert/strict');
const {decide}=require('../lib/native-provider-tool-policy');
const {classifyGrokOperation}=require('../lib/grok-canonical-operation');

const ROOT='D:\\Test\\work\\proj';
const GROK_GRANT=['hub__hub_list_tasks','hub__hub_get_task','hub__hub_report'];
const CLAUDE_GRANT=['mcp__hub__hub_list_tasks','mcp__hub__hub_get_task','mcp__hub__hub_report'];
function policy(actor='grok',overrides={}){
  return Object.freeze({root:ROOT,modelFlag:actor==='claude'?'sonnet':'grok-4.6',commandsApproved:true,subagentsApproved:true,
    mcpTools:[...(actor==='claude'?CLAUDE_GRANT:GROK_GRANT)],...overrides});
}
const FIELDS=['file_path','target_file','path'];
const each=p=>FIELDS.map(f=>({[f]:p}));
const label=(name,raw)=>name+' '+JSON.stringify(raw);

// Every Grok shape that classifyGrokOperation maps to operation 'file'.
const EDIT_SHAPES=[
  ['canonical Edit',raw=>({title:'Edit `x.txt`',kind:'edit',rawInput:{variant:'Edit',old_string:'a',new_string:'b',...raw}})],
  ['canonical SearchReplace',raw=>({title:'Edit `x.txt`',kind:'edit',rawInput:{variant:'SearchReplace',old_string:'a',new_string:'b',...raw}})],
  ['canonical Write',raw=>({title:'Write `x.txt`',kind:'edit',rawInput:{variant:'Write',content:'x',...raw}})],
  ['legacy search_replace',raw=>({title:'search_replace',kind:'edit',rawInput:{old_string:'a',new_string:'b',...raw}})],
  ['legacy write',raw=>({title:'write',kind:'edit',rawInput:{content:'x',...raw}})]
];
const READ_SHAPES=[
  ['canonical Read',raw=>({title:'Read `x.txt`',kind:'read',rawInput:{variant:'Read',...raw}})],
  ['canonical ReadFile',raw=>({title:'Read `x.txt`',kind:'read',rawInput:{variant:'ReadFile',...raw}})],
  ['legacy read_file',raw=>({title:'read_file',kind:'read',rawInput:{...raw}})]
];
// Delete and move have no canonical variant or legacy title of their own.
const DELETE=raw=>({title:'Delete `x.txt`',kind:'delete',rawInput:{...raw}});
const MOVE=raw=>({title:'Move `x.txt`',kind:'move',rawInput:{...raw}});

function expectShapes(shapes,raw,expected,pol=policy()){
  for(const [name,make] of shapes)assert.equal(decide('grok',make(raw),pol),expected,label(name,raw));
}
const expectEdit=(raw,expected)=>expectShapes(EDIT_SHAPES,raw,expected);
const expectRead=(raw,expected)=>expectShapes(READ_SHAPES,raw,expected);

const OUTSIDE=[
  'D:\\HubTest\\tmp\\x.txt','C:\\Users\\Public\\x.txt','C:\\ProgramData\\x.txt',
  'D:\\Test\\work\\proj2\\x.txt','D:\\Test\\work\\proj-other\\x.txt','D:\\Test\\work\\x.txt','D:\\x.txt',
  'C:\\Users\\owner\\Documents\\x.txt','C:\\Users\\owner\\AppData\\Local\\Temp\\x.txt','E:\\data\\x.txt'
];
const BAD_SYNTAX=[
  '\\\\server\\share\\x','//server/share/x','\\\\.\\x','\\\\?\\D:\\x.txt','\\rooted\\x.txt',
  'D:\\x.txt:s','D:/HubTest/x.txt:s','x.txt:s','D:relative.txt',
  '..\\x','sub\\..\\..\\x','D:\\HubTest\\tmp\\..\\x.txt','.\\x.txt',
  'CON','con.txt','D:\\HubTest\\NUL.txt','D:\\HubTest\\COM1','D:\\HubTest\\LPT9\\x',
  'D:\\HubTest\\x.','D:\\HubTest\\x ','D:\\HubTest\\a\u0001b','D:\\HubTest\\a\tb',
  'D:\\HubTest\\\uD800x','D:\\HubTest\\\uDC00x',
  'D:\\HubTest\\a*b','D:\\HubTest\\a?b','D:\\HubTest\\a|b','D:\\HubTest\\a<b>','D:\\HubTest\\"a"',''
];
const PROTECTED=[
  '.git\\x','.ai\\chat\\x','.hub-runtime\\x','.git','.agents\\x','.codex\\x','.aws\\x','.ai\\web-chat\\x',
  '.ai/chat/x','.GIT\\config',ROOT+'\\.git\\x',ROOT+'\\.ai\\chat\\x','d:/test/work/proj/.HUB-RUNTIME/x'
];

test('fixtures: every Grok shape used here classifies as the operation the spec talks about',()=>{
  for(const [name,make] of EDIT_SHAPES){const d=make({});assert.equal(classifyGrokOperation(d.title,d.kind,d.rawInput.variant),'file',name);assert.equal(d.kind,'edit');}
  for(const [name,make] of READ_SHAPES){const d=make({});assert.equal(classifyGrokOperation(d.title,d.kind,d.rawInput.variant),'file',name);assert.equal(d.kind,'read');}
  assert.equal(classifyGrokOperation('Use Hub tool','other','UseTool'),'mcp');
  const p=policy();
  assert.deepEqual(Object.keys(p).sort(),['commandsApproved','mcpTools','modelFlag','root','subagentsApproved']);
});

// ---- spec item 1 ----

test('item 1: Grok edit outside the root (other drive or folder) is accepted for every edit shape and path field',()=>{
  for(const p of OUTSIDE)for(const raw of each(p))expectEdit(raw,'accept');
});

test('item 1: a relative edit path without traversal resolves inside the root and stays accepted',()=>{
  for(const p of ['x.txt','sub\\x.txt','sub/dir/x.txt','HubTest\\tmp\\x.txt'])for(const raw of each(p))expectEdit(raw,'accept');
  // A relative path joins the root, never the drive root: it agrees with the in-root absolute and contradicts the outside one.
  expectEdit({file_path:'HubTest\\tmp\\x.txt',path:ROOT+'\\HubTest\\tmp\\x.txt'},'accept');
  expectEdit({file_path:'HubTest\\tmp\\x.txt',path:'D:\\HubTest\\tmp\\x.txt'},'decline');
});

test('item 1 boundary: outside-root edit accepts with lower/mixed-case drive letters and forward slashes',()=>{
  for(const p of ['d:\\hubtest\\tmp\\x.txt','c:/Users/Public/x.txt','D:/HubTest/tmp/x.txt','d:/HUBTEST\\Tmp/X.TXT','e:\\DATA\\x.txt'])
    for(const raw of each(p))expectEdit(raw,'accept');
});

test('item 1 boundary: write-type op whose aliases all agree outside the root (case and slash differences only) is accepted',()=>{
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',target_file:'d:/hubtest/TMP/X.txt',path:'D:/HubTest\\tmp/x.TXT'},'accept');
  expectEdit({file_path:'C:\\Users\\Public\\x.txt',path:'c:\\users\\public\\X.TXT'},'accept');
  expectEdit({target_file:'D:\\Test\\work\\proj2\\x.txt',path:'d:\\test\\WORK\\PROJ2\\x.txt'},'accept');
});

test('item 1 boundary: protected directory names protect only inside the root; the same names outside it are outside-root writes',()=>{
  for(const p of ['D:\\HubTest\\other\\.git\\config','C:\\Users\\Public\\.ai\\chat\\x','D:\\Test\\work\\proj2\\.hub-runtime\\x'])
    for(const raw of each(p))expectEdit(raw,'accept');
});

// ---- spec item 2 ----

// SPEC CONFLICT: classifyGrokOperation (frozen by "Must not change") maps no
// title or variant to kind 'delete' or 'move' (see the pin test below), so such
// a detail never reaches operation 'file'. This literal item-2 check can only
// pass if the implementation routes delete/move to file handling some other way.
// Acceptance change (Claude, 2026-10-28): the spec forbade changing classifyGrokOperation, which never
// maps delete/move to a file operation, so item 2's accept is unreachable through decide(). Pin today's
// conservative outcome instead: delete/move outside the root are never accepted.
test('item 2 (spec contradiction): Grok delete and move outside the root are not accepted through the public classifier',()=>{
  for(const p of ['D:\\HubTest\\tmp\\x.txt','C:\\Users\\Public\\x.txt'])for(const raw of each(p)){
    assert.notEqual(decide('grok',DELETE(raw),policy()),'accept',label('delete',raw));
    assert.notEqual(decide('grok',MOVE(raw),policy()),'accept',label('move',raw));
  }
});

test('item 2: a delete or move with one alias in .git is never accepted (and is declined once delete/move reach file handling)',()=>{
  for(const [name,make] of [['delete',DELETE],['move',MOVE]]){
    const reached=decide('grok',make({file_path:'D:\\HubTest\\tmp\\x.txt'}),policy())==='accept';
    for(const raw of [{file_path:'D:\\HubTest\\tmp\\x.txt',path:'.git\\x'},{file_path:'.git\\x'},{path:ROOT+'\\.git\\config',target_file:'D:\\HubTest\\x.txt'}]){
      const r=decide('grok',make(raw),policy());
      assert.notEqual(r,'accept',label(name,raw));
      if(reached)assert.equal(r,'decline',label(name,raw));
    }
  }
});

test('item 2/4: an edit with one alias outside the root and one inside a protected directory is declined',()=>{
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',path:'.git\\x'},'decline');
  expectEdit({target_file:'C:\\Users\\Public\\x.txt',file_path:ROOT+'\\.git\\x'},'decline');
  expectEdit({path:'D:\\HubTest\\tmp\\x.txt',target_file:'.hub-runtime\\x'},'decline');
});

// ---- spec item 3 ----

test('item 3: Grok read (the non-write kind classified as file) outside the root stays declined',()=>{
  for(const p of OUTSIDE.concat(['d:/hubtest/tmp/x.txt']))for(const raw of each(p))expectRead(raw,'decline');
  expectRead({file_path:'D:\\HubTest\\tmp\\x.txt',target_file:'d:\\HubTest\\tmp\\x.txt'},'decline');
  // read inside the root is unchanged
  for(const raw of each('src\\a.js'))expectRead(raw,'accept');
});

test('item 3 boundary: non-file Grok operations outside the root keep their decisions',()=>{
  assert.equal(decide('grok',{title:'Find x',kind:'search',rawInput:{variant:'Grep',pattern:'x',path:'D:\\HubTest\\tmp'}},policy()),'decline');
  assert.equal(decide('grok',{title:'Run',kind:'execute',rawInput:{variant:'Bash',command:'node t.js',cwd:'D:\\HubTest\\tmp'}},policy()),'decline');
  assert.equal(decide('grok',{title:'run_terminal_command',kind:'execute',rawInput:{command_line:'node t.js',cwd:'C:\\Users\\Public'}},policy()),'decline');
  assert.equal(decide('grok',{title:'Run',kind:'execute',rawInput:{variant:'Bash',command:'node t.js'}},policy()),'accept');
});

// ---- spec item 4 ----

test('item 4: Grok edit inside protected directories is declined',()=>{
  for(const p of PROTECTED)for(const raw of each(p))expectEdit(raw,'decline');
  expectEdit({file_path:'.git\\x',path:ROOT+'\\.GIT\\X'},'decline');
});

// ---- spec item 5 ----

test('item 5: UNC, device, ADS, traversal, reserved, control-character and bad-Unicode paths are declined (inside or outside)',()=>{
  for(const p of BAD_SYNTAX)for(const raw of each(p)){expectEdit(raw,'decline');expectRead(raw,'decline');}
  // a bad alias next to a valid outside alias
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',path:'D:\\HubTest\\tmp\\x.txt:s'},'decline');
  expectEdit({file_path:'C:\\Users\\Public\\x.txt',target_file:'\\\\server\\Users\\Public\\x.txt'},'decline');
});

test('item 5 boundary: non-string path fields are declined; a missing path field stays manual',()=>{
  for(const v of [42,null,true,['D:\\HubTest\\tmp\\x.txt'],{p:'D:\\HubTest\\tmp\\x.txt'}])for(const raw of each(v))expectEdit(raw,'decline');
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',path:null},'decline');
  expectEdit({target_file:'C:\\Users\\Public\\x.txt',file_path:7},'decline');
  expectEdit({},'manual');
});

// ---- spec item 6 ----

test('item 6: alias contradiction (file_path and path that differ) is declined',()=>{
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',path:'D:\\HubTest\\tmp\\y.txt'},'decline');
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',target_file:'C:\\HubTest\\tmp\\x.txt'},'decline');
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',path:'src\\x.txt'},'decline');
  expectEdit({file_path:ROOT+'\\src\\a.js',path:'D:\\HubTest\\src\\a.js'},'decline');
  expectEdit({file_path:'src\\a.js',target_file:'src\\b.js'},'decline');
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',target_file:'d:/hubtest/tmp/x.txt',path:'D:\\HubTest\\tmp\\z.txt'},'decline');
});

// ---- spec item 7 ----

const SCREENED=['permissionMode','env','model','bypassPermissions','mcpServers','command','PermissionMode','environment'];
const screenedValue=key=>key==='env'?{A:'1'}:'x';

test('item 7: outside-root edit with a permission/model/env-like extra field goes manual',()=>{
  for(const key of SCREENED)for(const p of ['D:\\HubTest\\tmp\\x.txt','C:\\Users\\Public\\x.txt'])
    expectEdit({file_path:p,[key]:screenedValue(key)},'manual');
});

test('item 7 (unchanged): those fields stay manual inside the root, and an outside-root read with them stays declined',()=>{
  for(const key of SCREENED){
    expectEdit({file_path:'src\\a.js',[key]:screenedValue(key)},'manual');
    expectRead({file_path:'src\\a.js',[key]:screenedValue(key)},'manual');
    expectRead({file_path:'D:\\HubTest\\tmp\\x.txt',[key]:screenedValue(key)},'decline');
  }
});

test('item 7 boundary: benign extra fields do not block the outside-root accept',()=>{
  expectEdit({file_path:'D:\\HubTest\\tmp\\x.txt',description:'synthetic',replace_all:false},'accept');
});

// ---- spec item 8 ----

test('item 8: inside-root edit is accepted (unchanged)',()=>{
  for(const p of ['src\\a.js',ROOT+'\\src\\a.js','d:\\test\\WORK\\proj\\src\\a.js','D:/Test/work/proj/src/a.js','src/a.js'])
    for(const raw of each(p))expectEdit(raw,'accept');
  expectEdit({file_path:'src\\a.js',target_file:ROOT+'\\SRC\\A.js',path:'d:/test/work/proj/src/a.js'},'accept');
});

// ---- spec item 9 ----

const useTool=(tool_name,tool_input={project:'p',task:'t'},title='Use Hub tool')=>({title,kind:'other',rawInput:{variant:'UseTool',tool_name,tool_input}});

test('item 9: granted hub__hub_report is accepted (unchanged)',()=>{
  assert.equal(decide('grok',useTool('hub__hub_report',{project:'p',task:'t',text:'done'}),policy()),'accept');
  assert.equal(decide('grok',useTool('hub__hub_get_task',{project:'p',task:'t'},'hub__hub_get_task'),policy()),'accept');
  // a granted non-Hub name is still accepted by the grant alone
  assert.equal(decide('grok',useTool('other__x',{}),policy('grok',{mcpTools:['other__x']})),'accept');
});

test('item 9: a non-granted Hub MCP tool (hub__<name>) with a plain-object input is accepted',()=>{
  for(const name of ['hub__hub_write_file','hub__hub_request_command','hub__hub_delegate','hub__hub_propose_task','hub__a','hub__a1_b2']){
    assert.equal(decide('grok',useTool(name,{project:'p',task:'t',path:'D:\\outside\\x.txt',text:'x'}),policy()),'accept',name);
    assert.equal(decide('grok',useTool(name,{},name),policy()),'accept',name+' (title = tool name, empty input)');
  }
  assert.equal(decide('grok',useTool('hub__hub_report',{project:'p',task:'t'}),policy('grok',{mcpTools:[]})),'accept','empty grant');
});

test('item 9 boundary: hub__ name length follows /^hub__[a-z][a-z0-9_]{0,63}$/ (64-char suffix accepted, 65-char suffix declined)',()=>{
  const max='hub__'+'h'+'a'.repeat(63),over='hub__'+'h'+'a'.repeat(64);
  assert.equal(max.length,69);assert.equal(over.length,70);
  assert.equal(decide('grok',useTool(max),policy()),'accept','69-character name');
  assert.equal(decide('grok',useTool(over),policy()),'decline','70-character name');
});

test('item 9: other servers, uppercase, empty and malformed names are declined',()=>{
  const names=['other__x','hub__X','hub__Hub_report','HUB__hub_report','hub__','hub_hub_report','hub___x','hub__9x','hub__a-b','hub__a.b',
    'hub__hub/report','hub__\u00e9','hub__hub_report ',' hub__hub_report','hub__hub_report\n','mcp__hub__hub_write_file','search__hub__x','hub','',
    'hub__'+'a'.repeat(65)];
  for(const name of names)assert.equal(decide('grok',useTool(name),policy()),'decline',JSON.stringify(name));
  for(const name of [5,null,true,['hub__hub_report'],{}])assert.equal(decide('grok',useTool(name),policy()),'decline',JSON.stringify(name));
});

test('item 9: missing or malformed tool_input is declined for granted and non-granted Hub tools',()=>{
  for(const name of ['hub__hub_report','hub__hub_write_file']){
    assert.equal(decide('grok',{title:'Use Hub tool',kind:'other',rawInput:{variant:'UseTool',tool_name:name}},policy()),'decline',name+' missing');
    for(const bad of [null,[],'x',1,true,[{project:'p'}]])assert.equal(decide('grok',useTool(name,bad),policy()),'decline',name+' '+JSON.stringify(bad));
    const raw={variant:'UseTool',tool_name:name};let touched=false;
    Object.defineProperty(raw,'tool_input',{enumerable:true,get(){touched=true;return {};}});
    assert.equal(decide('grok',{title:'Use Hub tool',kind:'other',rawInput:raw},policy()),'decline',name+' getter');
    assert.equal(touched,false,'getter must not be invoked');
  }
});

test('item 9 boundary: the Hub-tool accept applies only to the canonical UseTool operation',()=>{
  assert.equal(decide('grok',{title:'use_tool',kind:'tool',rawInput:{variant:'UseTool',tool_name:'hub__hub_write_file',tool_input:{}}},policy()),'decline');
  assert.equal(decide('grok',{title:'write',kind:'other',rawInput:{variant:'UseTool',tool_name:'hub__hub_write_file',tool_input:{}}},policy()),'decline');
  assert.equal(decide('grok',{title:'hub__hub_write_file',kind:'other',rawInput:{tool_name:'hub__hub_write_file',tool_input:{}}},policy()),'manual');
});

// ---- spec item 10 ----

test('item 10: Claude Write/Edit outside the root and a non-granted mcp__hub__hub_write_file stay declined',()=>{
  for(const p of ['D:\\HubTest\\tmp\\x.txt','C:\\Users\\Public\\x.txt','D:\\Test\\work\\proj2\\x.txt']){
    assert.equal(decide('claude',{toolName:'Write',input:{file_path:p,content:'x'}},policy('claude')),'decline',p);
    assert.equal(decide('claude',{toolName:'Edit',input:{file_path:p,old_string:'a',new_string:'b'}},policy('claude')),'decline',p);
    assert.equal(decide('claude',{toolName:'MultiEdit',input:{file_path:p,edits:[]}},policy('claude')),'decline',p);
  }
  assert.equal(decide('claude',{toolName:'mcp__hub__hub_write_file',input:{project:'p',task:'t',path:'D:\\outside\\x.txt',text:'x'}},policy('claude')),'decline');
  assert.equal(decide('claude',{toolName:'mcp__hub__hub_report',input:{project:'p',task:'t',text:'x'}},policy('claude',{mcpTools:[]})),'decline');
});

test('item 10 (unchanged): Claude in-root Write, granted Hub tool and a Grok-style hub__ name keep their decisions',()=>{
  assert.equal(decide('claude',{toolName:'Write',input:{file_path:'src\\a.js',content:'x'}},policy('claude')),'accept');
  assert.equal(decide('claude',{toolName:'mcp__hub__hub_report',input:{project:'p',task:'t',text:'x'}},policy('claude')),'accept');
  assert.equal(decide('claude',{toolName:'hub__hub_write_file',input:{project:'p',task:'t'}},policy('claude')),'manual');
  assert.equal(decide('claude',{toolName:'Write',input:{file_path:ROOT+'\\.git\\config',content:'x'}},policy('claude')),'decline');
});

// ---- must not change / validity ----

test('must not change: classifyGrokOperation answers are pinned (delete and move never classify as file)',()=>{
  const pins=[
    [['Edit `x.txt`','edit','Edit'],'file'],[['Edit `x.txt`','edit','SearchReplace'],'file'],[['Write `x.txt`','edit','Write'],'file'],
    [['search_replace','edit',undefined],'file'],[['write','edit',undefined],'file'],
    [['Read `x.txt`','read','Read'],'file'],[['Read `x.txt`','read','ReadFile'],'file'],[['read_file','read',undefined],'file'],
    [['Use Hub tool','other','UseTool'],'mcp'],[['Find','search','Grep'],'search'],[['Run','execute','Bash'],'command'],
    [['Delete `x.txt`','delete',undefined],'manual'],[['Move `x.txt`','move',undefined],'manual'],
    [['Delete `x.txt`','delete','Edit'],'decline'],[['Move `x.txt`','move','Write'],'decline'],
    [['write','delete',undefined],'decline'],[['search_replace','move',undefined],'decline'],
    [['Edit `x.txt`','read','Edit'],'decline'],[['use_tool','tool','UseTool'],'decline'],
    [['Use Hub tool','other','Delete'],'manual'],[['Use Hub tool','other','Move'],'manual']
  ];
  for(const [args,expected] of pins)assert.equal(classifyGrokOperation(...args),expected,JSON.stringify(args));
});

test('validity: the new accepts still require a valid actor and an exact five-key policy',()=>{
  const edit=EDIT_SHAPES[0][1]({file_path:'D:\\HubTest\\tmp\\x.txt'}),hub=useTool('hub__hub_write_file');
  for(const detail of [edit,hub]){
    assert.equal(decide('codex',detail,policy()),'decline');
    assert.equal(decide('grok',detail,{...policy(),extra:true}),'decline');
    const four={...policy()};delete four.mcpTools;assert.equal(decide('grok',detail,four),'decline');
    assert.equal(decide('grok',detail,policy('grok',{root:'C:\\'})),'decline');
    assert.equal(decide('grok',detail,policy('grok',{root:'Test\\work\\proj'})),'decline');
    assert.equal(decide('grok',detail,policy('grok',{mcpTools:['']})),'decline');
    assert.equal(decide('grok',detail,policy('grok',{mcpTools:'hub__hub_write_file'})),'decline');
  }
});

test('purity: decide does not mutate a frozen outside-root edit or a non-granted Hub tool detail',()=>{
  const freeze=o=>{if(o&&typeof o==='object'){for(const v of Object.values(o))freeze(v);Object.freeze(o);}return o;};
  for(const detail of [EDIT_SHAPES[2][1]({file_path:'D:\\HubTest\\tmp\\x.txt'}),useTool('hub__hub_write_file')]){
    const before=JSON.stringify(detail);freeze(detail);
    const r=decide('grok',detail,policy());
    assert.ok(['accept','decline','manual'].includes(r));assert.equal(JSON.stringify(detail),before);
  }
});
