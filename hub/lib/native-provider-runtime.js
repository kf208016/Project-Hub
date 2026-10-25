'use strict';
const {MAX_WALL_MS}=require('./native-turn-limits');
const { EventEmitter } = require('node:events');
const {randomUUID}=require('node:crypto');
const {createPlan}=require('./provider-native-plan');
const {codeOf}=require('./native-provider-diagnostic');
const {CLI_DEFAULT_LABEL}=require('./launch');

const MAX_SNAPSHOT_BYTES = 131072;
const MAX_NODES = 65536;
const MAX_DEPTH = 32;
const SETUP_FAILURE_CODES=Object.freeze({
  resolve:'NATIVE_SETUP_RESOLVE_FAILED',
  authorize:'NATIVE_SETUP_AUTHORIZE_FAILED',
  broker:'NATIVE_SETUP_BROKER_FAILED',
  rebind:'NATIVE_SETUP_REBIND_FAILED',
  publish:'NATIVE_SETUP_PUBLISH_FAILED'
});

class NativeRuntimeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'NativeRuntimeError';
    this.code = code;
  }
}

function fail(code, msg) { throw new NativeRuntimeError(code, msg); }

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return [Object.prototype,null].includes(Object.getPrototypeOf(v));
}

function hasBadUnicode(s) {
  if (s.indexOf('\u0000') !== -1) return true;
  // lone surrogate check
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function deepStrictCopy(value, depth, counter, seen) {
  if (depth > MAX_DEPTH) fail('NATIVE_RUNTIME_INVALID', 'depth exceeded');
  if (typeof value === 'string') {
    if (value.length>MAX_SNAPSHOT_BYTES || hasBadUnicode(value)) fail('NATIVE_RUNTIME_INVALID', 'bad unicode');
    counter.n++;
    if (counter.n > MAX_NODES) fail('NATIVE_RUNTIME_INVALID', 'too many nodes');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('NATIVE_RUNTIME_INVALID', 'non-finite number');
    counter.n++;
    if (counter.n > MAX_NODES) fail('NATIVE_RUNTIME_INVALID', 'too many nodes');
    return value;
  }
  if (typeof value === 'boolean' || value === null) {
    counter.n++;
    if (counter.n > MAX_NODES) fail('NATIVE_RUNTIME_INVALID', 'too many nodes');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('NATIVE_RUNTIME_INVALID', 'cycle detected');
    if (Object.getOwnPropertySymbols(value).length) fail('NATIVE_RUNTIME_INVALID', 'symbol key');
    if (Object.getPrototypeOf(value) !== Array.prototype) fail('NATIVE_RUNTIME_INVALID', 'bad prototype');
    seen.add(value);
    const properties=Object.getOwnPropertyDescriptors(value);
    for(const key of Object.keys(properties)){
      if(key==='length')continue;
      const d=properties[key];
      if(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=value.length||!d.enumerable||!Object.hasOwn(d,'value'))fail('NATIVE_RUNTIME_INVALID','invalid array property');
    }
    const out = [];
    counter.n++;
    if (counter.n > MAX_NODES) fail('NATIVE_RUNTIME_INVALID', 'too many nodes');
    for (let i = 0; i < value.length; i++) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || !Object.hasOwn(desc,'value') || !desc.enumerable) fail('NATIVE_RUNTIME_INVALID', 'accessor property');
      out.push(deepStrictCopy(desc.value, depth + 1, counter, seen));
    }
    seen.delete(value);
    return out;
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) fail('NATIVE_RUNTIME_INVALID', 'bad prototype');
    if (seen.has(value)) fail('NATIVE_RUNTIME_INVALID', 'cycle detected');
    if (Object.getOwnPropertySymbols(value).length) fail('NATIVE_RUNTIME_INVALID', 'symbol key');
    seen.add(value);
    const enumKeys = Object.keys(value);
    const allKeys = Object.getOwnPropertyNames(value);
    if (allKeys.length !== enumKeys.length) fail('NATIVE_RUNTIME_INVALID', 'nonenumerable property');
    const out = {};
    counter.n++;
    if (counter.n > MAX_NODES) fail('NATIVE_RUNTIME_INVALID', 'too many nodes');
    for (const k of enumKeys) {
      if(['__proto__','prototype','constructor'].includes(k)||hasBadUnicode(k))fail('NATIVE_RUNTIME_INVALID','invalid key');
      const desc = Object.getOwnPropertyDescriptor(value, k);
      if (!desc || !Object.hasOwn(desc,'value')) fail('NATIVE_RUNTIME_INVALID', 'accessor property');
      out[k] = deepStrictCopy(desc.value, depth + 1, counter, seen);
    }
    seen.delete(value);
    return out;
  }
  fail('NATIVE_RUNTIME_INVALID', 'unsupported value type');
}

