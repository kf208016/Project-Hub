'use strict';
const fs = require('node:fs');
const DELAYS = [25, 50, 100, 200, 300, 400, 500];
const RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function attempt(action, opts = {}) {
  const delays = opts.delays ?? DELAYS, wait = opts.sleep ?? sleep;
  let attempts = 0;
  for (;;) {
    attempts++;
    try { return { value: action(), attempts }; }
    catch (cause) {
      if (!RETRY.has(cause.code) || attempts > delays.length) {
        throw Object.assign(new Error('檔案操作失敗'), { code: cause.code, attempts });
      }
      wait(delays[attempts - 1]);
    }
  }
}
function replaceSync(tmp, dest, opts) {
  try { return attempt(() => fs.renameSync(tmp, dest), opts).attempts; }
  catch (error) { try { fs.unlinkSync(tmp); } catch {} throw error; }
}
function openRetrySync(file, flags, opts) {
  return attempt(() => fs.openSync(file, flags), opts).value;
}
// Filesystem operations keep the synchronous descriptor API; retry waits yield
// to the event loop so workspace transactions do not stall other Hub requests.
async function attemptAsync(action, opts = {}) {
  const delays = opts.delays ?? DELAYS, wait = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let attempts = 0;
  for (;;) {
    attempts++;
    try { return { value: action(), attempts }; }
    catch (cause) {
      if (!RETRY.has(cause.code) || attempts > delays.length) {
        throw Object.assign(new Error('檔案替換失敗'), { code: cause.code, attempts });
      }
      await wait(delays[attempts - 1]);
    }
  }
}
async function replaceAsync(tmp, dest, opts) {
  try { return (await attemptAsync(() => fs.renameSync(tmp, dest), opts)).attempts; }
  catch (error) { try { fs.unlinkSync(tmp); } catch {} throw error; }
}
async function openRetryAsync(file, flags, opts) {
  return (await attemptAsync(() => fs.openSync(file, flags), opts)).value;
}
module.exports = { replaceSync, openRetrySync, replaceAsync, openRetryAsync };
