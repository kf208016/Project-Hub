'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../lib/native-provider-tool-policy');

const ROOT = 'C:\\Users\\user\\project';

test('official Grok Bash serialized default fields preserve general-command consent and bounds',()=>{
  const detail={title:'Run synthetic arithmetic',kind:'execute',rawInput:{variant:'Bash',command:'node test.cjs',description:'synthetic',is_background:false}};
  assert.equal(decide('grok',detail,basePolicy()),'accept');
  for(const timeout of [1,600000])for(const block_until_ms of [0,600000]){
    assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,timeout,block_until_ms}},basePolicy()),'accept');
  }
  assert.equal(decide('grok',detail,basePolicy({commandsApproved:false})),'decline');
  assert.equal(decide('grok',{...detail,kind:'other'},basePolicy()),'decline');
  assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,cwd:'C:\\outside'}},basePolicy()),'decline');
  assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,command:'type auth.json'}},basePolicy()),'manual');
  for(const [key,values]of [['timeout',[null,0,-1,600001,'100']],['block_until_ms',[null,-1,600001,'100']],['is_background',[null,'false',0]],['env',[{}]],['unknown_field',[false]]]){
    for(const value of values)assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,[key]:value}},basePolicy()),'manual');
  }
  assert.equal(decide('claude',{toolName:'Bash',input:{command:'node test.cjs',is_background:false}},basePolicy()),'manual');
});

test('canonical Grok Grep null optional path means approved workspace without mutation or path bypass',()=>{
  const detail={title:'Find synthetic arithmetic',kind:'search',rawInput:{variant:'Grep',pattern:'add',path:null}};
  const before=JSON.stringify(detail);
  assert.equal(decide('grok',detail,basePolicy()),'accept');assert.equal(JSON.stringify(detail),before);
  for(const path of ['..\\outside','.git','C:\\outside']){
    assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,path}},basePolicy()),'decline');
  }
  assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,command:'anything'}},basePolicy()),'manual');
  assert.equal(decide('claude',{toolName:'Grep',input:{pattern:'add',path:null}},basePolicy()),'decline');
});

test('official Grok canonical edit and write still enforce exact aliases and protected paths',()=>{
  for(const variant of ['SearchReplace','Write']){
    const detail={title:'Edit `add.cjs`',kind:'edit',rawInput:{variant,file_path:'add.cjs',old_string:'a-b',new_string:'a+b'}};
    assert.equal(decide('grok',detail,basePolicy()),'accept');
    for(const file_path of ['..\\outside.cjs','.git\\config','.ai\\chat\\history.jsonl','C:\\outside.cjs']){
      assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,file_path}},basePolicy()),'decline');
    }
    assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,path:'different.cjs'}},basePolicy()),'decline');
    assert.equal(decide('grok',{...detail,kind:'read'},basePolicy()),'decline');
  }
});

test('canonical Grok Task with human description keeps original model and delegation permission checks',()=>{
  const detail={title:'Check synthetic arithmetic',kind:'other',rawInput:{variant:'Task',prompt:'Run synthetic tests',model:'inherit',run_in_background:false}};
  assert.equal(decide('grok',detail,basePolicy()),'accept');
  assert.equal(decide('grok',detail,basePolicy({subagentsApproved:false})),'decline');
  assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,model:'unapproved-model'}},basePolicy()),'manual');
  assert.equal(decide('grok',{...detail,rawInput:{...detail.rawInput,permissions:{allow:['*']}}},basePolicy()),'manual');
});

test('canonical Grok operation names cannot bypass command, MCP or unknown lifecycle guards',()=>{
  const command={title:'Run synthetic test',kind:'execute',rawInput:{variant:'Bash',command:'node test.cjs'}};
  assert.equal(decide('grok',command,basePolicy()),'accept');
  assert.equal(decide('grok',command,basePolicy({commandsApproved:false})),'decline');
  assert.equal(decide('grok',{title:'Registered MCP',kind:'other',rawInput:{variant:'UseTool',tool_name:'unregistered__tool',tool_input:{}}},basePolicy()),'manual');
  for(const variant of ['TaskOutput','WaitTasks','KillTask','Dynamic']){
    assert.equal(decide('grok',{title:'write',kind:'edit',rawInput:{variant,file_path:'add.cjs'}},basePolicy()),'manual');
  }
});

