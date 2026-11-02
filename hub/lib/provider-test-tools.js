'use strict';
/**
 * provider-test-tools.js
 * Minimal synthetic Claude/Grok MCP stdio acceptance server.
 * NOT a general purpose execution tool. Single tool: verify_add.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ERRORS = Object.freeze({
  BAD_ROOT: 'E_BAD_ROOT',
  BAD_SOURCE: 'E_BAD_SOURCE',
  BAD_STAGE: 'E_BAD_STAGE',
  BAD_ARGS: 'E_BAD_ARGS',
  SPAWN_FAILED: 'E_SPAWN_FAILED',
  TIMEOUT: 'E_TIMEOUT',
  NONZERO_EXIT: 'E_NONZERO_EXIT',
  INTERNAL: 'E_INTERNAL'
});

const MAX_SOURCE_BYTES = 1024;
const MAX_OUTPUT_BYTES = 8192;
const SPAWN_TIMEOUT_MS = 3000;
const MAX_FRAME_BYTES = 65536;
const MAX_FRAMES = 128;
const MAX_QUEUE_CONCURRENCY = 4;

const ENV_ALLOWLIST = [
  'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
];

// Fixed trusted programs. The model-supplied source is only used to decide
// WHICH fixed, immutable trusted program is executed; the source itself is
// never eval'd or passed to the child process.
const STAGE_PROGRAMS = Object.freeze({
  1: 'const f=(a,b)=>a+b; if(f(2,3)!==5){process.exit(1);} process.exit(0);',
  2: 'const f=(a,b)=>a+b+1; if(f(2,3)!==6){process.exit(1);} process.exit(0);'
});

const STAGE_CANONICAL = Object.freeze({
  1: ['module.exports=(a,b)=>a+b;', 'module.exports=(a,b)=>a+b'],
  2: ['module.exports=(a,b)=>a+b+1;', 'module.exports=(a,b)=>a+b+1']
});

function fail(code, extra) {
  const e = new Error(code);
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

function isWindows() {
  return process.platform === 'win32';
}

function normCase(p) {
  return isWindows() ? p.toLowerCase() : p;
}

/**
 * Validate that `rootPath` is an absolute, local, non-UNC, existing
 * directory with no symlink/junction ancestors, and is not a filesystem
 * root or the user's home/profile directory.
 */
function validateRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw fail(ERRORS.BAD_ROOT);
  }
  if (!path.isAbsolute(rootPath)) throw fail(ERRORS.BAD_ROOT);
  try {require('./safe-path').localPath(rootPath);}catch{throw fail(ERRORS.BAD_ROOT);}
  if (isWindows() && /^\\\\/.test(rootPath)) throw fail(ERRORS.BAD_ROOT); // UNC

  const resolved = path.resolve(rootPath);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) throw fail(ERRORS.BAD_ROOT); // drive/fs root

  let home;
  try { home = os.homedir(); } catch (_e) { home = null; }
  if (home && normCase(path.resolve(home)) === normCase(resolved)) {
    throw fail(ERRORS.BAD_ROOT); // profile root
  }

  let st;
  try {
    st = fs.lstatSync(resolved);
  } catch (_e) {
    throw fail(ERRORS.BAD_ROOT);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw fail(ERRORS.BAD_ROOT);

  let real;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (_e) {
    throw fail(ERRORS.BAD_ROOT);
  }
  if (normCase(path.resolve(real)) !== normCase(resolved)) throw fail(ERRORS.BAD_ROOT);

  // Walk ancestors (excluding fs root) checking for symlink/junction.
  let cur = resolved;
  const seen = new Set();
  while (true) {
    const p = path.parse(cur);
    if (cur === p.root) break;
    if (seen.has(normCase(cur))) break;
    seen.add(normCase(cur));
    let lst;
    try {
      lst = fs.lstatSync(cur);
    } catch (_e) {
      throw fail(ERRORS.BAD_ROOT);
    }
    if (lst.isSymbolicLink()) throw fail(ERRORS.BAD_ROOT);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return resolved;
}

function bufferHasInvalidUtf8(buf) {
  const str = buf.toString('utf8');
  const roundTrip = Buffer.from(str, 'utf8');
  if (!roundTrip.equals(buf)) return true;
  if (/[\uD800-\uDFFF]/.test(str)) {
    // Lone surrogate check: a valid surrogate pair is fine, but any lone one is not.
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const n = str.charCodeAt(i + 1);
        if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;
        i++;
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        return true;
      }
    }
  }
  return false;
}

function canonicalizeSource(buf) {
  if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) throw fail(ERRORS.BAD_SOURCE);
  if (buf.includes(0x00)) throw fail(ERRORS.BAD_SOURCE);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    throw fail(ERRORS.BAD_SOURCE); // BOM
  }
  if (bufferHasInvalidUtf8(buf)) throw fail(ERRORS.BAD_SOURCE);
  const str = buf.toString('utf8');
  const canonical = str.replace(/[ \t\r\n]/g, '');
  return canonical;
}

