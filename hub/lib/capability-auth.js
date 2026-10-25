'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { validateArguments } = require('./chatgpt');
const { CLI_DEFAULT_LABEL } = require('./launch');
const delegationModelValid = (model, actor) => typeof model === 'string' && (/^[a-z0-9][a-z0-9._-]{0,99}$/.test(model) || ['claude', 'grok'].includes(actor) && model === CLI_DEFAULT_LABEL);

const READ_TOOLS = Object.freeze(['hub_list_tasks', 'hub_get_task', 'hub_get_chat', ...(process.platform === 'win32' ? [] : ['hub_read_file'])]);
const TOOL_NAMES = new Set([...READ_TOOLS, 'hub_read_file', 'hub_list_projects', 'hub_report', 'hub_ask_owner', 'hub_mark_step', 'hub_propose_task', 'hub_write_file', 'hub_run_command', 'hub_request_command', 'hub_get_command_result','hub_delegate']);
const fail = message => { const error = Error(message); error.status = 403; throw error; };
const component = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[/\\:*?"<>|\x00-\x1f\x7f]|[. ]$/.test(value) && !['.', '..'].includes(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const snapshot = record => Object.freeze({ id: record.id, project: record.project, ...(record.task ? { task: record.task } : {}), ...(record.rootFingerprint ? { rootFingerprint: record.rootFingerprint } : {}), ...(record.delegationModel?{delegationModel:record.delegationModel,...(record.delegationActor?{delegationActor:record.delegationActor}:{}),remainingDelegations:record.delegationUsed?0:1}:{}), runId: record.runId, tools: Object.freeze(record.tools.slice()), expiresAt: record.expiresAt, remainingCalls: record.maxCalls - record.calls });
const validRecord = record => record && component(record.project) && (!record.task || component(record.task)) && identifier(record.runId) && Array.isArray(record.tools) && record.tools.length && record.tools.every(tool => TOOL_NAMES.has(tool)) &&
  (record.root===undefined&&record.rootFingerprint===undefined || typeof record.root==='string'&&path.isAbsolute(record.root)&&path.resolve(record.root)===record.root&&typeof record.rootFingerprint==='string'&&/^[a-f0-9]{64}$/.test(record.rootFingerprint)) &&
  (record.taskHash===undefined||typeof record.taskHash==='string'&&/^[a-f0-9]{64}$/.test(record.taskHash)) &&
  (record.workspaceRun===undefined||identifier(record.workspaceRun)) &&
  (record.delegationModel===undefined&&record.delegationUsed===undefined&&record.delegationActor===undefined||delegationModelValid(record.delegationModel,record.delegationActor)&&typeof record.delegationUsed==='boolean'&&(record.delegationActor===undefined||['codex','claude','grok'].includes(record.delegationActor))) &&
  (record.journalRoot===undefined&&record.journalRootFingerprint===undefined||typeof record.journalRoot==='string'&&path.isAbsolute(record.journalRoot)&&path.resolve(record.journalRoot)===record.journalRoot&&typeof record.journalRootFingerprint==='string'&&/^[a-f0-9]{64}$/.test(record.journalRootFingerprint)) &&
  Number.isSafeInteger(record.issuedAt) && Number.isSafeInteger(record.expiresAt) && record.expiresAt - record.issuedAt >= 1000 && record.expiresAt - record.issuedAt <= 3600000 &&
  Number.isSafeInteger(record.issuedMono) && Number.isSafeInteger(record.expiresMono) && record.expiresMono-record.issuedMono===record.expiresAt-record.issuedAt &&
  Number.isSafeInteger(record.maxCalls) && record.maxCalls > 0 && record.maxCalls <= 500 && Number.isSafeInteger(record.calls) && record.calls >= 0 && record.calls <= record.maxCalls && record.nonces instanceof Set && record.nonces.size === record.calls;

// A process-local grant. Restart revokes every grant; no long-lived workspace
// credential exists. Issue only after a user has approved this precise scope.
class CapabilityAuth {
  constructor({ now = () => Date.now(), monotonic = () => Number(process.hrtime.bigint()/1000000n) } = {}) { this.now = now;this.monotonic=monotonic; this.records = new Map(); }
  time() { const now = this.now(); if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 3600000) fail('MCP clock is invalid'); return now; }
  mono() {const value=this.monotonic();if(!Number.isSafeInteger(value)||value<0)fail('MCP monotonic clock is invalid');return value;}
  prune() { const now = this.time(),mono=this.mono(); for (const [hash, record] of this.records) if (!validRecord(record) || record.issuedAt > now || record.issuedMono>mono || record.expiresAt <= now ||record.expiresMono<=mono|| record.revoked) this.records.delete(hash); }
  issue(options) {
    if (!plain(options) || Object.keys(options).some(key => !['project', 'task', 'runId', 'tools', 'ttlMs', 'maxCalls', 'root', 'rootFingerprint', 'taskHash', 'journalRoot', 'journalRootFingerprint','delegationModel','delegationActor','workspaceRun'].includes(key))) fail('MCP capability scope is invalid');
    const { project, task, runId, tools = READ_TOOLS, ttlMs = 10 * 60000, maxCalls = 100, root, rootFingerprint, taskHash, journalRoot, journalRootFingerprint,delegationModel,delegationActor,workspaceRun } = options;
    if (!component(project) || (task !== undefined && !component(task)) || !identifier(runId) ||
        !Array.isArray(tools) || !tools.length || tools.length > TOOL_NAMES.size || new Set(tools).size !== tools.length || tools.some(tool => !TOOL_NAMES.has(tool)) ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 500) fail('MCP capability scope is invalid');
    if (task && tools.some(tool => ['hub_propose_task', 'hub_run_command'].includes(tool))) fail('Task MCP capability cannot create tasks or execute commands');
    if (process.platform === 'win32' && tools.includes('hub_run_command')) fail('Windows MCP command capability is unavailable');
    const commandTools = tools.some(tool => ['hub_request_command','hub_get_command_result'].includes(tool));
    const delegate=tools.includes('hub_delegate');
    const fileTools = tools.some(tool => ['hub_read_file', 'hub_write_file'].includes(tool)) || commandTools || delegate;
    if (process.platform === 'win32' && fileTools && (!task || typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || !/^[a-z]:[\\/]/i.test(root) || !/^[a-f0-9]{64}$/.test(rootFingerprint))) fail('Windows file capability requires an issued task root identity');
    if ((root !== undefined || rootFingerprint !== undefined) && !fileTools) fail('Unused root authority is invalid');
    if(workspaceRun!==undefined&&(!fileTools||!task||!identifier(workspaceRun)))fail('Unused workspace run authority is invalid');
    if (commandTools && (!task || !/^[a-f0-9]{64}$/.test(taskHash || ''))) fail('Command request capability requires an issued task hash');
    if (taskHash!==undefined && (!commandTools || !/^[a-f0-9]{64}$/.test(taskHash))) fail('Unused task hash authority is invalid');
    if(delegate&&(!task||!root||!delegationModelValid(delegationModel,delegationActor)||delegationActor!==undefined&&!['codex','claude','grok'].includes(delegationActor))||!delegate&&(delegationModel!==undefined||delegationActor!==undefined))fail('Delegation requires an explicitly issued CLI and model');
    if (journalRoot!==undefined||journalRootFingerprint!==undefined) {
      const relative=typeof root==='string'&&typeof journalRoot==='string'?path.relative(root,journalRoot):'';
      if (!tools.includes('hub_write_file')||typeof journalRoot!=='string'||!path.isAbsolute(journalRoot)||path.resolve(journalRoot)!==journalRoot||!/^[a-f0-9]{64}$/.test(journalRootFingerprint||'')||!(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))) fail('Private write journal authority is invalid');
    }
    this.prune();
    if (this.records.size >= 128) fail('MCP capability limit reached');
    const token = crypto.randomBytes(32).toString('base64url');
    const issuedAt = this.time(),issuedMono=this.mono();
    const record = { id: crypto.randomUUID(), project, task, runId, tools: tools.slice(), ...(root ? { root, rootFingerprint } : {}), ...(taskHash ? {taskHash} : {}), ...(journalRoot ? {journalRoot,journalRootFingerprint} : {}), ...(workspaceRun?{workspaceRun}:{}), ...(delegate?{delegationModel,...(delegationActor?{delegationActor}:{}),delegationUsed:false}:{}), issuedAt, expiresAt: issuedAt + ttlMs,issuedMono,expiresMono:issuedMono+ttlMs, maxCalls, calls: 0, nonces: new Set() };
    this.records.set(tokenHash(token), record);
    return { token, capability: snapshot(record) };
  }
  record(token, runId) {
    this.prune();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !identifier(runId)) fail('MCP capability is invalid or expired');
    const record = this.records.get(tokenHash(token));
    if (!record || record.runId !== runId || record.calls >= record.maxCalls) fail('MCP capability is invalid or expired');
    return record;
  }
  inspect(token, runId) { return snapshot(this.record(token, runId)); }
  current(id, runId) {
    this.prune();
    const record = [...this.records.values()].find(row => row.id===id && row.runId===runId);
    if(!record || record.calls>=record.maxCalls) fail('MCP capability is invalid or expired');
    return Object.freeze({...snapshot(record),...(record.root?{root:record.root}:{}),...(record.taskHash?{taskHash:record.taskHash}:{}),...(record.workspaceRun?{workspaceRun:record.workspaceRun}:{})});
  }
  consume({ token, runId, nonce, tool, arguments: args }) {
    const record = this.record(token, runId);
    if (!identifier(nonce) || record.nonces.has(nonce) || !record.tools.includes(tool) || !plain(args) || !validateArguments(tool, args)) fail('MCP capability request is not authorized');
    if(tool==='hub_delegate'&&(record.delegationUsed||args.model!==record.delegationModel))fail('Delegation model or once-only grant does not match');
    if (tool === 'hub_list_projects') {
      if (Object.keys(args).length) fail('MCP capability request is not authorized');
    } else if (args.project !== record.project) fail('MCP capability project does not match');
    if (record.task) {
      if (['hub_list_projects', 'hub_list_tasks'].includes(tool)) {
        if (args.task !== undefined) fail('MCP capability task does not match');
      } else if (args.task !== record.task) fail('MCP capability task does not match');
    }
    // Consume before dispatch; failed calls cannot replay an authorization.
    record.nonces.add(nonce); record.calls++;if(tool==='hub_delegate')record.delegationUsed=true;
    return Object.freeze({ ...snapshot(record), ...(record.root ? { root: record.root } : {}), ...(record.taskHash?{taskHash:record.taskHash}:{}), ...(record.workspaceRun?{workspaceRun:record.workspaceRun}:{}), ...(record.journalRoot?{journalRoot:record.journalRoot,journalRootFingerprint:record.journalRootFingerprint}:{}) });
  }
  revoke(id) { let count = 0; for (const record of this.records.values()) if (record.id === id) { record.revoked = true; count++; } this.prune(); return count; }
  revokeRun(runId) { let count = 0; for (const record of this.records.values()) if (record.runId === runId) { record.revoked = true; count++; } this.prune(); return count; }
  revokeTask(project, task) { let count=0;for(const record of this.records.values())if(record.project===project&&record.task===task){record.revoked=true;count++;}this.prune();return count; }
}
module.exports = { CapabilityAuth, READ_TOOLS };
