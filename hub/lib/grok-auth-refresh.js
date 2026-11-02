'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const safe = require('./safe-path');
const {createGrokAuthRefreshPlan} = require('./provider-native-plan');
const host = require('./provider-native-host');
// Grok 1.0.70 refreshes only an expired token (about 6 h), right after start.
// A valid token makes no auth.x.ai connection, so a quiet start ends early.
const DEFAULT_STALE_MS = 5 * 60 * 60 * 1000;
const CLEANUP_MS = 5000;

function parseStaleAfterMs(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return DEFAULT_STALE_MS;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 60000 && n <= 21600000 ? n : DEFAULT_STALE_MS;
}
function fail(code) { throw Object.assign(Error(code), {code}); }
function metadata(file) {
  try {
    const s = fs.lstatSync(file);
    return {type:s.isSymbolicLink()?'link':s.isFile()?'file':s.isDirectory()?'directory':'other',
      size:s.size,mtimeMs:s.mtimeMs,birthtimeMs:s.birthtimeMs,ino:String(s.ino),dev:String(s.dev)};
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function snapshot(tree) {
  safe.localPath(tree);
  const entries = new Map();
  for (const name of fs.readdirSync(tree).sort()) entries.set(name, metadata(path.join(tree,name)));
  return entries;
}
function receiptValid(receipt, code) {
  if (!Number.isSafeInteger(code) || !receipt || ![Object.prototype,null].includes(Object.getPrototypeOf(receipt))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(receipt);
  if (Reflect.ownKeys(descriptors).some(k => typeof k !== 'string' || !Object.hasOwn(descriptors[k],'value'))) return false;
  return receipt.cleanupVerified === true && receipt.rootExited === true && receipt.ownedTreeEmpty === true && receipt.exitCode === code;
}
function bounded(promise, ms, code) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(code),{code})),ms);})])
    .finally(()=>clearTimeout(timer));
}

