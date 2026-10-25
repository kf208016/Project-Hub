'use strict';
const {IDLE_MS}=require('./native-turn-limits');
const {classifyGrokOperation}=require('./grok-canonical-operation');

/*
 * Generic pure CommonJS policy for ALREADY human-approved native CLI development tools.
 * No IO, no process, no network, no dependencies.
 * Grants NO OS authority itself. A trusted parent controller has already obtained
 * human consent for: task root, self-credential readability risk, provider destination,
 * general development commands, and same-model delegation. The controller independently
 * enforces a pinned OS sandbox / egress boundary. This module only decides accept|decline|manual
 * for already-approved native tool call shapes, based on JSON-domain-validated data.
 *
 * This module cannot and does not claim to determine arbitrary shell behavior safety,
 * nor can it guarantee secret isolation. Suspicious patterns are routed to 'manual'.
 */

const MAX_DEPTH = 24;
const MAX_NODES = 32768;
const MAX_BYTES = 128 * 1024;

const PROTECTED_DIRS = ['.git', '.agents', '.codex', '.aws', '.hub-runtime', '.ai\\chat', '.ai\\web-chat', '.ai/chat', '.ai/web-chat'];

const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

const CREDENTIAL_HINTS = ['.credentials.json', 'auth.json', 'credential', 'hub_owner', 'hub-owner', 'hubowner'];
const CLI_NAMES = ['claude', 'grok', 'codex'];

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasBadUnicodeOrNul(str) {
  if (typeof str !== 'string') return false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0) return true;
    // lone surrogates
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      i++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

// Strict JSON-domain validation: own enumerable data descriptors only, no getters,
// no symbols, no cycles, no nonplain prototypes, bounded depth/nodes/size.
function validateJsonDomain(root) {
  const seen = new Set();
  let nodeCount = 0;
  let byteEstimate = 0;

  function countBytes(s) {
    byteEstimate += Buffer.byteLength(JSON.stringify(s),'utf8');
    if(byteEstimate>MAX_BYTES)throw new Error('size');
  }

  function walk(value, depth) {
    nodeCount++;
    if (nodeCount > MAX_NODES) throw new Error('nodes');
    if (depth > MAX_DEPTH) throw new Error('depth');

    if (value === null) return;
    const t = typeof value;

    if (t === 'string') {
      if(value.length>MAX_BYTES)throw new Error('size');
      if (hasBadUnicodeOrNul(value)) throw new Error('unicode');
      countBytes(value);
      return;
    }
    if (t === 'number') {
      if (!Number.isFinite(value)) throw new Error('nonfinite');
      return;
    }
    if (t === 'boolean') return;
    if (t === 'symbol' || t === 'function' || t === 'undefined' || t === 'bigint') {
      throw new Error('type');
    }
    if (t !== 'object') throw new Error('type');

    if (seen.has(value)) throw new Error('cycle');
    seen.add(value);

    if (Array.isArray(value)) {
      // array proto check
      const proto = Object.getPrototypeOf(value);
      if (proto !== Array.prototype) throw new Error('proto');
      const descriptors=Object.getOwnPropertyDescriptors(value);
      if(Object.getOwnPropertySymbols(value).length||Object.keys(descriptors).length!==value.length+1)throw new Error('array keys');
      for(const key of Object.keys(descriptors))if(key!=='length'&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=value.length))throw new Error('array keys');
      for (let i = 0; i < value.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, i);
        if (!desc || !desc.enumerable || !Object.hasOwn(desc,'value')) throw new Error('descriptor');
        walk(desc.value, depth + 1);
      }
      seen.delete(value);
      return;
    }

    if (!isPlainObject(value)) throw new Error('proto');

    const symKeys = Object.getOwnPropertySymbols(value);
    if (symKeys.length > 0) throw new Error('symbol');

    const keys = Object.keys(value);
    if(Object.getOwnPropertyNames(value).length!==keys.length)throw new Error('nonenumerable');
    for (const key of keys) {
      if (hasBadUnicodeOrNul(key)) throw new Error('unicode');
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('magic');
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !desc.enumerable || !Object.hasOwn(desc,'value')) throw new Error('descriptor');
      countBytes(key);walk(desc.value, depth + 1);
    }

    seen.delete(value);
  }

  walk(root, 0);
  if (byteEstimate > MAX_BYTES) throw new Error('size');
}

