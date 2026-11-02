'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { listModels } = require('../lib/codex-models');
const { AiTools } = require('../lib/ai-tools');

function fixture(t, mode = 'pages') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-list-'));
  const bin = path.join(root, 'bin'), entry = path.join(bin, 'node_modules/@openai/codex/bin/codex.js');
  const file = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const record = path.join(root, 'requests.jsonl');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const source = `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline'),mode=${JSON.stringify(mode)},record=${JSON.stringify(record)};
const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(record,JSON.stringify({method:m.method,params:m.params,tokenPresent:Boolean(process.env.HUB_LOCAL_TOKEN)})+'\\n');
 if(m.method==='initialize')return out({id:m.id,result:{}});
 if(m.method==='initialized')return;
 if(m.method!=='model/list')throw Error('unexpected request');
 if(mode==='timeout')return;
 if(mode==='broken')return process.stdout.write('broken JSON\\n');
 if(mode==='partial')return process.exit(0);
 if(mode==='oversize')return process.stdout.write('x'.repeat(6*1024*1024));
 if(mode==='rpc-error')return out({id:m.id,error:{code:-1,message:'secret-provider-error'}});
 if(mode==='approval')return out({id:90,method:'item/commandExecution/requestApproval',params:{command:'should never be approved'}});
 const row={id:'picker-id',model:'actual-model',displayName:'實際模型',hidden:false};
 let data=[row],nextCursor=null;
 if(mode==='empty')data=[];
 if(mode==='invalid')data=[{...row,model:'bad model;command'}];
 if(mode==='loop'){nextCursor='same';}
 if(mode==='pages'&&!m.params.cursor){data.push({id:'hidden',model:'hidden-model',displayName:'Hidden',hidden:true});nextCursor='next';}
 if(mode==='pages'&&m.params.cursor)data=[{...row,model:'second-model',displayName:'第二個模型'}];
 out({id:m.id,result:{data,nextCursor}});
});
setInterval(()=>{},1000);
`;
  fs.writeFileSync(entry, source);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\nexit /b 99\r\n' : source, { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return { root, file, record };
}

test('Codex native model discovery pages live IDs, preserves Unicode, strips Hub token and never starts a turn', async t => {
  const f = fixture(t);
  const models = await listModels(f.file, { env: { ...process.env, HUB_LOCAL_TOKEN: 'private-control-token' } });
  assert.deepEqual(models, [{ id: 'actual-model', label: '實際模型' }, { id: 'second-model', label: '第二個模型' }]);
  const requests = fs.readFileSync(f.record, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map(r => r.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.ok(requests.every(r => !r.tokenPresent));
  assert.equal(requests[2].params.includeHidden, false);
  assert.equal(requests[3].params.cursor, 'next');
});

for (const [mode, error] of [
  ['empty', /沒有回報可選模型/], ['invalid', /項目格式無效/], ['loop', /分頁無效/],
  ['broken', /有效的 JSON/], ['partial', /完成前中斷/], ['oversize', /超過上限/],
  ['timeout', /逾時/], ['rpc-error', /查詢失敗/], ['approval', /非預期的執行要求/],
]) test(`Codex native catalog fails closed: ${mode}`, async t => {
  const f = fixture(t, mode);
  await assert.rejects(listModels(f.file, { timeout: mode === 'timeout' ? 1500 : 10000 }), e => error.test(e.message) && !e.message.includes('secret-provider-error'));
});

test('Windows AiTools uses app-server; lookup failure preserves the last confirmed catalog', async t => {
  const f = fixture(t), home = path.join(f.root, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex/models_cache.json'), JSON.stringify({ models: [{ slug: 'stale-cache', display_name: 'Stale', visibility: 'list' }] }));
  const tools = new AiTools({ root: f.root, home, platform: 'win32', find: () => f.file, run: async () => { throw Error('debug models must not run'); } });
  const result = await tools.refresh('codex');
  assert.equal(result.source, 'codex-app-server');
  assert.deepEqual(result.models.map(m => m.id), ['actual-model', 'second-model']);
  assert.equal(tools.staleModel('codex', 'Stale'), false);
  const saved = fs.readFileSync(tools.file, 'utf8');
  tools.refreshCodex = async () => { throw Error('sensitive CLI output'); };
  await assert.rejects(tools.refresh('codex'), e => e.status === 502 && !e.message.includes('sensitive'));
  assert.equal(fs.readFileSync(tools.file, 'utf8'), saved);
  assert.equal(tools.isOperating(), false);
  const restarted = new AiTools({ root: f.root, home, dry: true });
  assert.deepEqual(restarted.catalog().codex.models, result.models);
});