function strictClone(value) {
  const counter = { n: 0 };
  const copy = deepStrictCopy(value, 0, counter, new Set());
  const size = Buffer.byteLength(JSON.stringify(copy), 'utf8');
  if (size > MAX_SNAPSHOT_BYTES) fail('NATIVE_RUNTIME_INVALID', 'snapshot too large');
  return copy;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

function assertExactKeys(obj, keys, code) {
  if (!isPlainObject(obj)) fail(code || 'NATIVE_RUNTIME_INVALID', 'expected plain object');
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    fail(code || 'NATIVE_RUNTIME_INVALID', 'unexpected fields');
  }
}

function assertBoundedString(v, max) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || hasBadUnicode(v)) {
    fail('NATIVE_RUNTIME_INVALID', 'invalid string field');
  }
  return v;
}

const ACTOR_RE = /^(claude|grok)$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const MODEL_FLAG_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const EFFORT_FLAGS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function assertActor(v) {
  if (typeof v !== 'string' || !ACTOR_RE.test(v)) fail('NATIVE_RUNTIME_INVALID', 'invalid actor');
  return v;
}
function assertFingerprint(v) {
  if (typeof v !== 'string' || !FINGERPRINT_RE.test(v)) fail('NATIVE_RUNTIME_INVALID', 'invalid rootFingerprint');
  return v;
}
function assertModelFlag(v) {
  if (typeof v !== 'string' || !MODEL_FLAG_RE.test(v)) fail('NATIVE_RUNTIME_INVALID', 'invalid modelFlag');
  return v;
}
function assertEffortFlag(v) {
  if (typeof v !== 'string' || !EFFORT_FLAGS.has(v)) fail('NATIVE_RUNTIME_INVALID', 'invalid effortFlag');
  return v;
}
function assertMaxWallMs(v) {
  if (!Number.isInteger(v) || v < 1 || v > MAX_WALL_MS) fail('NATIVE_RUNTIME_INVALID', 'invalid maxWallMs');
  return v;
}
function assertSafeId(v, max) {
  if (typeof v !== 'string' || v.length === 0 || v.length > (max || 128) || !SAFE_ID_RE.test(v)) {
    fail('NATIVE_RUNTIME_INVALID', 'invalid id');
  }
  return v;
}

const ALLOWED_LAUNCH_KEYS = [
  'actor', 'cwd', 'rootFingerprint', 'ownerHome', 'runtimeBase', 'providerFile', 'codexFile',
  'codexSHA256', 'nodeFile', 'gitDirectory', 'hubLibDirectory', 'systemRoot', 'maxWallMs'
];

function reservationKey(actor, project, task) {
  return JSON.stringify([actor,project,task]);
}

function validateRequest(request) {
  request=strictClone(request);
  assertExactKeys(request, ['actor', 'project', 'task', 'dir', 'model', 'effort', 'rootFingerprint'], 'NATIVE_RUNTIME_INVALID');
  const actor = assertActor(request.actor);
  const project = assertBoundedString(request.project, 512);
  const task = assertBoundedString(request.task, 512);
  const dir = assertBoundedString(request.dir, 2048);
  const model = assertBoundedString(request.model, 256);
  const effort = request.effort;
  if(typeof effort!=='string'||effort.length>64||hasBadUnicode(effort))fail('NATIVE_RUNTIME_INVALID');
  const rootFingerprint = assertFingerprint(request.rootFingerprint);
  return { actor, project, task, dir, model, effort, rootFingerprint };
}

