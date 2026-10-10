'use strict';
// Controller-only process lock. NTFS writers separately enforce file identity
// and content CAS; this lock is not a filesystem security boundary.
const path = require('node:path');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const held = new Map(), retained = new Map(), context = new AsyncLocalStorage();
const canonical = value => {let full=path.resolve(value);try{full=fs.realpathSync.native(full);}catch{}return process.platform==='win32'?full.toLowerCase():full;};
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const error = () => Object.assign(Error('此專案正在保存網頁交接交易，請等待完成或復原後再變更'), {status:409, code:'HANDOFF_WRITE_BUSY'});
function blocked(root) {
  const dir = canonical(root), current = context.getStore();
  return [...held.values()].some(entry => entry !== current && (within(entry.dir, dir) || within(dir, entry.dir))) || [...retained.values()].some(entry=>(within(entry.dir,dir)||within(dir,entry.dir))&&!(current?.dir===entry.dir&&current?.task===entry.task&&current?.receiptId===entry.receiptId));
}
function assertPathWritable(file) {
  const target = canonical(file), current = context.getStore();
  if ([...held.values()].some(entry => entry !== current && within(entry.dir, target)) || [...retained.values()].some(entry=>within(entry.dir,target)&&!(current?.dir===entry.dir&&current?.task===entry.task&&current?.receiptId===entry.receiptId))) throw error();
}
function hold(root,task,receiptId){
  if(typeof receiptId!=='string'||!/^[a-f0-9-]{36}$/.test(receiptId))throw Object.assign(Error('持久交接鎖缺少收據'),{status:409,code:'HANDOFF_HOLD_INVALID'});
  const dir=canonical(root),key=dir+'\0'+task+'\0'+receiptId;
  retained.set(key,Object.freeze({dir,task,receiptId}));return key;
}
function release(root,task,receiptId){retained.delete(canonical(root)+'\0'+task+'\0'+receiptId);}
async function run(root, task, operation, {receiptId}={}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof task !== 'string' || !task || /[\\/\0]/.test(task) || typeof operation !== 'function') throw Object.assign(Error('交接鎖範圍無效'), {status:400,code:'HANDOFF_LOCK_INVALID'});
  const dir = canonical(root), key = dir + '\0' + task;
  // A project note is shared by all tasks, so concurrent handoffs in the same
  // project are rejected too. No untrusted request may supply this context.
  if (held.has(key) || [...held.values()].some(entry => within(entry.dir,dir) || within(dir,entry.dir))) throw error();
  if([...retained.values()].some(entry=>(within(entry.dir,dir)||within(dir,entry.dir))&&!(entry.dir===dir&&entry.task===task&&entry.receiptId===receiptId)))throw error();
  const entry = Object.freeze({dir,task,key,receiptId}); held.set(key,entry);
  try { return await context.run(entry,operation); }
  finally { if (held.get(key) === entry) held.delete(key); }
}
module.exports = {run,hold,release,blocked,assertPathWritable,active:()=>held.size>0,pending:()=>[...retained.values()]};