function safeValidate(value) {
  try {
    validateJsonDomain(value);
    return true;
  } catch (e) {
    return false;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// --- Windows path handling (string-only, no IO) ---

function normalizeSlashes(p) {
  return p.replace(/\//g, '\\');
}

function hasControlChars(p) {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20) return true;
  }
  return false;
}

function isAbsoluteWindowsPath(p) {
  return /^[a-zA-Z]:\\/.test(p);
}

function rejectsPathSyntax(raw) {
  if (typeof raw !== 'string') return true;
  if (raw.length === 0) return true;
  if(raw.length>32760)return true;
  if (hasControlChars(raw)) return true;
  if (hasBadUnicodeOrNul(raw)) return true;

  const p = normalizeSlashes(raw);

  // UNC paths \\server\share
  if (p.startsWith('\\\\')) return true;
  // device paths \\.\ or \\?\
  if (/^\\\\[.?]\\/.test(p)) return true;
  if(p.startsWith('\\'))return true;
  // ADS: colon not part of drive letter pattern
  const driveMatch = /^[a-zA-Z]:\\/.test(p);
  const colonCount = (p.match(/:/g) || []).length;
  if (driveMatch && colonCount > 1) return true;
  if (!driveMatch && colonCount > 0) return true; // relative path with colon -> ADS/device risk

  // traversal segments
  const segments = p.split('\\');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return true;
  }

  // trailing dot/space on any segment (reserved on Windows)
  const rawSegments = p.split('\\');
  for (const seg of rawSegments) {
    if (seg.length === 0) continue;
    if (seg.endsWith('.') || seg.endsWith(' ')) return true;
    // reserved device names, with or without extension
    const base = seg.split('.')[0].toUpperCase();
    if (RESERVED_NAMES.has(base)) return true;
    if(/^(COM|LPT)[¹²³]$/i.test(base)||/[<>"|?*]/.test(seg))return true;
  }

  return false;
}

function toAbsoluteUnderRoot(rawPath, root) {
  // returns normalized absolute lowercase-compare path string, or null if invalid
  if (rejectsPathSyntax(rawPath)) return null;
  const p = normalizeSlashes(rawPath);
  let abs;
  if (isAbsoluteWindowsPath(p)) {
    abs = p;
  } else {
    // relative: join to root (root assumed absolute, normalized, no trailing slash)
    abs = root.replace(/\\$/, '') + '\\' + p;
  }
  // collapse duplicate backslashes
  abs = abs.replace(/\\+/g, '\\');
  if (abs.endsWith('.') || abs.endsWith(' ')) return null;
  return abs;
}

function isWithinRoot(absPath, root) {
  const a = absPath.toLowerCase().replace(/\\$/, '');
  const r = root.toLowerCase().replace(/\\$/, '');
  if (a === r) return true;
  return a.startsWith(r + '\\');
}

function isProtectedPath(absPath, root) {
  const a = absPath.toLowerCase().replace(/\\$/, '');
  const r = root.toLowerCase().replace(/\\$/, '');
  for (const dir of PROTECTED_DIRS) {
    const d = (r + '\\' + dir).toLowerCase().replace(/\//g, '\\').replace(/\\+/g, '\\');
    if (a === d || a.startsWith(d + '\\')) return true;
  }
  return false;
}

function validRootForPolicy(policy) {
  if (!policy || typeof policy !== 'object') return false;
  if (typeof policy.root !== 'string' || policy.root.length === 0) return false;
  if (!isAbsoluteWindowsPath(normalizeSlashes(policy.root))) return false;
  if (rejectsPathSyntax(policy.root)) return false;
  if(/^[a-z]:\\?$/i.test(normalizeSlashes(policy.root))||/^[a-z]:\\Users(?:\\[^\\]+)?\\?$/i.test(normalizeSlashes(policy.root)))return false;
  return true;
}

// Resolve one candidate path field; returns absolute normalized path or null (invalid/outside/protected)
function resolveCandidate(raw, root) {
  if (typeof raw !== 'string') return null;
  const abs = toAbsoluteUnderRoot(raw, root);
  if (!abs) return null;
  if (!isWithinRoot(abs, root)) return null;
  if (isProtectedPath(abs, root)) return null;
  return abs;
}

function collectPathAliases(obj, fields) {
  const vals = [];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) {
      const d = Object.getOwnPropertyDescriptor(obj, f);
      if (!d || !d.enumerable || 'get' in d) return null; // malformed
      vals.push(obj[f]);
    }
  }
  return vals;
}

// --- Main decide ---

function decide(actor, detail, policy) {
  try {
    return decideInner(actor, detail, policy);
  } catch (e) {
    return 'decline';
  }
}

function decideInner(actor, detail, policy) {
  if (actor !== 'claude' && actor !== 'grok') return 'decline';
  if (!isPlainObject(detail)) return 'decline';
  if (!isPlainObject(policy)) return 'decline';

  if (!safeValidate(detail)) return 'decline';
  if (!safeValidate(policy)) return 'decline';
  if(Object.keys(policy).length!==5||!['root','modelFlag','commandsApproved','subagentsApproved','mcpTools'].every(k=>Object.hasOwn(policy,k)))return 'decline';

  if (!validRootForPolicy(policy)) return 'decline';
  if (typeof policy.modelFlag !== 'string' || policy.modelFlag.length === 0) return 'decline';
  if (typeof policy.commandsApproved !== 'boolean') return 'decline';
  if (typeof policy.subagentsApproved !== 'boolean') return 'decline';
  if (!Array.isArray(policy.mcpTools)) return 'decline';
  for (const t of policy.mcpTools) {
    if (typeof t !== 'string' || t.length === 0) return 'decline';
  }

  const root = normalizeSlashes(policy.root).replace(/\\$/, '');

  if (actor === 'claude') {
    return decideClaude(detail, policy, root);
  }
  return decideGrok(detail, policy, root);
}

function decideClaude(detail, policy, root) {
  if (typeof detail.toolName !== 'string' || detail.toolName.length === 0) return 'decline';
  if (!('input' in detail)) return 'decline';
  const inputDesc = Object.getOwnPropertyDescriptor(detail, 'input');
  if (!inputDesc || !inputDesc.enumerable || 'get' in inputDesc) return 'decline';
  const input = detail.input;
  if (!isPlainObject(input)) return 'decline';

  const toolName = detail.toolName;

  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return decideFileOp(input, ['file_path'], root);
  }

  if (toolName === 'Glob' || toolName === 'Grep') {
    return decideSearchOp(input, ['path'], root);
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return decideCommandOp(input, 'command', policy, root);
  }

  if (toolName === 'Agent' || toolName === 'Task') {
    return decideSubagentOp(input, policy);
  }

  if (toolName === 'TodoWrite' || toolName === 'TaskOutput' || toolName === 'TaskStop') {
    // pure bookkeeping; JSON-validity already established above
    return 'accept';
  }

  if (policy.mcpTools.indexOf(toolName) !== -1) {
    // MCP tool call: toolName must exactly match an already-registered allowlisted name
    return 'accept';
  }

  return 'manual';
}

