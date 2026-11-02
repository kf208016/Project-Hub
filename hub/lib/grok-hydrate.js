'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {runIcacls} = require('./grok-credential-acl');
const absolute = value => typeof value === 'string' && /^[A-Za-z]:\\[^"%^&|<>!\r\n]+$/.test(value);
const inside = (parent, child) => {
  const relative = path.win32.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative);
};
function regular(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw Error('INVALID');
  return st;
}
function createRestoreInheritance({systemRoot = process.env.SystemRoot || 'C:\\Windows', run = runIcacls} = {}) {
  return async file => {
    const result = await run(path.win32.join(systemRoot, 'System32', 'icacls.exe'),
      [file, '/inheritance:e', '/Q'], {timeoutMs: 10000});
    return result.status === 0 && !result.timedOut;
  };
}
function createGrokHydrator({resolveGrok, spawn, nodeFile, hubLibDirectory, env, record = () => {}, now = Date.now,
  systemRoot = process.env.SystemRoot || 'C:\\Windows', run: runAcl = runIcacls,
  restoreInheritance = createRestoreInheritance({systemRoot, run: runAcl}),
  setTimeout: schedule = global.setTimeout, clearTimeout: unschedule = global.clearTimeout, kill}) {
  const flights = new Map();
  let disposed = false;
  function result(startedAt, outcome = 'failed', timedOut = false, exitCode = null, acl = null) {
    const value = Object.freeze({outcome, timedOut, exitCode, durationMs: Math.max(0, now() - startedAt), acl});
    try { record('grok-hydrate', {...value}); } catch { /* Diagnostics cannot change the result. */ }
    return value;
  }
  function hydrate(options) {
    const startedAt = now();
    let providerHome, authPath, lockPath, runtimeDirectory, hydrateHome;
    try {
      ({providerHome, authPath, lockPath, runtimeDirectory} = options);
      hydrateHome = path.win32.join(runtimeDirectory, 'grok-hydrate');
      if (disposed || ![providerHome, authPath, lockPath, runtimeDirectory].every(absolute) ||
          authPath !== providerHome + '\\auth.json' || lockPath !== authPath + '.lock' || !inside(runtimeDirectory, providerHome) ||
          providerHome.toLowerCase() === hydrateHome.toLowerCase() || inside(providerHome, hydrateHome)) throw Error('INVALID');
    } catch { return Promise.resolve(result(startedAt)); }
    if (flights.has(providerHome)) return flights.get(providerHome).promise;
    const run = {startedAt, child: null, done: false, killed: false};
    run.promise = new Promise(resolve => { run.resolve = resolve; });
    run.finish = (outcome = 'failed', timedOut = false, exitCode = null, acl = null) => {
      if (run.done) return;
      run.done = true;
      if (run.timer !== undefined) unschedule(run.timer);
      flights.delete(providerHome);
      run.resolve(result(startedAt, outcome, timedOut, exitCode, acl));
    };
    run.stop = (timedOut = false) => {
      if (run.done) return;
      // Settle before killing: a synchronous exit event must not win the deadline.
      run.finish('failed', timedOut);
      if (run.child?.pid && !run.killed) {
        run.killed = true;
        try { kill(run.child.pid); } catch { /* Remain failed. */ }
      }
    };
    flights.set(providerHome, run);
    void (async () => {
      try {
        fs.mkdirSync(providerHome, {recursive: true});
        fs.mkdirSync(hydrateHome, {recursive: true});
        for (const file of [authPath, lockPath]) {
          try { regular(file); fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const file = await resolveGrok();
        if (run.done || disposed) return;
        if (typeof file !== 'string' || !/^[A-Za-z]:\\[^"%^&|<>!\r\n]+\\grok\.exe$/i.test(file)) throw Error('INVALID');
        const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
          !/^(PROJECT_HUB_|HUB_|GROK_AUTH)/i.test(key) && !/^(GROK_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|GROK_AUTH_EARLY_INVALIDATION_SECS)$/i.test(key)));
        const parentPath = cleanEnv.PATH || cleanEnv.Path || cleanEnv.path || '';
        Object.assign(cleanEnv, {
          GROK_HOME: hydrateHome, GROK_AUTH_PATH: authPath,
          GROK_AUTH_PROVIDER_COMMAND: 'grok-auth-helper-owner.cmd',
          PATH: [hubLibDirectory, parentPath].filter(Boolean).join(';'),
          HUB_NODE: nodeFile, GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0',
          DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1'
        });
        for (const key of Object.keys(cleanEnv)) {
          if (key !== 'PATH' && key.toLowerCase() === 'path') delete cleanEnv[key];
        }
        run.child = spawn(file, ['login', '--device-auth'], {cwd: hydrateHome, env: cleanEnv, windowsHide: true, stdio: 'ignore'});
        run.child.once('error', () => run.stop());
        run.child.once('exit', async code => {
          if (run.done) return;
          const exitCode = Number.isInteger(code) ? code : null;
          let acl = null;
          try {
            if (exitCode !== 0) throw Error('FAILED');
            const st = regular(authPath);
            if (st.size <= 0 || st.mtimeMs < startedAt - 1000) throw Error('INVALID');
            try { regular(lockPath); } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              fs.writeFileSync(lockPath, '', {flag: 'wx'});
            }
            regular(lockPath);
            acl = 'failed';
            if (await restoreInheritance(authPath) !== true) throw Error('ACL_FAILED');
            if (run.done) return;
            regular(lockPath);
            if (await restoreInheritance(lockPath) !== true) throw Error('ACL_FAILED');
            if (run.done) return;
            run.finish('hydrated', false, exitCode, 'inherited');
          } catch { run.finish('failed', false, exitCode, acl); }
        });
        run.timer = schedule(() => run.stop(true), 20000);
      } catch { run.stop(); }
    })();
    return run.promise;
  }
  function dispose() {
    disposed = true;
    for (const run of [...flights.values()]) run.stop();
  }
  return Object.freeze({hydrate, dispose});
}
module.exports = {createGrokHydrator, createRestoreInheritance};