test('non-ACP legacy kind labels do not grant tool or agent authority',()=>{
  assert.equal(decide('grok',{title:'use_tool',kind:'tool',rawInput:{variant:'UseTool',tool_name:'mcp__search__web',tool_input:{}}},basePolicy()),'decline');
  assert.equal(decide('grok',{title:'spawn_subagent',kind:'agent',rawInput:{prompt:'work'}},basePolicy()),'decline');
  assert.equal(decide('grok',{title:'search_tool',kind:'search',rawInput:{query:'lookup'}},basePolicy()),'decline');
});

function basePolicy(overrides) {
  const p = {
    root: ROOT,
    modelFlag: 'claude-sonnet-5',
    commandsApproved: true,
    subagentsApproved: true,
    mcpTools: ['mcp__filesystem__list', 'mcp__search__web']
  };
  return Object.freeze(Object.assign(p, overrides));
}

test('accepts exact-path Read within root', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\src\\a.js' } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('accepts relative path under root for Write', () => {
  const detail = { toolName: 'Write', input: { file_path: 'src\\b.js', content: 'x' } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('declines relative traversal even if staying under root', () => {
  const detail = { toolName: 'Read', input: { file_path: 'src\\..\\src\\a.js' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('declines path outside root', () => {
  const detail = { toolName: 'Read', input: { file_path: 'C:\\Windows\\system.ini' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('declines UNC path', () => {
  const detail = { toolName: 'Read', input: { file_path: '\\\\server\\share\\file.txt' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('declines ADS-style path', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\a.js:stream' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('declines reserved device name', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\CON' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('declines trailing dot path', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\file.txt.' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('declines protected .git path', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\.git\\config' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('Grok file op with matching aliases accepts', () => {
  const detail = {
    title: 'read_file',
    kind: 'read',
    rawInput: { file_path: 'src\\a.js', target_file: ROOT + '\\src\\a.js' }
  };
  assert.equal(decide('grok', detail, basePolicy()), 'accept');
});

test('Grok file op with contradictory aliases declines', () => {
  const detail = {
    title: 'read_file',
    kind: 'read',
    rawInput: { file_path: 'src\\a.js', target_file: ROOT + '\\src\\b.js' }
  };
  assert.equal(decide('grok', detail, basePolicy()), 'decline');
});

test('malicious getter on input is never invoked, declines', () => {
  let invoked = false;
  const input = {};
  Object.defineProperty(input, 'file_path', {
    enumerable: true,
    get() { invoked = true; return ROOT + '\\a.js'; }
  });
  const detail = { toolName: 'Read', input };
  const result = decide('claude', detail, basePolicy());
  assert.equal(invoked, false);
  assert.equal(result, 'decline');
});

test('malicious getter on detail declines without invocation', () => {
  let invoked = false;
  const detail = {};
  Object.defineProperty(detail, 'toolName', { enumerable: true, get() { invoked = true; return 'Read'; } });
  Object.defineProperty(detail, 'input', { enumerable: true, value: { file_path: ROOT + '\\a.js' }, writable: false, configurable: false });
  const result = decide('claude', detail, basePolicy());
  assert.equal(invoked, false);
  assert.equal(result, 'decline');
});

test('malformed types decline (toolName number)', () => {
  const detail = { toolName: 123, input: {} };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('unknown MCP tool manual', () => {
  const detail = { toolName: 'mcp__unknown__thing', input: {} };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('exact fixed MCP tool accepts', () => {
  const detail = { toolName: 'mcp__filesystem__list', input: { query: 'x' } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('Grok UseTool exact allowlisted tool accepts', () => {
  const detail = {
    title: 'use_tool',
    kind: 'other',
    rawInput: { variant: 'UseTool', tool_name: 'mcp__search__web', tool_input: { q: 'hi' } }
  };
  assert.equal(decide('grok', detail, basePolicy()), 'accept');
});

test('Grok UseTool unknown tool manual', () => {
  const detail = {
    title: 'use_tool',
    kind: 'other',
    rawInput: { variant: 'UseTool', tool_name: 'mcp__other__x', tool_input: {} }
  };
  assert.equal(decide('grok', detail, basePolicy()), 'manual');
});

test('Grok search_tool title accepts as inert lookup', () => {
  const detail = { title: 'search_tool', kind: 'other', rawInput: { query: 'foo' } };
  assert.equal(decide('grok', detail, basePolicy()), 'accept');
});

test('Grok search_tool with embedded command field is manual', () => {
  const detail = { title: 'search_tool', kind: 'other', rawInput: { query: 'foo', command: 'ls' } };
  assert.equal(decide('grok', detail, basePolicy()), 'manual');
});

test('arbitrary approved command accepts with explicit consent', () => {
  const detail = { toolName: 'Bash', input: { command: 'npm test' } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('command declines when commandsApproved false', () => {
  const detail = { toolName: 'Bash', input: { command: 'npm test' } };
  assert.equal(decide('claude', detail, basePolicy({ commandsApproved: false })), 'decline');
});

test('command referencing credential file goes manual', () => {
  const detail = { toolName: 'Bash', input: { command: 'cat .credentials.json' } };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('command referencing another CLI executable goes manual', () => {
  const detail = { toolName: 'Bash', input: { command: 'claude --dangerously-skip-permissions' } };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('command with permission bypass phrase goes manual', () => {
  const detail = { toolName: 'Bash', input: { command: 'run --bypass-permissions now' } };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('Grok run_terminal_command with cwd inside root accepts', () => {
  const detail = {
    title: 'run_terminal_command',
    kind: 'execute',
    rawInput: { command_line: 'echo hi', cwd: ROOT }
  };
  assert.equal(decide('grok', detail, basePolicy()), 'accept');
});

test('Grok run_terminal_command with cwd outside root declines', () => {
  const detail = {
    title: 'run_terminal_command',
    kind: 'execute',
    rawInput: { command_line: 'echo hi', cwd: 'C:\\Other' }
  };
  assert.equal(decide('grok', detail, basePolicy()), 'decline');
});

test('command with extra permissions field goes manual', () => {
  const detail = { toolName: 'Bash', input: { command: 'npm test', permissions: { bypass: true } } };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('subagent with inherited model accepts', () => {
  const detail = { toolName: 'Task', input: { prompt: 'do work', model: 'inherit' } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('subagent with exact modelFlag accepts', () => {
  const detail = { toolName: 'Task', input: { prompt: 'do work', model: 'claude-sonnet-5' } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('subagent with different model is manual', () => {
  const detail = { toolName: 'Task', input: { prompt: 'do work', model: 'claude-opus-9' } };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('subagent declines when subagentsApproved false', () => {
  const detail = { toolName: 'Task', input: { prompt: 'do work' } };
  assert.equal(decide('claude', detail, basePolicy({ subagentsApproved: false })), 'decline');
});

test('subagent with permissions field is manual', () => {
  const detail = { toolName: 'Agent', input: { prompt: 'do work', permissions: { allow: ['*'] } } };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('subagent missing prompt/task declines', () => {
  const detail = { toolName: 'Task', input: { model: 'inherit' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('Grok spawn_subagent bounded task accepts', () => {
  const detail = { title: 'spawn_subagent', kind: 'other', rawInput: { task: 'build feature', model: 'inherit' } };
  assert.equal(decide('grok', detail, basePolicy()), 'accept');
});

test('Glob/Grep search within root accepts', () => {
  const detail = { toolName: 'Grep', input: { pattern: 'foo', path: ROOT + '\\src' } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('Grep path outside root declines', () => {
  const detail = { toolName: 'Grep', input: { pattern: 'foo', path: 'C:\\Windows' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('Grep targeting protected dir declines', () => {
  const detail = { toolName: 'Grep', input: { pattern: 'foo', path: ROOT + '\\.aws' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('TodoWrite bookkeeping accepts', () => {
  const detail = { toolName: 'TodoWrite', input: { todos: [{ id: 1, text: 'task', done: false }] } };
  assert.equal(decide('claude', detail, basePolicy()), 'accept');
});

test('unknown tool name is manual', () => {
  const detail = { toolName: 'SomeFutureTool', input: {} };
  assert.equal(decide('claude', detail, basePolicy()), 'manual');
});

test('wrong policy shape declines', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\a.js' } };
  assert.equal(decide('claude', detail, { root: ROOT }), 'decline');
});

test('unrecognized actor declines', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\a.js' } };
  assert.equal(decide('codex', detail, basePolicy()), 'decline');
});

test('cyclic input declines (symbol undetectable via JSON domain guard)', () => {
  const input = { file_path: ROOT + '\\a.js' };
  input.self = input;
  const detail = { toolName: 'Read', input };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('nonplain prototype object declines', () => {
  class Foo { constructor() { this.file_path = ROOT + '\\a.js'; } }
  const detail = { toolName: 'Read', input: new Foo() };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('NUL byte in string declines', () => {
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\a\u0000.js' } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('nonfinite number declines', () => {
  const detail = { toolName: 'Grep', input: { pattern: 'x', limit: Infinity } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('policy object is frozen and not mutated by decide', () => {
  const policy = basePolicy();
  const snapshot = JSON.stringify(policy);
  const detail = { toolName: 'Read', input: { file_path: ROOT + '\\a.js' } };
  decide('claude', detail, policy);
  assert.equal(JSON.stringify(policy), snapshot);
  assert.throws(() => { policy.root = 'X'; });
});

test('input object is not mutated by decide', () => {
  const input = { file_path: ROOT + '\\a.js' };
  const snapshot = JSON.stringify(input);
  const detail = { toolName: 'Read', input };
  decide('claude', detail, basePolicy());
  assert.equal(JSON.stringify(input), snapshot);
});

test('magic key __proto__ declines', () => {
  const input = JSON.parse('{"file_path": "' + ROOT.replace(/\\/g, '\\\\') + '\\\\a.js", "__proto__": {"x":1}}');
  const detail = { toolName: 'Read', input };
  // Note: JSON.parse with __proto__ key sets own enumerable prop in modern engines is inconsistent;
  // directly construct via defineProperty to guarantee own enumerable key named __proto__.
  const unsafe = Object.defineProperty({}, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
  unsafe.file_path = ROOT + '\\a.js';
  const detail2 = { toolName: 'Read', input: unsafe };
  assert.equal(decide('claude', detail2, basePolicy()), 'decline');
});

test('oversized string content declines (byte bound)', () => {
  const big = 'a'.repeat(200000);
  const detail = { toolName: 'Write', input: { file_path: ROOT + '\\a.js', content: big } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('deep nesting beyond max depth declines', () => {
  let obj = { v: 1 };
  for (let i = 0; i < 30; i++) { obj = { nested: obj }; }
  const detail = { toolName: 'Grep', input: { pattern: 'x', extra: obj } };
  assert.equal(decide('claude', detail, basePolicy()), 'decline');
});

test('Windows root-relative paths, hidden properties and symbol arrays decline without getters',()=>{
  assert.equal(decide('claude',{toolName:'Read',input:{file_path:'\\outside.txt'}},basePolicy()),'decline');
  let called=0;const input={};Object.defineProperty(input,'file_path',{enumerable:true,get(){called++;return ROOT+'\\a.js';}});
  assert.equal(decide('claude',{toolName:'Read',input},basePolicy()),'decline');assert.equal(called,0);
  const hidden={file_path:ROOT+'\\a.js'};Object.defineProperty(hidden,'hidden',{value:true});
  assert.equal(decide('claude',{toolName:'Read',input:hidden},basePolicy()),'decline');
  const array=[];array[Symbol('hidden')]=true;
  assert.equal(decide('claude',{toolName:'Grep',input:{pattern:'x',extra:array}},basePolicy()),'decline');
});

test('general command timeout, cwd aliases and explicit secrets require refusal or owner review',()=>{
  assert.equal(decide('claude',{toolName:'Bash',input:{command:'node --version',timeout:600000}},basePolicy()),'accept');
  assert.equal(decide('claude',{toolName:'Bash',input:{command:'node --version',timeout:600001}},basePolicy()),'manual');
  assert.equal(decide('claude',{toolName:'Bash',input:{command:'type .grok/auth.json'}},basePolicy()),'manual');
});