function decideGrok(detail, policy, root) {
  if (typeof detail.title !== 'string') return 'decline';
  if (typeof detail.kind !== 'string') return 'decline';
  if (!('rawInput' in detail)) return 'decline';
  const rawDesc = Object.getOwnPropertyDescriptor(detail, 'rawInput');
  if (!rawDesc || !rawDesc.enumerable || 'get' in rawDesc) return 'decline';
  const rawInput = detail.rawInput;
  if (!isPlainObject(rawInput)) return 'decline';

  const operation=classifyGrokOperation(detail.title,detail.kind,rawInput.variant);
  if(operation==='manual'||operation==='decline')return operation;

  // File ops
  if (operation==='file') {
    return decideFileOp(rawInput, ['file_path', 'target_file', 'path'], root);
  }

  // execute / run_terminal_command
  if (operation==='command') {
    if(Object.hasOwn(rawInput,'command')&&Object.hasOwn(rawInput,'command_line')&&rawInput.command!==rawInput.command_line)return 'decline';
    return decideCommandOp(rawInput, Object.hasOwn(rawInput,'command_line')?'command_line':'command', policy, root, true);
  }

  // search
  if (operation==='search') {
    // Official Grep serializes an absent optional path as null (workspace cwd).
    const searchInput=rawInput.variant==='Grep'&&rawInput.path===null?
      Object.fromEntries(Object.entries(rawInput).filter(([key])=>key!=='path')):rawInput;
    return decideSearchOp(searchInput, ['path'], root);
  }
  if (operation==='tool-search') {
    return decideGrokSearchTool(rawInput);
  }

  // subagent
  if (operation==='subagent') {
    return decideSubagentOp(rawInput, policy);
  }

  // MCP via UseTool
  if (operation==='mcp') {
    return decideGrokUseTool(rawInput, policy);
  }

  return 'manual';
}

