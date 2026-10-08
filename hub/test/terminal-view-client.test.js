'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const TerminalView=require('../public/terminal-view');
const owner={viewId:'v'.repeat(32),lease:'s'.repeat(43),role:'owner',readonly:false,epoch:1};
function client(api,state=[]){return new TerminalView({api,project:'p',task:'t',ai:'codex',interval:()=>1,clear:()=>{},onState:x=>state.push(x)});}
test('browser terminal preserves private credentials, serializes input and never sends watcher input/resize',async()=>{
 const calls=[],states=[];let release;
 const view=client(async(route,body)=>{calls.push({route,body});if(route.endsWith('register'))return {...owner};if(route.endsWith('input')&&body.data==='first')await new Promise(r=>release=r);return {ok:true};},states);
 await view.connect();const first=view.write('first'),second=view.write('second');await new Promise(r=>setImmediate(r));assert.deepEqual(calls.filter(x=>x.route.endsWith('input')).map(x=>x.body.data),['first']);release();await Promise.all([first,second]);assert.deepEqual(calls.filter(x=>x.route.endsWith('input')).map(x=>x.body.data),['first','second']);
 assert.equal(calls.at(-1).body.lease,owner.lease);assert.ok(states.every(s=>!Object.hasOwn(s,'lease')));
 view.update({viewId:owner.viewId,role:'watcher',readonly:false,epoch:2});const before=calls.length;await assert.rejects(view.write('no'),/觀看/);assert.equal(await view.resize(120,40),false);assert.equal(calls.length,before);
 await view.close();assert.equal(calls.at(-1).route,'/api/term/view/disconnect');assert.ok(!calls.some(x=>x.route.endsWith('/stop')));
});
test('browser terminal requires explicit takeover and ignores older heartbeat responses',async()=>{
 const calls=[];const view=client(async(route,body)=>{calls.push({route,body});if(route.endsWith('register'))return {...owner,role:'watcher'};if(route.endsWith('heartbeat'))return {...owner,lease:undefined,role:'watcher',epoch:2};return {...owner,lease:undefined,epoch:3};});
 await view.connect();assert.equal(await view.claim(false),false);assert.equal(calls.length,1);assert.equal(await view.claim(true),true);assert.equal(calls.at(-1).body.expectedEpoch,2);assert.equal(calls.at(-1).body.takeover,true);
 view.update({viewId:owner.viewId,role:'watcher',readonly:false,epoch:2});assert.equal(view.owner(),true);assert.equal(view.session.epoch,3);
});
test('late view registration after closing is immediately disconnected and malformed leases fail closed',async()=>{
 let release;const calls=[];const view=client(async(route,body)=>{calls.push({route,body});return route.endsWith('register')?new Promise(r=>release=r):{ok:true};});
 const pending=view.connect();await view.close();release({...owner});await pending;assert.equal(calls.at(-1).route,'/api/term/view/disconnect');assert.equal(view.owner(),false);
 const bad=client(async()=>({...owner,lease:'short'}));await assert.rejects(bad.connect(),/租約/);assert.equal(bad.owner(),false);
});
test('standalone terminal resources exist and its URL has no authentication token',()=>{
 const publicDir=path.join(__dirname,'../public'),html=fs.readFileSync(path.join(publicDir,'terminal.html'),'utf8');for(const [,src]of html.matchAll(/(?:src|href)="([^"?#]+)"/g))assert.equal(fs.existsSync(path.join(publicDir,src)),true,src);
 assert.ok(html.includes('local-auth.js'));assert.ok(html.includes('aria-label="Codex 終端機"'));
 const app=fs.readFileSync(path.join(publicDir,'app.js'),'utf8'),method=app.slice(app.indexOf('function openTerminalWindow'),app.indexOf('// ---- 設定',app.indexOf('function openTerminalWindow')));assert.ok(!method.includes('#auth='));assert.ok(method.includes("'terminal.html?'"));assert.ok(method.includes('popup.opener = null'));
});