function validateBinding(binding, req) {
  if (!isPlainObject(binding)) fail('NATIVE_RUNTIME_INVALID', 'invalid binding');
  const clean = strictClone(binding);
  assertExactKeys(clean, ['project', 'task', 'dir', 'rootFingerprint', 'workspaceRun'], 'NATIVE_RUNTIME_INVALID');
  assertBoundedString(clean.project, 512);
  assertBoundedString(clean.task, 512);
  assertBoundedString(clean.dir, 2048);
  assertFingerprint(clean.rootFingerprint);
  assertBoundedString(clean.workspaceRun, 512);
  if (clean.project !== req.project || clean.task !== req.task || clean.dir !== req.dir || clean.rootFingerprint !== req.rootFingerprint) {
    fail('NATIVE_SCOPE_MISMATCH', 'binding mismatch');
  }
  return clean;
}

function validateDescriptor(descriptor, req, binding) {
  if (!isPlainObject(descriptor)) fail('NATIVE_RUNTIME_INVALID', 'invalid descriptor');
  const clean = strictClone(descriptor);
  const baseKeys = ['scope', 'modelFlag', 'effortFlag', 'launchOptions', 'maxWallMs'];
  const mcpKeys = req.actor === 'claude' ? ['validatedMcpConfig'] : ['validatedMcpServers'];
  const optionalGrokKeys = req.actor === 'grok' ? ['validatedAgentProfile'] : [];
  const allowed = new Set([...baseKeys, ...mcpKeys, ...optionalGrokKeys]);
  for (const k of Object.keys(clean)) {
    if (!allowed.has(k)) fail('NATIVE_RUNTIME_INVALID', 'unexpected descriptor field');
  }
  for (const k of baseKeys.concat(mcpKeys)) {
    if (!(k in clean)) fail('NATIVE_RUNTIME_INVALID', 'missing descriptor field');
  }

  const scope = clean.scope;
  assertExactKeys(scope, ['project', 'task', 'actor', 'runtimeProfileId', 'accountProfileId', 'rootFingerprint'], 'NATIVE_RUNTIME_INVALID');
  if (scope.project !== req.project || scope.task !== req.task || scope.actor !== req.actor || scope.rootFingerprint !== req.rootFingerprint) {
    fail('NATIVE_SCOPE_MISMATCH', 'scope mismatch');
  }
  assertBoundedString(scope.runtimeProfileId, 256);
  assertBoundedString(scope.accountProfileId, 256);

  if(!(['claude','grok'].includes(req.actor)&&req.model===CLI_DEFAULT_LABEL&&clean.modelFlag===''))assertModelFlag(clean.modelFlag);
  assertEffortFlag(clean.effortFlag);
  assertMaxWallMs(clean.maxWallMs);

  const launchOptions = clean.launchOptions;
  if (!isPlainObject(launchOptions)) fail('NATIVE_RUNTIME_INVALID', 'invalid launchOptions');
  for (const k of Object.keys(launchOptions)) {
    if (!ALLOWED_LAUNCH_KEYS.includes(k)) fail('NATIVE_RUNTIME_INVALID', 'disallowed launch option');
  }
  if (launchOptions.actor !== undefined && launchOptions.actor !== req.actor) fail('NATIVE_SCOPE_MISMATCH', 'actor mismatch in launchOptions');
  if (launchOptions.rootFingerprint !== undefined && launchOptions.rootFingerprint !== req.rootFingerprint) fail('NATIVE_SCOPE_MISMATCH', 'fingerprint mismatch in launchOptions');
  if (launchOptions.cwd !== undefined && launchOptions.cwd !== binding.dir) fail('NATIVE_SCOPE_MISMATCH', 'cwd mismatch in launchOptions');
  if (launchOptions.maxWallMs !== undefined && launchOptions.maxWallMs !== clean.maxWallMs) fail('NATIVE_RUNTIME_INVALID', 'maxWallMs mismatch');
  try{createPlan({...launchOptions,providerArgs:[],proxyUrl:'http://hub:'+'0'.repeat(64)+'@127.0.0.1:1',maxWallMs:clean.maxWallMs});}
  catch{fail('NATIVE_RUNTIME_INVALID','invalid static launch plan');}

  let mcp = {};
  if (req.actor === 'claude') {
    const cfg = clean.validatedMcpConfig;
    if (!isPlainObject(cfg)) fail('NATIVE_RUNTIME_INVALID', 'invalid validatedMcpConfig');
    assertExactKeys(cfg, ['mcpServers'], 'NATIVE_RUNTIME_INVALID');
    if (!isPlainObject(cfg.mcpServers)) fail('NATIVE_RUNTIME_INVALID', 'invalid mcpServers');
    mcp.validatedMcpConfig = cfg;
  } else {
    const servers = clean.validatedMcpServers;
    if (!Array.isArray(servers)) fail('NATIVE_RUNTIME_INVALID', 'invalid validatedMcpServers');
    mcp.validatedMcpServers = servers;
    if ('validatedAgentProfile' in clean) {
      if (!isPlainObject(clean.validatedAgentProfile)) fail('NATIVE_RUNTIME_INVALID', 'invalid validatedAgentProfile');
      mcp.validatedAgentProfile = clean.validatedAgentProfile;
    }
  }

  return {
    scope,
    modelFlag: clean.modelFlag,
    effortFlag: clean.effortFlag,
    maxWallMs: clean.maxWallMs,
    launchOptions,
    mcp
  };
}

