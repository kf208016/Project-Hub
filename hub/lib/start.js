'use strict';
// 始める欄の画像を手元に保存。元画像を残し、CLI用にPNGへ変換する。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;
const MAX = 50 * 1024 * 1024;
const dirOf = p => path.join(p.dir, '.ai', 'work', 'start-images');
const specFile = p => path.join(p.dir, '.ai', 'start-spec.json');
const specCache = new Map(); // 場所 → { key, value }（一覧のたびに読まないため）
function lastSpec(p) {
  const f = specFile(p);
  let st; try { st = fs.statSync(f); } catch { specCache.delete(f); return null; }
  const key = `${st.mtimeMs}:${st.size}`, hit = specCache.get(f);
  if (hit && hit.key === key) return hit.value;
  let value = null; try { value = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { value = null; }
  specCache.set(f, { key, value });
  return value;
}
function saveSpec(p, spec) { fs.mkdirSync(path.dirname(specFile(p)), { recursive: true }); fs.writeFileSync(specFile(p), JSON.stringify(spec)); }
function imageFile(p, id, preview = false) {
  if (!/^[a-f\d-]{36}\.(png|jpg|jpeg|webp|gif|heic)$/i.test(id)) throw Error('画像の指定が正しくありません');
  if (process.platform === 'win32' && (typeof id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.(png|jpg|jpeg|webp|gif|heic)$/i.test(id))) throw Error('圖片識別碼無效');
  return path.join(dirOf(p), preview && !/\.(png|jpe?g)$/i.test(id) ? id + '.png' : id);
}
function saveImage(p, name, data) {
  if (!IMAGE.test(name)) throw Error('画像は png／jpg／jpeg／webp／gif／heic に対応しています');
  if (process.platform === 'win32') return saveImageWindows(p, name, data);
  if (!data.length || data.length > MAX) throw Error('画像は1枚50MBまでです');
  const id = randomUUID() + path.extname(name).toLowerCase();
  const file = imageFile(p, id);
  fs.mkdirSync(dirOf(p), { recursive: true });
  fs.writeFileSync(file, data);
  if (!/\.(png|jpe?g)$/i.test(id)) {
    try { execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file, '--out', imageFile(p, id, true)], { timeout: 15000, stdio: 'pipe' }); }
    catch {
      // 失敗した一時コピーだけを片付ける。利用者の元画像には触らない。
      for (const temp of [file, imageFile(p, id, true)]) { try { fs.unlinkSync(temp); } catch { /* 未作成 */ } }
      throw Error('画像をPNGに変換できませんでした。画像を書き出し直して追加してください');
    }
  }
  return { id, name: /^hub-paste-/i.test(path.basename(name)) ? '貼り付け画像.png' : path.basename(name), url: '/api/start/image?project=' + encodeURIComponent(p.id) + '&id=' + id, path: imageFile(p, id, true) };
}
function imageFromPath(p, raw) {
  if (process.platform === 'win32') return imageFromPathWindows(p, raw);
  const file = fs.realpathSync(String(raw));
  const allowed = [os.homedir(), os.tmpdir(), '/private/tmp'].flatMap(x => { try { return [fs.realpathSync(x)]; } catch { return []; } });
  if (!allowed.some(x => file.startsWith(x + path.sep)) || !IMAGE.test(file)) throw Error('この場所の画像は追加できません');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX) throw Error('画像は1枚50MBまでです');
  return saveImage(p, path.basename(file), fs.readFileSync(file));
}
function copyImages(p, ids, dir, task) {
  if (process.platform === 'win32') return copyImagesWindows(p, ids, dir, task);
  if (!Array.isArray(ids) || ids.length > 10) throw Error('画像は1回10枚までです');
  const sources = ids.map(id => ({ id, file: imageFile(p, id), view: imageFile(p, id, true) }));
  for (const x of sources) if (!fs.existsSync(x.file) || !fs.existsSync(x.view)) throw Error('添付画像が見つかりません。追加し直してください');
  const dest = path.join(dir, 'attachments', task);
  if (ids.length) fs.mkdirSync(dest, { recursive: true });
  return sources.map(x => {
    const original = path.join(dest, x.id), image = x.file === x.view ? original : original + '.png';
    fs.copyFileSync(x.file, original);
    if (image !== original) fs.copyFileSync(x.view, image);
    return image;
  });
}
function inside(file, root) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function readWindowsFile(file, max = MAX) {
  const safe = require('./safe-path').localPath(file);
  const before = fs.lstatSync(safe);
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > max) throw Error('圖片檔案無效或超過大小上限');
  const fd = fs.openSync(safe, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error('圖片檔案已變更，請重新選取');
    require('./safe-path').localPath(safe);
    const data = Buffer.alloc(opened.size); let read = 0;
    while (read < data.length) { const n = fs.readSync(fd, data, read, data.length - read, read); if (!n) throw Error('圖片檔案讀取不完整'); read += n; }
    const after = fs.fstatSync(fd), current = fs.lstatSync(require('./safe-path').localPath(safe));
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino) throw Error('圖片檔案已變更，請重新選取');
    return data;
  } finally { fs.closeSync(fd); }
}
function writeWindowsFile(file, data, created) {
  const safe = require('./safe-path').localPath(file, { allowMissing: true });
  const fd = fs.openSync(safe, 'wx');
  try {
    const st = fs.fstatSync(fd); created.push({ file: safe, dev: st.dev, ino: st.ino });
    fs.writeFileSync(fd, data); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function rollbackWindowsFiles(created) {
  for (const item of created.reverse()) {
    try {
      const file = require('./safe-path').localPath(item.file), st = fs.lstatSync(file);
      if (st.isFile() && st.nlink === 1 && st.dev === item.dev && st.ino === item.ino) fs.unlinkSync(file);
    } catch { /* Only this operation's unchanged files may be removed. */ }
  }
}
function saveImageWindows(p, name, data) {
  if (typeof name !== 'string' || !IMAGE.test(name)) throw Error('不支援此圖片格式');
  const decoded = require('./windows-images').process(data, path.extname(name));
  const id = randomUUID() + path.extname(name).toLowerCase();
  const folder = require('./safe-path').localPath(dirOf(p), { allowMissing: true });
  fs.mkdirSync(folder, { recursive: true }); require('./safe-path').localPath(folder);
  const created = [];
  try {
    writeWindowsFile(imageFile(p, id), data, created);
    if (decoded.converted) writeWindowsFile(imageFile(p, id, true), decoded.converted, created);
  } catch (error) { rollbackWindowsFiles(created); throw error; }
  return { id, name: /^hub-paste-/i.test(path.basename(name)) ? '貼り付け画像.png' : path.basename(name), url: '/api/start/image?project=' + encodeURIComponent(p.id) + '&id=' + id, path: imageFile(p, id, true) };
}
function imageFromPathWindows(p, raw) {
  if (typeof raw !== 'string') throw Error('需要完整的本機圖片路徑');
  // Validate before realpath/stat/read so UNC and reparse paths never get probed.
  const file = require('./safe-path').localPath(raw);
  const allowed = [os.homedir(), os.tmpdir()].map(root => require('./safe-path').localPath(root));
  if (!allowed.some(root => inside(file, root)) || !IMAGE.test(file)) throw Error('無法加入此位置的圖片');
  return saveImageWindows(p, path.basename(file), readWindowsFile(file));
}
function copyImagesWindows(p, ids, dir, task) {
  if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) throw Error('圖片每次最多10張，不可重複');
  if (typeof task !== 'string' || !task || path.basename(task) !== task || task === '.' || task === '..') throw Error('作業名稱無效');
  const sources = ids.map(id => {
    const file = imageFile(p, id), view = imageFile(p, id, true);
    const data = readWindowsFile(file), decoded = require('./windows-images').process(data, path.extname(id));
    const preview = view === file ? null : readWindowsFile(view, 140 * 1024 * 1024);
    if (preview && !decoded.converted.equals(preview)) throw Error('圖片預覽與原檔不符，請重新加入');
    return { id, data, preview };
  });
  const dest = require('./safe-path').localPath(path.join(dir, 'attachments', task), { allowMissing: true });
  if (ids.length) { fs.mkdirSync(dest, { recursive: true }); require('./safe-path').localPath(dest); }
  const created = [], results = [];
  try {
    for (const x of sources) {
      const original = path.join(dest, x.id), image = x.preview ? original + '.png' : original;
      writeWindowsFile(original, x.data, created);
      if (x.preview) writeWindowsFile(image, x.preview, created);
      results.push(image);
    }
    return results;
  } catch (error) { rollbackWindowsFiles(created); throw error; }
}
function imagePrompt(ai, text, images) {
  return images.length ? text + '\n\n参照画像（絶対パス）：\n' + images.join('\n') + '\n' + (ai === 'claude' ? 'これらの画像を Read で見てから始める。' : ai === 'agy' ? 'これらの画像を読み、内容を確認してから始める。' : '添付画像を確認してから始める。') : text;
}
module.exports = { IMAGE, MAX, lastSpec, saveSpec, imageFile, saveImage, imageFromPath, copyImages, imagePrompt };