function detectStage(canonical) {
  for (const stage of [1, 2]) {
    if (STAGE_CANONICAL[stage].includes(canonical)) return stage;
  }
  return null;
}

function buildChildEnv() {
  const env = {};
  for (const k of ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) {
      env[k] = process.env[k];
    }
  }
  return env;
}

/**
 * Build the exact spawn plan (argv/env/cwd/options) without executing it.
 * Exposed for tests so assertions never need to bypass validation.
 */
function createPlan(root, stage) {
  if (stage !== 1 && stage !== 2) throw fail(ERRORS.BAD_STAGE);
  return {
    command: process.execPath,
    args: ['-e', STAGE_PROGRAMS[stage]],
    options: {
      cwd: root,
      env: buildChildEnv(),
      shell: false,
      windowsHide: true
    }
  };
}

function runPlan(plan) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.command, plan.args, plan.options);
    } catch (_e) {
      resolve({ error: ERRORS.SPAWN_FAILED });
      return;
    }
    let out = Buffer.alloc(0);
    let killedForTimeout = false;
    let settled = false;
    const timer = setTimeout(() => {
      killedForTimeout = true;
      try { child.kill('SIGKILL'); } catch (_e) { /* ignore */ }
    }, SPAWN_TIMEOUT_MS);

    function appendOut(chunk) {
      if (out.length >= MAX_OUTPUT_BYTES) return;
      const remaining = MAX_OUTPUT_BYTES - out.length;
      out = Buffer.concat([out, chunk.slice(0, remaining)]);
    }
    if (child.stdout) child.stdout.on('data', appendOut);
    if (child.stderr) child.stderr.on('data', appendOut);

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: ERRORS.SPAWN_FAILED });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killedForTimeout || signal) {
        resolve({ error: ERRORS.TIMEOUT, output: out });
        return;
      }
      resolve({ exitCode: code, output: out });
    });
  });
}

/**
 * verify(root, args) - full pipeline: read fixed root/add.js, validate
 * canonical source against stage grammar, run the fixed trusted assertion
 * program, return a JSON-safe summary. Never leaks raw filesystem paths.
 */
async function verify(root, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail(ERRORS.BAD_ARGS);
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'stage') throw fail(ERRORS.BAD_ARGS);
  const stage = args.stage;
  if (!(stage === 1 || stage === 2) || typeof stage !== 'number' || !Number.isInteger(stage)) {
    throw fail(ERRORS.BAD_STAGE);
  }

  const resolvedRoot = validateRoot(root);

  const addFile = path.join(resolvedRoot, 'add.js');
  let lst;
  try {
    lst = fs.lstatSync(addFile);
  } catch (_e) {
    throw fail(ERRORS.BAD_SOURCE);
  }
  if (lst.isSymbolicLink()||!lst.isFile()||lst.size>MAX_SOURCE_BYTES) throw fail(ERRORS.BAD_SOURCE);

  let buf;
  try {
    buf = fs.readFileSync(addFile);
  } catch (_e) {
    throw fail(ERRORS.BAD_SOURCE);
  }

  const canonical = canonicalizeSource(buf);
  const detected = detectStage(canonical);
  if (detected === null || detected !== stage) {
    throw fail(ERRORS.BAD_SOURCE);
  }

  const sourceSHA256 = crypto.createHash('sha256').update(buf).digest('hex');
  const plan = createPlan(resolvedRoot, stage);
  const result = await runPlan(plan);

  if (result.error) {
    return {
      synthetic: true,
      stage,
      sourceSHA256,
      exitCode: null,
      passed: false,
      outcome: result.error
    };
  }

  const passed = result.exitCode === 0;
  return {
    synthetic: true,
    stage,
    sourceSHA256,
    exitCode: result.exitCode,
    passed,
    outcome: passed ? 'OK' : ERRORS.NONZERO_EXIT
  };
}

function parseStrictJSON(text) {
  try{return require('./providers/claude-protocol').decode(Buffer.from(text,'utf8'),{maxFrameBytes:65536,maxStringBytes:32768,maxDepth:16,maxNodes:4096});}
  catch{throw fail(ERRORS.BAD_ARGS);}
}

// ---- JSON-RPC2 newline-delimited stdio server ----

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

function safeSummary(obj) {
  try {
    return JSON.stringify(obj);
  } catch (_e) {
    return '{"error":"' + ERRORS.INTERNAL + '"}';
  }
}

function isValidId(id) {
  if (typeof id === 'string') return id.length > 0 && id.length <= 128;
  if (typeof id === 'number') return Number.isSafeInteger(id) && id >= 0;
  return false;
}

function makeResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function makeError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
}