function validateBroker(broker) {
  if (!broker || typeof broker !== 'object') fail('NATIVE_RUNTIME_INVALID', 'invalid broker');
  if (typeof broker.proxyUrl !== 'string' || broker.proxyUrl.length === 0) fail('NATIVE_RUNTIME_INVALID', 'invalid broker proxyUrl');
  if (typeof broker.close !== 'function') fail('NATIVE_RUNTIME_INVALID', 'invalid broker close');
  if (typeof broker.snapshot !== 'function') fail('NATIVE_RUNTIME_INVALID', 'invalid broker snapshot');
  return broker;
}

function validateCleanupReceipt(receipt, expectedExitCode) {
  if(!Number.isSafeInteger(expectedExitCode))return null;
  if (!isPlainObject(receipt)) return null;
  if (receipt.cleanupVerified !== true) return null;
  if (receipt.rootExited !== true) return null;
  if (receipt.ownedTreeEmpty !== true) return null;
  if (receipt.exitCode !== expectedExitCode) return null;
  try {
    return strictClone(receipt);
  } catch {
    return null;
  }
}

class EndpointWrapper extends EventEmitter {
  constructor(nativeChild, backendId) {
    super();
    this.stdin = nativeChild.stdin;
    this.stdout = nativeChild.stdout;
    this.stderr = nativeChild.stderr;
    this.cleanupReceipt = undefined;
    Object.defineProperty(this, 'backendId', { value: backendId, writable: false, enumerable: true, configurable: false });
    Object.defineProperty(this, 'pid', { get: () => nativeChild.pid, enumerable: true });
    Object.defineProperty(this, 'commandPid', { get: () => nativeChild.commandPid, enumerable: true });
    this.kill = (...args) => nativeChild.kill(...args);
  }
}

class NativeProviderRuntime {
  #resolve;
  #authorize;
  #createBroker;
  #launch;
  #now;
  #dispose;
  #reservations = new Map();
  #usedEndpoints = new WeakSet();
  #claimedChildren = new WeakSet();

  constructor({ resolve, authorize, createBroker, launch, dispose=async()=>{}, now = Date.now } = {}) {
    if (typeof resolve !== 'function') fail('NATIVE_RUNTIME_REQUIRED', 'resolve is required');
    if (typeof authorize !== 'function') fail('NATIVE_RUNTIME_REQUIRED', 'authorize is required');
    if (typeof createBroker !== 'function') fail('NATIVE_RUNTIME_REQUIRED', 'createBroker is required');
    if (typeof launch !== 'function') fail('NATIVE_RUNTIME_REQUIRED', 'launch is required');
    if(typeof dispose!=='function')fail('NATIVE_RUNTIME_REQUIRED');
    this.#resolve = resolve;
    this.#authorize = authorize;
    this.#createBroker = createBroker;
    this.#launch = launch;
    this.#now = now;
    this.#dispose=dispose;
  }

