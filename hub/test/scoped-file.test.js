'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const broker = require('../lib/scoped-file');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-nt-file-')), root = path.join(dir, 'root'), outside = path.join(dir, 'outside'), cleanup=[]; fs.mkdirSync(root); fs.mkdirSync(outside); t.after(async () => {for(const close of cleanup.reverse())await close();fs.rmSync(dir,{recursive:true,force:true});}); return { dir, root, outside, cleanup }; }
const deny = operation => assert.rejects(operation, error => [400,403,404,409,415].includes(error.status));

test('Native file broker gates the tested AMD64 Windows build and reads/creates real fixture files', async t => {
  if (process.platform !== 'win32' || process.arch !== 'x64' || os.release() !== '10.0.26200') { await deny(broker.probe()); return; }
  const { root } = fixture(t); assert.deepEqual(await broker.probe(), { supported: true, build: 26200, architecture: 'native-amd64', overwrite: true, ok: true });
  const text = '臺灣 UTF-8 🐈\n'.repeat(3000), created = await broker.create(root, 'nested/result.txt', text);
  assert.equal(created.created, true); assert.equal(fs.readFileSync(path.join(root, 'nested/result.txt'), 'utf8'), text);
  const read = await broker.read(root, 'nested/result.txt'); assert.equal(read.text, text); assert.equal(read.truncated, false); assert.equal(read.sha256, crypto.createHash('sha256').update(text).digest('hex'));
  assert.deepEqual((await broker.read(root, '')).entries, ['nested/']);
  await broker.create(root, 'empty.txt', ''); assert.equal((await broker.read(root, 'empty.txt')).text, '');
  await broker.create(root,'x','one-character name');assert.equal((await broker.read(root,'x')).text,'one-character name');
  await deny(broker.create(root, 'nested/result.txt', 'must not overwrite')); await deny(broker.create(root, 'nested/result.txt', 'must not overwrite', read.sha256)); assert.equal(fs.readFileSync(path.join(root, 'nested/result.txt'), 'utf8'), text);
  assert.equal(fs.readdirSync(path.join(root, 'nested')).some(name => name.startsWith('.hub-write-')), false);
  fs.mkdirSync(path.join(root,'listing'));for(let index=0;index<501;index++)fs.writeFileSync(path.join(root,'listing','item-'+String(index).padStart(3,'0')+'.txt'),'fixture');
  const limited=await broker.read(root,'listing');assert.equal(limited.entries.length,500);assert.equal(limited.limit,500);assert.equal(limited.truncated,true);
});

test('Native file reads enforce binary/UTF-8 bounds and preserve the 200KB prefix limit', async t => {
  const { root } = fixture(t);
  if (process.platform !== 'win32' || os.release() !== '10.0.26200') { await deny(broker.read(root, 'a.txt')); return; }
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([1,0,2])); fs.writeFileSync(path.join(root, 'invalid.txt'), Buffer.from([0xff,0xfe]));
  await deny(broker.read(root, 'binary.bin')); await deny(broker.read(root, 'invalid.txt'));
  fs.writeFileSync(path.join(root, 'large.txt'), 'a'.repeat(300*1024)); const read = await broker.read(root, 'large.txt'); assert.equal(read.bytesRead, 200*1024); assert.equal(read.text.length, 200*1024); assert.equal(read.truncated, true); assert.equal(read.sha256, null);
  await deny(broker.create(root, 'large-write.txt', 'a'.repeat(200*1024+1))); assert.equal(fs.existsSync(path.join(root, 'large-write.txt')), false);
});

test('Native root identity rejects a different directory installed under the same canonical name', async t => {
  const {dir,root}=fixture(t);if(process.platform!=='win32'||os.release()!=='10.0.26200'){await deny(broker.identity(root));return;}
  fs.writeFileSync(path.join(root,'marker.txt'),'approved root');const pin=(await broker.identity(root)).rootFingerprint;
  fs.renameSync(root,path.join(dir,'original-root'));fs.mkdirSync(root);fs.writeFileSync(path.join(root,'marker.txt'),'unapproved replacement root');
  await deny(broker.read(root,'marker.txt',pin));await deny(broker.create(root,'new.txt','must not be created','missing',pin));
  assert.equal(fs.existsSync(path.join(root,'new.txt')),false);assert.equal(fs.readFileSync(path.join(root,'marker.txt'),'utf8'),'unapproved replacement root');
});

test('Native file operations reject escape/device/ADS/reserved paths and parent/final reparses', async t => {
  const { root, outside } = fixture(t), marker = path.join(outside, 'marker.txt'); fs.writeFileSync(marker, 'synthetic outside marker');
  if (process.platform !== 'win32' || os.release() !== '10.0.26200') { await deny(broker.read(root, 'marker.txt')); return; }
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  for (const relative of ['../outside/marker.txt', 'linked/marker.txt', 'linked', 'a:stream', 'CON', 'LPT1.txt', 'nul', 'trailing.', 'trailing ', 'a\\..\\outside.txt', '\\\\localhost\\invalid\\marker.txt', 'C:\\outside\\marker.txt']) {
    await deny(broker.read(root, relative)); await deny(broker.create(root, relative, 'must not be written'));
  }
  await deny(broker.read(path.join(root, 'linked'), 'marker.txt'));
  fs.linkSync(marker, path.join(root, 'hardlink.txt')); await deny(broker.read(root, 'hardlink.txt')); await deny(broker.create(root, 'hardlink.txt', 'must not overwrite'));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'synthetic outside marker');
});

