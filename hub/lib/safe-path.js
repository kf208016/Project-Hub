'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Validate each existing ancestor, including the target. Do not resolve through
// junctions/symlinks and then silently approve a different physical location.
function checkedPath(value, { allowMissing = false } = {}, directories = null) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw Error('需要完整的本機絕對路徑');
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')) throw Error('不接受網路、裝置或 ADS 路徑');
    for (const part of value.slice(3).split(/[\\/]/)) {
      if (part === '.' || part === '..' || /[. ]$|[<>"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw Error('路徑含有不允許的名稱');
    }
    require('./local-drives').assertLocalDrive(value);
  }
  const resolved = path.resolve(value), root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (directories?.has(current) && current !== resolved) continue;
    let st;
    try { st = fs.lstatSync(current); }
    catch (e) { if (allowMissing && e.code === 'ENOENT') return resolved; throw e; }
    if (st.isSymbolicLink()) throw Error('路徑包含 symlink 或 junction，請選擇實際位置');
    const physical = fs.realpathSync(current);
    if ((process.platform === 'win32' ? physical.toLowerCase() !== current.toLowerCase() : physical !== current)) throw Error('路徑的實際位置不符');
    if (directories && st.isDirectory()) directories.add(current);
  }
  return resolved;
}
function localPath(value, options) { return checkedPath(value, options); }
function localPathPass() { const directories=new Set();return (value,options)=>checkedPath(value,options,directories); }
function localTree(value, { maxEntries = 20000 } = {}) {
  const root=localPath(value), pending=[root]; let count=0;
  while(pending.length) {
    const file=pending.pop();
    if(++count>maxEntries)throw Error('路徑項目超過驗證上限，未移動任何檔案');
    const st=fs.lstatSync(file);
    if(st.isSymbolicLink() || (!st.isDirectory()&&!st.isFile()))throw Error('路徑樹包含連結或特殊檔案，未移動任何檔案');
    if(st.isDirectory())for(const name of fs.readdirSync(file))pending.push(path.join(file,name));
  }
  return root;
}
module.exports = { localPath, localTree, localPathPass };