function decideFileOp(input, fieldNames, root) {
  const present = fieldNames.filter((f) => Object.prototype.hasOwnProperty.call(input, f));
  if (present.length === 0) return 'manual';

  const vals = collectPathAliases(input, present);
  if (vals === null) return 'decline';

  const resolved = [];
  for (const v of vals) {
    if (typeof v !== 'string') return 'decline';
    const abs = resolveCandidate(v, root);
    if (abs === null) return 'decline';
    resolved.push(abs.toLowerCase());
  }

  const first = resolved[0];
  for (const r of resolved) {
    if (r !== first) return 'decline'; // alias contradiction
  }

  // reject any extraneous unrecognized dangerous fields (permissions/model/env) -> manual
  const allowedExtra = new Set(fieldNames.concat(['variant', 'old_string', 'new_string', 'content', 'edits', 'offset', 'limit']));
  for (const key of Object.keys(input)) {
    if (!allowedExtra.has(key)) {
      // unknown extra fields are tolerated as inert descriptive data per spec intent
      // but explicit permission/model-like keys should be manual
      if (/permission|model|env|bypass|mcpServers|command/i.test(key)) return 'manual';
    }
  }

  return 'accept';
}

function decideSearchOp(input, pathFields, root) {
  let pathVal = root;
  let hasPath = false;
  for (const f of pathFields) {
    if (Object.prototype.hasOwnProperty.call(input, f)) {
      const d = Object.getOwnPropertyDescriptor(input, f);
      if (!d || !d.enumerable || 'get' in d) return 'decline';
      if (typeof input[f] !== 'string') return 'decline';
      pathVal = input[f];
      hasPath = true;
      break;
    }
  }
  if (hasPath) {
    const abs = resolveCandidate(pathVal, root);
    if (abs === null) return 'decline';
  }
  for (const key of Object.keys(input)) {
    if (/permission|model|env|bypass|command|mcpServers/i.test(key)) return 'manual';
  }
  return 'accept';
}

function decideGrokSearchTool(rawInput) {
  for (const key of Object.keys(rawInput)) {
    if (/command|permission|model|env|bypass/i.test(key)) return 'manual';
  }
  return 'accept';
}

function isCanonicalGrokCommandField(key,value){
  if(key==='timeout'){
    return typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=IDLE_MS;
  }
  if(key==='is_background'){
    return typeof value==='boolean';
  }
  if(key==='block_until_ms'){
    return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=IDLE_MS;
  }
  return false;
}