  async #safeCloseBroker(broker) {
    if (!broker) return true;
    try { await broker.close();return true; } catch { return false; }
  }
  async #cleanup(reservation){
    const brokerClosed=await this.#safeCloseBroker(reservation.broker);
    let resourcesClosed=true;
    try{await this.#dispose(Object.freeze({...reservation.originalRequest,runId:reservation.runId}));}catch{resourcesClosed=false;}
    return brokerClosed&&resourcesClosed;
  }

  #clearStaleTimer(reservation) {
    if (reservation.staleTimer) {
      clearTimeout(reservation.staleTimer);
      reservation.staleTimer = null;
    }
  }

  #expire(key) {
    const reservation = this.#reservations.get(key);
    if (!reservation) return;
    if (reservation.childActive) return;
    (async () => {
      reservation.cancelled=true;
      if(!await this.#cleanup(reservation)){reservation.cleanupFailed=true;return;}
      if (this.#reservations.get(key) === reservation) this.#reservations.delete(key);
    })();
  }

  async prepareTurn(rawRequest) {
    const request = validateRequest(rawRequest);
    const key = reservationKey(request.actor, request.project, request.task);
    if (this.#reservations.has(key)) fail('NATIVE_RUNTIME_BUSY', 'reservation already active');
    const reservation = {
      key,
      actor: request.actor,
      project: request.project,
      task: request.task,
      dir: request.dir,
      rootFingerprint: request.rootFingerprint,
      originalRequest: request,
      cancelled: false,
      childActive: false,
      broker: null,
      publicPlan: null,
      scope: null,
      launchOptions: null,
      maxWallMs: null,
      staleTimer: null,
      endpointMarker: {}
    };
    reservation.runId=randomUUID();
    this.#reservations.set(key, reservation);

    let broker = null, setupStage='resolve';
    try {
      const binding = await this.#resolve(request);
      const cleanBinding = validateBinding(binding, request);
      if (reservation.cancelled) fail('NATIVE_RUNTIME_CANCELLED', 'cancelled during setup');

      setupStage='authorize';
      const descriptor = await this.#authorize(request, cleanBinding,Object.freeze({runId:reservation.runId}));
      const validated = validateDescriptor(descriptor, request, cleanBinding);
      if (reservation.cancelled) fail('NATIVE_RUNTIME_CANCELLED', 'cancelled during setup');

      setupStage='broker';
      broker = await this.#createBroker({ provider: request.actor, maxWallMs: validated.maxWallMs },Object.freeze({runId:reservation.runId,actor:request.actor,project:request.project,task:request.task}));
      validateBroker(broker);
      reservation.broker = broker;
      if (reservation.cancelled) {
        fail('NATIVE_RUNTIME_CANCELLED', 'cancelled during setup');
      }

      setupStage='rebind';
      const rebind = await this.#resolve(request);
      const cleanRebind = validateBinding(rebind, request);
      if (cleanRebind.workspaceRun !== cleanBinding.workspaceRun || cleanRebind.dir !== request.dir || cleanRebind.rootFingerprint !== request.rootFingerprint) {
        fail('NATIVE_SCOPE_MISMATCH', 'workspace changed during setup');
      }
      if (reservation.cancelled) {
        fail('NATIVE_RUNTIME_CANCELLED', 'cancelled during setup');
      }

      setupStage='publish';
      const publicPlanRaw = {
        runId:reservation.runId,
        scope: validated.scope,
        modelFlag: validated.modelFlag,
        effortFlag: validated.effortFlag,
        maxWallMs: validated.maxWallMs,
        ...validated.mcp
      };
      const publicPlan = deepFreeze(JSON.parse(JSON.stringify(publicPlanRaw)));

      reservation.scope = validated.scope;
      reservation.launchOptions = deepFreeze(JSON.parse(JSON.stringify(validated.launchOptions)));
      reservation.maxWallMs = validated.maxWallMs;
      reservation.publicPlan = publicPlan;
      reservation.active = true;
      reservation.staleTimer = setTimeout(() => this.#expire(key), Math.min(validated.maxWallMs, 30000));
      if (reservation.staleTimer.unref) reservation.staleTimer.unref();

      return publicPlan;
    } catch (err) {
      reservation.broker=broker;
      if(!await this.#cleanup(reservation)){reservation.cleanupFailed=true;reservation.cancelled=true;throw new NativeRuntimeError('NATIVE_CLEANUP_REQUIRED');}
      if(this.#reservations.get(key)===reservation)this.#reservations.delete(key);
      // Inspect only the existing finite own-data diagnostic enum. Never read
      // an external error's message, prototype, getters, or serialization.
      let fixedCode=null;try{fixedCode=codeOf(err);}catch{}
      if(fixedCode==='NATIVE_PROVIDER_APPROVAL_REQUIRED')throw Object.assign(new NativeRuntimeError('NATIVE_PROVIDER_APPROVAL_REQUIRED','請先核准此 CLI 的登入檔、目的地與開發工具範圍。'),{
        status:409,notStarted:true,project:request.project,task:request.task,actor:request.actor,model:request.model,effort:request.effort});
      throw new NativeRuntimeError(fixedCode||SETUP_FAILURE_CODES[setupStage]);
    }
  }

  #prepare(provider) {
    return (rawRequest) => {
      const request = validateRequest(rawRequest);
      if (request.actor !== provider) fail('NATIVE_RUNTIME_INVALID', 'actor mismatch for handler');
      const key = reservationKey(request.actor, request.project, request.task);
      const reservation = this.#reservations.get(key);
      if (!reservation || !reservation.active || reservation.cancelled || !reservation.publicPlan) {
        fail('NATIVE_RUNTIME_REQUIRED', 'prepareTurn must be awaited before prepare');
      }
      const orig = reservation.originalRequest;
      if (orig.project !== request.project || orig.task !== request.task || orig.dir !== request.dir ||
          orig.model !== request.model || orig.effort !== request.effort || orig.rootFingerprint !== request.rootFingerprint) {
        fail('NATIVE_SCOPE_MISMATCH', 'request does not match prepared context');
      }
      return reservation.publicPlan;
    };
  }

  #openEndpoint(provider) {
    return (rawContext) => {
      rawContext=strictClone(rawContext);
      if (!isPlainObject(rawContext)) fail('NATIVE_RUNTIME_INVALID', 'invalid context');
      assertExactKeys(rawContext, ['actor', 'project', 'task', 'runId', 'dir', 'scope', 'args'], 'NATIVE_RUNTIME_INVALID');
      const actor = assertActor(rawContext.actor);
      if (actor !== provider) fail('NATIVE_RUNTIME_INVALID', 'actor mismatch for handler');
      const project = assertBoundedString(rawContext.project, 512);
      const task = assertBoundedString(rawContext.task, 512);
      const runId = assertSafeId(rawContext.runId, 256);
      const dir = assertBoundedString(rawContext.dir, 2048);
      const scopeClean = strictClone(rawContext.scope);
      const argsClean = strictClone(rawContext.args);
      if (!Array.isArray(argsClean) || !argsClean.every((a) => typeof a === 'string')) {
        fail('NATIVE_RUNTIME_INVALID', 'args must be array of strings');
      }

      const key = reservationKey(actor, project, task);
      const reservation = this.#reservations.get(key);
      if (!reservation || !reservation.active || reservation.cancelled || !reservation.publicPlan) {
        fail('NATIVE_RUNTIME_REQUIRED', 'no prepared context for endpoint');
      }
      if (reservation.dir !== dir) fail('NATIVE_SCOPE_MISMATCH', 'dir mismatch');
      if(reservation.runId!==runId)fail('NATIVE_SCOPE_MISMATCH','run mismatch');
      if (Object.keys(scopeClean).length!==Object.keys(reservation.scope).length||Object.keys(reservation.scope).some(k=>scopeClean[k]!==reservation.scope[k])) {
        fail('NATIVE_SCOPE_MISMATCH', 'scope mismatch');
      }
      if (this.#usedEndpoints.has(reservation.endpointMarker)) {
        fail('NATIVE_RUNTIME_INVALID', 'endpoint already consumed');
      }
      this.#usedEndpoints.add(reservation.endpointMarker);
      this.#clearStaleTimer(reservation);
      reservation.childActive = true;

      const launchOptions = {
        ...reservation.launchOptions,
        providerArgs: argsClean,
        proxyUrl: reservation.broker.proxyUrl,
        maxWallMs: reservation.maxWallMs
      };

      let nativeChild;
      try {
        nativeChild = this.#launch(launchOptions);
      } catch (err) {
        reservation.childActive = false;
        reservation.cleanupFailed=true;reservation.cancelled=true;
        reservation.uncertainChild=true;
        void this.#cleanup(reservation);
        throw new NativeRuntimeError('NATIVE_RUNTIME_INVALID', 'launch failed');
      }
      if (!nativeChild || typeof nativeChild.kill !== 'function'||typeof nativeChild.on!=='function'||!nativeChild.stdin||!nativeChild.stdout||!nativeChild.stderr||typeof nativeChild.backendId!=='string'||this.#claimedChildren.has(nativeChild)) {
        reservation.childActive = false;
        reservation.cleanupFailed=true;reservation.cancelled=true;
        reservation.uncertainChild=true;
        void this.#cleanup(reservation);
        fail('NATIVE_RUNTIME_INVALID', 'invalid native child');
      }
      this.#claimedChildren.add(nativeChild);

      const wrapper = new EndpointWrapper(nativeChild, nativeChild.backendId);
      reservation.nativeChild = nativeChild;
      reservation.wrapper = wrapper;

      let closed = false;
      nativeChild.on('spawn', (...a) => wrapper.emit('spawn', ...a));
      nativeChild.on('error', () => {
        wrapper.emit('error', new NativeRuntimeError('NATIVE_RUNTIME_INVALID', 'native process error'));
      });
      nativeChild.on('close', (code, signal) => {
        if (closed) return;
        closed = true;
        (async () => {
          const resourcesClosed=await this.#cleanup(reservation);
          const receipt = resourcesClosed ? validateCleanupReceipt(nativeChild.cleanupReceipt, code) : null;
          if (receipt) {
            wrapper.cleanupReceipt = receipt;
            reservation.childActive = false;
            this.#reservations.delete(key);
          } else {
            wrapper.cleanupReceipt = null;
            reservation.cleanupFailed = true;
          }
          wrapper.emit('close', code, signal);
        })();
      });

      return wrapper;
    };
  }

  handlers() {
    return Object.freeze({
      claude: Object.freeze({
        prepare: this.#prepare('claude'),
        openEndpoint: this.#openEndpoint('claude')
      }),
      grok: Object.freeze({
        prepare: this.#prepare('grok'),
        openEndpoint: this.#openEndpoint('grok')
      })
    });
  }

  async cancel(rawTarget) {
    rawTarget=strictClone(rawTarget);
    if (!isPlainObject(rawTarget)) fail('NATIVE_RUNTIME_INVALID', 'invalid cancel target');
    assertExactKeys(rawTarget, ['actor', 'project', 'task'], 'NATIVE_RUNTIME_INVALID');
    const actor = assertActor(rawTarget.actor);
    const project = assertBoundedString(rawTarget.project, 512);
    const task = assertBoundedString(rawTarget.task, 512);
    const key = reservationKey(actor, project, task);
    const reservation = this.#reservations.get(key);
    if (!reservation) return false;
    reservation.cancelled = true;
    this.#clearStaleTimer(reservation);

    if(reservation.uncertainChild){await this.#cleanup(reservation);fail('NATIVE_CLEANUP_REQUIRED');}

    if (reservation.childActive && reservation.wrapper) {
      try { reservation.wrapper.kill(); } catch { /* generic suppressed */ }
      return true;
    }

    if (!reservation.childActive && reservation.broker) {
      if(!await this.#cleanup(reservation)){reservation.cleanupFailed=true;throw new NativeRuntimeError('NATIVE_CLEANUP_REQUIRED');}
      if (this.#reservations.get(key) === reservation) this.#reservations.delete(key);
      return true;
    }

    return true;
  }

  active() {
    return this.#reservations.size;
  }
}

module.exports = { NativeProviderRuntime, NativeRuntimeError };
