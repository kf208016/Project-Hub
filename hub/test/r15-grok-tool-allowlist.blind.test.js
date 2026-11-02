'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// R15 / T1 blind acceptance: process-level Grok tool allowlist (top-level --tools before `agent`).
const PROFILE_TOOLS = Object.freeze(['read_file', 'grep', 'search_replace', 'write', 'run_terminal_cmd', 'task', 'search_tool', 'use_tool']);
const COMPANIONS = Object.freeze(['get_task_output', 'wait_tasks', 'kill_task']);
const PROCESS_TOOLS = Object.freeze([
  'read_file', 'grep', 'search_replace', 'write', 'run_terminal_cmd', 'task', 'search_tool', 'use_tool',
  'get_task_output', 'wait_tasks', 'kill_task'
]);
const TOOLS_VALUE = 'read_file,grep,search_replace,write,run_terminal_cmd,task,search_tool,use_tool,get_task_output,wait_tasks,kill_task';
const FORBIDDEN = Object.freeze(['--disallowed-tools', '--no-subagents', '--always-approve', '--yolo', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);
const BYPASS = Object.freeze(['--always-approve', '--yolo', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);
// Tools a Task child received under Grok 1.0.70 / 1.0.34 that the process allowlist must not contain.
const EXTRAS = Object.freeze(['list_dir', 'todo_write', 'web_fetch', 'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor', 'workflow']);
// Same option shape as test/grok-native-bridge.test.js; synthetic values only.
const options = Object.freeze({ project: 'p', task: 't', runId: 'r', cwd: 'C:\\synthetic', model: 'grok-selected', effort: 'low', sessionId: null, resume: false, validatedMcpServers: [] });
const VARIANTS = Object.freeze([
  options,
  { ...options, model: '' },
  { ...options, effort: 'high' },
  { ...options, model: 'grok-4.7', resume: true, sessionId: 'synthetic-native-session' },
  { ...options, model: '', resume: true, sessionId: 'synthetic-native-session' },
  { ...options, validatedAgentProfile: { name: 'approved', tools: ['task'] } }
]);

function allowlist() { return require('../lib/grok-tool-allowlist'); }
function bridge() { return require('../lib/grok-native-bridge'); }
function expectedArgs(o) {
  return ['--tools', TOOLS_VALUE, 'agent', '--no-leader', ...(o.model === '' ? [] : ['--model', o.model]), '--effort', o.effort, 'stdio'];
}
// Copy of the provider-native-plan.test.js option helper (pure path strings, no I/O), for the Grok actor.
function planOptions(providerArgs) {
  return {
    actor: 'grok',
    cwd: 'C:\\Workspaces\\project',
    rootFingerprint: 'a'.repeat(64),
    ownerHome: 'C:\\Users\\example-user',
    runtimeBase: 'C:\\Users\\example-user\\AppData\\Local\\ProjectHub',
    providerFile: 'C:\\Tools\\provider\\provider.exe',
    codexFile: 'C:\\Tools\\codex\\codex.exe',
    codexSHA256: 'b'.repeat(64),
    nodeFile: 'C:\\Tools\\node\\node.exe',
    gitDirectory: 'C:\\Tools\\git',
    hubLibDirectory: 'C:\\Tools\\hublib',
    providerArgs,
    proxyUrl: 'http://hub:' + 'c'.repeat(64) + '@127.0.0.1:8080',
    systemRoot: 'C:\\Windows'
  };
}
// The two modules that build the Grok argv.
function argvSources() {
  return [path.join(__dirname, '..', 'lib', 'grok-native-bridge.js'), path.join(__dirname, '..', 'lib', 'grok-tool-allowlist.js')];
}
// Rough comment stripper: only used to ignore prose mentions of a flag; string literals are kept.
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

test('T1 grok-tool-allowlist exports exactly TASK_COMPANIONS and GROK_PROCESS_TOOLS', () => {
  const mod = allowlist();
  assert.deepEqual(Object.keys(mod).sort(), ['GROK_PROCESS_TOOLS', 'TASK_COMPANIONS']);
});

test('T1 TASK_COMPANIONS is the frozen three-entry companion list in order', () => {
  const { TASK_COMPANIONS } = allowlist();
  assert.equal(Array.isArray(TASK_COMPANIONS), true);
  assert.deepEqual([...TASK_COMPANIONS], [...COMPANIONS]);
  assert.equal(Object.isFrozen(TASK_COMPANIONS), true);
  assert.throws(() => { TASK_COMPANIONS.push('list_dir'); }, TypeError);
  assert.throws(() => { TASK_COMPANIONS[0] = 'list_dir'; }, TypeError);
  assert.deepEqual([...TASK_COMPANIONS], [...COMPANIONS]);
});

test('T1 GROK_PROCESS_TOOLS is the frozen eleven-entry allowlist in exact order', () => {
  const { GROK_PROCESS_TOOLS } = allowlist();
  assert.equal(Array.isArray(GROK_PROCESS_TOOLS), true);
  assert.deepEqual([...GROK_PROCESS_TOOLS], [...PROCESS_TOOLS]);
  assert.equal(GROK_PROCESS_TOOLS.length, 11);
  assert.equal(new Set(GROK_PROCESS_TOOLS).size, 11);
  assert.equal(GROK_PROCESS_TOOLS.every(name => typeof name === 'string' && /^[a-z_]+$/.test(name)), true);
  assert.equal(Object.isFrozen(GROK_PROCESS_TOOLS), true);
  assert.throws(() => { GROK_PROCESS_TOOLS.push('list_dir'); }, TypeError);
  assert.throws(() => { GROK_PROCESS_TOOLS.splice(0, 1); }, TypeError);
  assert.throws(() => { GROK_PROCESS_TOOLS[10] = 'monitor'; }, TypeError);
  for (const extra of EXTRAS) assert.equal(GROK_PROCESS_TOOLS.includes(extra), false, extra);
});

test('T1 drift check: GROK_PROCESS_TOOLS.slice(0,8) equals GROK_PROFILE.tools and the tail is TASK_COMPANIONS', () => {
  const { GROK_PROCESS_TOOLS, TASK_COMPANIONS } = allowlist();
  const { GROK_PROFILE } = require('../lib/native-provider-service');
  assert.deepEqual(GROK_PROCESS_TOOLS.slice(0, 8), [...GROK_PROFILE.tools]);
  assert.deepEqual(GROK_PROCESS_TOOLS.slice(8), [...TASK_COMPANIONS]);
});

test('T1 invariant: GROK_PROFILE.tools keeps its exact eight canonical IDs', () => {
  const { GROK_PROFILE } = require('../lib/native-provider-service');
  assert.deepEqual([...GROK_PROFILE.tools], [...PROFILE_TOOLS]);
  assert.equal(Object.isFrozen(GROK_PROFILE), true);
});

test('T1 the allowlist module is pure constants: no service require, no I/O module, no BOM', () => {
  const file = require.resolve('../lib/grok-tool-allowlist');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, 'no UTF-8 BOM');
  const src = bytes.toString('utf8');
  assert.doesNotMatch(src, /require\(\s*['"][^'"]*native-provider-service/);
  assert.doesNotMatch(src, /require\(\s*['"](?:node:)?(?:fs|fs\/promises|child_process|net|http|https|os|dgram|worker_threads)['"]\s*\)/);
});

test('T1 buildArgs puts the top-level --tools allowlist first for a selected model', () => {
  assert.deepEqual(bridge().buildArgs(options), ['--tools', TOOLS_VALUE, 'agent', '--no-leader', '--model', 'grok-selected', '--effort', 'low', 'stdio']);
});

test('T1 buildArgs for the CLI default (model "") omits --model and keeps --tools first', () => {
  assert.deepEqual(bridge().buildArgs({ ...options, model: '' }), ['--tools', TOOLS_VALUE, 'agent', '--no-leader', '--effort', 'low', 'stdio']);
});

test('T1 the --tools value is GROK_PROCESS_TOOLS.join(",") and the rest of the argv is unchanged for every option variant', () => {
  const { GROK_PROCESS_TOOLS } = allowlist();
  for (const o of VARIANTS) {
    const argv = bridge().buildArgs(o);
    assert.deepEqual(argv, expectedArgs(o));
    assert.equal(argv[0], '--tools');
    assert.equal(argv[1], GROK_PROCESS_TOOLS.join(','));
    assert.equal(argv[2], 'agent');
    assert.deepEqual(argv.slice(2), ['agent', '--no-leader', ...(o.model === '' ? [] : ['--model', o.model]), '--effort', o.effort, 'stdio']);
    assert.equal(argv.filter(token => token === '--tools').length, 1);
    assert.equal(argv.filter(token => token === 'agent').length, 1);
    assert.equal(argv.indexOf('--tools') < argv.indexOf('agent'), true);
    assert.equal(argv.every(token => typeof token === 'string'), true);
  }
});

test('T1 no Grok argv carries a denylist, no-subagents or approval-bypass flag anywhere', () => {
  for (const o of VARIANTS) {
    const argv = bridge().buildArgs(o);
    for (const token of argv) {
      for (const flag of FORBIDDEN) assert.equal(token === flag || token.startsWith(flag + '='), false, `${flag} in ${JSON.stringify(argv)}`);
      assert.equal(token.startsWith('--tools='), false);
    }
  }
});

test('T1 the argv builders do not add --disallowed-tools or --no-subagents', () => {
  for (const file of argvSources()) {
    const src = withoutComments(fs.readFileSync(file, 'utf8'));
    assert.equal(src.includes('--disallowed-tools'), false, file);
    assert.equal(src.includes('--no-subagents'), false, file);
  }
});

test('T1 start() hands openEndpoint exactly the new argv (selected model and CLI default)', async () => {
  for (const extra of [{}, { model: '' }]) {
    const seen = [];
    const p = bridge().start({ ...options, ...extra, openEndpoint: args => { seen.push([...args]); throw Error('synthetic endpoint refused'); } });
    p.stdout.resume();
    p.stderr.resume();
    await p.completion;
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], expectedArgs({ ...options, ...extra }));
  }
});

test('T1 the reviewed Grok plan carries the new argv unchanged and still rejects bypass flags before or after agent', () => {
  const { createPlan } = require('../lib/provider-native-plan');
  for (const o of [options, { ...options, model: '' }]) {
    const argv = bridge().buildArgs(o);
    const plan = createPlan(planOptions(argv));
    assert.deepEqual(plan.args.slice(-argv.length), argv);
    const at = argv.indexOf('agent');
    assert.ok(at > 0);
    for (const flag of BYPASS) {
      const placements = [
        [flag, ...argv],
        [...argv.slice(0, at), flag, ...argv.slice(at)],
        [...argv.slice(0, at + 1), flag, ...argv.slice(at + 1)],
        [...argv, flag]
      ];
      for (const bad of placements) assert.throws(() => createPlan(planOptions(bad)), { code: 'NATIVE_ARGS_INVALID' }, JSON.stringify(bad));
    }
  }
});