function decideCommandOp(input, cmdField, policy, root, grok) {
  if (!policy.commandsApproved) return 'decline';

  if (!Object.prototype.hasOwnProperty.call(input, cmdField)) return 'manual';
  const cmdDesc = Object.getOwnPropertyDescriptor(input, cmdField);
  if (!cmdDesc || !cmdDesc.enumerable || 'get' in cmdDesc) return 'decline';
  const command = input[cmdField];
  if (!isNonEmptyString(command)) return 'decline';
  if (command.length > 8192) return 'decline';
  if (hasBadUnicodeOrNul(command)) return 'decline';

  const cwdFields = grok ? ['cwd', 'workdir'] : ['cwd'];
  const directories=[];
  for (const f of cwdFields) {
    if (Object.prototype.hasOwnProperty.call(input, f)) {
      const d = Object.getOwnPropertyDescriptor(input, f);
      if (!d || !d.enumerable || 'get' in d) return 'decline';
      const cwdVal = input[f];
      if (typeof cwdVal !== 'string') return 'decline';
      const abs = resolveCandidate(cwdVal, root);
      if (abs === null) return 'decline';
      directories.push(abs.toLowerCase());
    }
  }
  if(directories.some(p=>p!==directories[0]))return 'decline';

  for (const key of Object.keys(input)) {
    if (key === cmdField || cwdFields.indexOf(key) !== -1 || key === 'variant' || key === 'description') continue;
    if(key==='command'&&grok&&cmdField==='command_line'&&input.command===input.command_line)continue;
    if(key==='timeout'&&Number.isSafeInteger(input.timeout)&&input.timeout>=1&&input.timeout<=IDLE_MS)continue;
    if(key==='run_in_background'&&typeof input.run_in_background==='boolean')continue;
    if(grok&&input.variant==='Bash'&&isCanonicalGrokCommandField(key,input[key]))continue;
    if (/permission|model|env|bypass|mcpServers/i.test(key)) return 'manual';
    // unrecognized extra fields -> manual to be conservative
    return 'manual';
  }

  const lower = command.toLowerCase();
  for (const hint of CREDENTIAL_HINTS) {
    if (lower.indexOf(hint.toLowerCase()) !== -1) return 'manual';
  }
  for (const cli of CLI_NAMES) {
    const pattern = new RegExp('(^|[\\\\/\\s])' + cli + '(\\.exe)?([\\s\\"\'$]|$)', 'i');
    if (pattern.test(command)) return 'manual';
  }
  if (/bypass[-_ ]?permission/i.test(command)) return 'manual';

  return 'accept';
}

function decideSubagentOp(input, policy) {
  if (!policy.subagentsApproved) return 'decline';

  for (const key of Object.keys(input)) {
    if (/^permission/i.test(key) || /bypass/i.test(key) || key === 'env' || key === 'mcpServers') {
      return 'manual';
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'model')) {
    const d = Object.getOwnPropertyDescriptor(input, 'model');
    if (!d || !d.enumerable || 'get' in d) return 'decline';
    const m = input.model;
    if (m !== undefined && m !== null && m !== 'inherit' && m !== policy.modelFlag) {
      if (typeof m !== 'string') return 'decline';
      return 'manual';
    }
  }

  let promptVal;
  if (Object.prototype.hasOwnProperty.call(input, 'prompt')) {
    promptVal = input.prompt;
  } else if (Object.prototype.hasOwnProperty.call(input, 'task')) {
    promptVal = input.task;
  }
  if (!isNonEmptyString(promptVal)) return 'decline';
  if (promptVal.length > 65536) return 'decline';

  return 'accept';
}

function decideGrokUseTool(rawInput, policy) {
  if (typeof rawInput.tool_name !== 'string' || rawInput.tool_name.length === 0) return 'decline';
  if (!Object.prototype.hasOwnProperty.call(rawInput, 'tool_input')) return 'decline';
  const tiDesc = Object.getOwnPropertyDescriptor(rawInput, 'tool_input');
  if (!tiDesc || !tiDesc.enumerable || 'get' in tiDesc) return 'decline';
  if (!isPlainObject(rawInput.tool_input)) return 'decline';

  if (policy.mcpTools.indexOf(rawInput.tool_name) === -1) return 'manual';

  return 'accept';
}

module.exports = { decide };