function runServer(root, input, output) {
  const resolvedRoot=validateRoot(root);
  let initialized=false,ready=false,buffer=Buffer.alloc(0),count=0,ended=false,active=false,outputEnded=false;
  const queue=[],seenIds=new Set();
  const send=row=>{if(!outputEnded)output.write(JSON.stringify(row)+'\n');};
  const error=(id,code,message)=>send({jsonrpc:'2.0',id:id??null,error:{code,message}});
  const result=(id,value)=>send({jsonrpc:'2.0',id,result:value});
  const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
  const finish=()=>{if(ended&&!active&&!queue.length&&!outputEnded){outputEnded=true;output.end();}};
  function stop(){ended=true;queue.length=0;input.pause();finish();}
  async function drain(){
    if(active||!queue.length){finish();return;}
    active=true;const {id,args}=queue.shift();
    try {const value=await verify(resolvedRoot,args);result(id,{content:[{type:'text',text:JSON.stringify(value)}],isError:!value.passed});}
    catch(e){result(id,{content:[{type:'text',text:JSON.stringify({synthetic:true,passed:false,outcome:Object.values(ERRORS).includes(e?.code)?e.code:ERRORS.INTERNAL})}],isError:true});}
    finally{active=false;drain();}
  }
  function handle(req){
    if(!plain(req)||req.jsonrpc!=='2.0'||typeof req.method!=='string'||Object.keys(req).some(k=>!['jsonrpc','id','method','params'].includes(k))){error(null,-32600,'invalid request');return;}
    const hasId=Object.hasOwn(req,'id'),id=req.id;
    if(hasId){
      if(!isValidId(id)){error(null,-32600,'invalid id');return;}
      const key=typeof id+':'+id;if(seenIds.has(key)){error(id,-32600,'duplicate id');return;}seenIds.add(key);
    }
    if(req.method==='notifications/initialized'){
      if(hasId||!initialized){error(null,-32600,'invalid state');return;}ready=true;return;
    }
    if(!hasId)return;
    if(req.method==='initialize'){
      if(initialized){error(id,-32600,'already initialized');return;}
      if(!plain(req.params)||typeof req.params.protocolVersion!=='string'){error(id,-32602,'invalid params');return;}
      const protocolVersion=PROTOCOL_VERSIONS.includes(req.params.protocolVersion)?req.params.protocolVersion:PROTOCOL_VERSIONS.at(-1);
      initialized=true;result(id,{protocolVersion,capabilities:{tools:{listChanged:false}},serverInfo:{name:'project-hub-synthetic-test',version:'1.0.0'}});return;
    }
    if(req.method==='ping'){result(id,{});return;}
    if(!ready){error(id,-32600,'not initialized');return;}
    if(req.method==='tools/list'){
      result(id,{tools:[{name:'verify_add',description:'Synthetic source whitelist and fixed trusted arithmetic assertion; no arbitrary code or shell execution.',inputSchema:{type:'object',properties:{stage:{type:'integer',enum:[1,2]}},required:['stage'],additionalProperties:false}}]});return;
    }
    if(req.method==='tools/call'){
      const p=req.params,args=p?.arguments;
      if(!plain(p)||p.name!=='verify_add'||Object.keys(p).some(k=>!['name','arguments','_meta'].includes(k))||!plain(args)||Object.keys(args).length!==1||![1,2].includes(args.stage)||typeof args.stage!=='number'){error(id,-32602,'invalid args');return;}
      if(queue.length+(active?1:0)>=MAX_QUEUE_CONCURRENCY){error(id,-32000,'request limit');return;}
      queue.push({id,args:{stage:args.stage}});drain();return;
    }
    error(id,-32601,'unknown method');
  }
  input.on('data',chunk=>{
    if(ended)return;
    buffer=Buffer.concat([buffer,chunk]);
    let at;
    while(!ended&&(at=buffer.indexOf(10))!==-1){
      let line=buffer.subarray(0,at);buffer=buffer.subarray(at+1);
      if(line.at(-1)===13)line=line.subarray(0,-1);
      if(!line.length)continue;
      if(line.length>MAX_FRAME_BYTES||++count>MAX_FRAMES){error(null,-32600,'frame limit');stop();return;}
      try {handle(require('./providers/claude-protocol').decode(line,{maxFrameBytes:65536,maxStringBytes:32768,maxDepth:16,maxNodes:4096}));}
      catch{error(null,-32700,'invalid frame');stop();return;}
    }
    if(buffer.length>MAX_FRAME_BYTES){error(null,-32600,'frame limit');stop();}
  });
  input.on('end',()=>{if(buffer.length)error(null,-32700,'truncated frame');ended=true;finish();});
  input.on('error',stop);output.on('error',()=>{outputEnded=true;stop();});
  return {stop};
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    process.stderr.write(ERRORS.BAD_ARGS + '\n');
    process.exit(1);
    return;
  }
  let root;
  try {
    root = validateRoot(argv[0]);
  } catch (_e) {
    process.stderr.write(ERRORS.BAD_ROOT + '\n');
    process.exit(1);
    return;
  }
  runServer(root, process.stdin, process.stdout);
}

if (require.main === module) {
  main();
}

module.exports = {
  verify,
  validateRoot,
  createPlan,
  runServer,
  parseStrictJSON,
  STAGE_PROGRAMS,
  ERRORS
};