test('Native held directory chain withstands concurrent rename/junction swaps without outside reads or writes', async t => {
  const { root, outside, cleanup } = fixture(t), slot = path.join(root, 'slot'), parked = path.join(root, 'parked'); fs.mkdirSync(slot); fs.writeFileSync(path.join(slot, 'marker.txt'), 'inside fixture'); fs.writeFileSync(path.join(outside, 'marker.txt'), 'synthetic outside marker');
  if (process.platform !== 'win32' || os.release() !== '10.0.26200') { await deny(broker.read(root, 'slot/marker.txt')); return; }
  const pin=(await broker.identity(root)).rootFingerprint;
  assert.equal((await broker.read(root,'slot/marker.txt',pin)).text,'inside fixture');
  assert.equal((await broker.create(root,'slot/before.txt','before','missing',pin)).created,true);
  const workerSource=`
    const fs=require('fs');const [slot,parked,outside]=process.argv.slice(1);let attempts=0,displaced=0;
    const stat=p=>{try{return fs.lstatSync(p);}catch{return null;}};
    function restore(){
      try{if(stat(slot)?.isSymbolicLink())fs.unlinkSync(slot);}catch{}
      // A valid create may make a fresh in-root parent while the original is
      // parked. Preserve those outputs before restoring the marker directory.
      try{if(stat(parked)&&stat(slot)?.isDirectory()&&!stat(slot)?.isSymbolicLink())fs.renameSync(slot,slot+'-created-'+displaced++);}catch{}
      try{if(stat(parked)&&!stat(slot))fs.renameSync(parked,slot);}catch{}
    }
    function swap(){attempts++;try{if(!stat(parked)&&stat(slot)?.isDirectory()&&!stat(slot)?.isSymbolicLink())fs.renameSync(slot,parked);}catch{}try{if(!stat(slot))fs.symlinkSync(outside,slot,'junction');}catch{}restore();}
    const started=Date.now(),timer=setInterval(()=>{if((Date.now()-started)%450>=300)swap();else restore();},1);
    process.on('message',message=>{if(message==='stop'){clearInterval(timer);restore();process.send({stopped:true,attempts,restored:!stat(parked)&&Boolean(stat(slot))},()=>process.exit(0));}});process.send({ready:true});`;
  const worker = spawn(process.execPath, ['-e', workerSource, slot, parked, outside], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  cleanup.push(async () => { worker.kill(); if (worker.exitCode === null) await new Promise(resolve => worker.once('close', resolve)); });
  await new Promise(resolve => worker.once('message',resolve));
  let reads=0,writes=0;
  for (let index=0;index<60&&(index<15||!reads||!writes);index++) {
    try { assert.equal((await broker.read(root, 'slot/marker.txt',pin)).text, 'inside fixture');reads++; } catch (error) { assert.ok([403,404,409,415].includes(error.status)); }
    try { await broker.create(root, 'slot/new-'+index+'.txt', 'inside new content','missing',pin);writes++; } catch (error) { assert.ok([403,404,409,415].includes(error.status)); }
    assert.equal(fs.existsSync(path.join(outside, 'new-'+index+'.txt')), false);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'marker.txt'), 'utf8'), 'synthetic outside marker');
  const stopped=new Promise(resolve=>worker.once('message',resolve));worker.send('stop');const actor=await stopped;
  if(worker.exitCode===null)await new Promise(resolve=>worker.once('close',resolve));
  assert.equal(actor.restored,true);assert.ok(actor.attempts>0);assert.ok(reads>0);assert.ok(writes>0);
  assert.equal((await broker.read(root,'slot/marker.txt',pin)).text,'inside fixture');
  assert.equal((await broker.create(root,'slot/after.txt','after','missing',pin)).created,true);
  t.diagnostic(`Concurrent actor attempted ${actor.attempts} swaps; ${reads} reads and ${writes} creates completed inside the approved root`);
});

test('Native atomic create rejects a competing destination and cleans partial temporary files', async t => {
  const { root, cleanup } = fixture(t);
  if (process.platform !== 'win32' || os.release() !== '10.0.26200') { await deny(broker.create(root, 'result.txt', 'text')); return; }
  let target = '', collisions=0, sawTemp=0;
  const watcher = fs.watch(root, (event,name) => { if (String(name).startsWith('.hub-write-')) { sawTemp++; if(target)try{fs.writeFileSync(path.join(root,target),'competing destination',{flag:'wx'});collisions++;}catch{} } });
  cleanup.push(()=>watcher.close());
  for(let index=0;index<15;index++) { target='result-'+index+'.txt';try{const result=await broker.create(root,target,'a'.repeat(200*1024));assert.equal(result.created,true);assert.equal(fs.readFileSync(path.join(root,target),'utf8'),'a'.repeat(200*1024));}catch(error){assert.equal(error.status,409);assert.equal(fs.readFileSync(path.join(root,target),'utf8'),'competing destination');}target='';assert.equal(fs.readdirSync(root).some(name=>name.startsWith('.hub-write-')),false); }
  assert.ok(sawTemp>0);assert.ok(collisions>0);
});