function createGrokAuthRefresher({profile,identity,supervisedSpawn,createBroker,
  launch = host.launchGrokAuthRefresh,record = ()=>{},now = Date.now,
  staleAfterMs = DEFAULT_STALE_MS,timeoutMs = 20000,settleMs = 1500,quietMs = 10000,quietWindowMs = 15 * 60 * 1000}) {
  let flight = null, quietAt = null;
  // No credential content is ever opened, hashed, buffered or returned here.
  const authTree = () => path.join(os.homedir(),'.grok');
  async function run(trigger) {
    const started = now();
    let broker, child, before, tree, closePromise, closed = false, closeCode;
    let result = 'failed', code, integrity = 'ok', changed = [];
    let timer, deadline, outputBytes = 0, stopObservation, processFailed = false, sawAuthConnect = false, quiet = false;
    try {
      tree = authTree();
      before = snapshot(tree);
      // The broker requires a synchronous, non-throwing audit hook; it only observes.
      const onAudit = event => { if (event?.event === 'accepted-connect' && event.hostname === 'auth.x.ai') sawAuthConnect = true; return true; };
      broker = await createBroker({provider:'grok-auth',maxWallMs:timeoutMs+10000,onAudit});
      if (!broker || typeof broker.close !== 'function') fail('NATIVE_RUNTIME_INVALID');
      const settings = await profile('grok',{identity});
      if (path.resolve(settings.ownerHome).toLowerCase() !== path.resolve(os.homedir()).toLowerCase()) fail('NATIVE_PATH_INVALID');
      const options = Object.fromEntries(['ownerHome','runtimeBase','providerFile','codexFile','codexSHA256','nodeFile','systemRoot'].map(k=>[k,settings[k]]));
      options.proxyUrl = broker.proxyUrl;
      // Validate all paths before creating the private cwd whose physical identity is pinned.
      const draft = createGrokAuthRefreshPlan({...options,rootFingerprint:'0'.repeat(64)});
      safe.localPath(draft.cwd,{allowMissing:true});
      fs.mkdirSync(draft.cwd,{recursive:true});
      safe.localPath(draft.cwd);
      options.rootFingerprint = (await identity(draft.cwd)).rootFingerprint;
      child = launch(options,supervisedSpawn);
      if (!child || typeof child.kill !== 'function' || typeof child.once !== 'function' ||
          !child.stdin || !child.stdout || !child.stderr) fail('NATIVE_ENDPOINT_INVALID');
      closePromise = new Promise(resolve => child.once('close',exitCode=>{
        closed=true; closeCode=exitCode; resolve(); stopObservation?.();
      }));
      child.on('error',()=>{processFailed=true;stopObservation?.();});
      child.stdin.on('error',()=>{processFailed=true;stopObservation?.();});
      const discard = chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 4*1024*1024) { processFailed=true; stopObservation?.(); }
      };
      for (const stream of [child.stdout,child.stderr]) {
        stream.on('error',()=>{processFailed=true;stopObservation?.();});
        stream.on('data',discard);
      }
      // Intentionally leave stdin open and empty: no initialization or prompt.
      let last = before.get('auth.json') || null, stableAt = now();
      const spawnedAt = now();
      await new Promise(resolve => {
        stopObservation=resolve;
        const poll=()=>{
          try {
            const current=metadata(path.join(tree,'auth.json'));
            if (!equal(current,last)) { last=current; stableAt=now(); }
            if (current?.type==='file' && !equal(current,before.get('auth.json')||null) && now()-stableAt>=settleMs) resolve();
            else if (!sawAuthConnect && equal(current,before.get('auth.json')||null) && now()-spawnedAt>=quietMs) { quiet=true; resolve(); }
          } catch { processFailed=true; resolve(); }
        };
        timer=setInterval(poll,200);
        deadline=setTimeout(resolve,timeoutMs);
        if (closed || processFailed) resolve();
      });
      if (processFailed) fail('NATIVE_REFRESH_FAILED');
      result='unchanged';
    } catch { code='NATIVE_REFRESH_FAILED'; }
    finally {
      clearInterval(timer); clearTimeout(deadline); stopObservation=null;
      if (child) {
        try {
          child.kill();
          if (!closePromise) fail('NATIVE_CLEANUP_UNVERIFIED');
          await bounded(closePromise,CLEANUP_MS,'NATIVE_CLEANUP_UNVERIFIED');
          if (!receiptValid(child.cleanupReceipt,closeCode)) fail('NATIVE_CLEANUP_UNVERIFIED');
        } catch { result='failed'; code='NATIVE_CLEANUP_UNVERIFIED'; }
      }
      if (broker) {
        try { await bounded(Promise.resolve().then(()=>broker.close()),CLEANUP_MS,'NATIVE_REFRESH_FAILED'); }
        catch { result='failed'; code='NATIVE_REFRESH_FAILED'; }
      }
      if (before) {
        try {
          const after=snapshot(tree);
          changed=[...new Set([...before.keys(),...after.keys()])].filter(name=>
            name!=='auth.json' && name!=='auth.json.lock' && !equal(before.get(name),after.get(name))).sort();
          integrity=changed.length?'changed':'ok';
          const auth=after.get('auth.json');
          if (result!=='failed' && auth?.type==='file' && !equal(before.get('auth.json'),auth)) result='refreshed';
        } catch { result='failed'; code='NATIVE_REFRESH_FAILED'; }
      }
    }
    quiet = quiet && result === 'unchanged';
    quietAt = quiet ? now() : result === 'refreshed' ? null : quietAt;
    try { await record('grok-auth-refresh',{}, {trigger,result,ms:Math.max(0,now()-started),integrity,changed,...(quiet?{quiet:true}:{}),...(code?{code}:{})}); }
    catch { return 'failed'; }
    return result;
  }
  function refresh(options = {}) {
    if (flight) return flight;
    flight=Promise.resolve().then(()=>run(options.trigger==='auth-failure'?'auth-failure':'stale')).catch(()=>'failed')
      .finally(()=>{flight=null;});
    return flight;
  }
  async function ensureFresh() {
    try {
      if (flight) return await flight;
      const stat=metadata(path.join(authTree(),'auth.json'));
      if (!stat) return 'missing';
      if (stat.type!=='file') return 'failed';
      if (now()-stat.mtimeMs<staleAfterMs) return 'fresh';
      // A quiet start proved the token still valid; an expiry inside this window
      // is caught by the turn's auth-failure retry, which always runs refresh().
      if (quietAt!==null && now()-quietAt<quietWindowMs) return 'fresh';
      return await refresh({trigger:'stale'});
    } catch { return 'failed'; }
  }
  return Object.freeze({ensureFresh,refresh});
}
module.exports={createGrokAuthRefresher,parseStaleAfterMs};
