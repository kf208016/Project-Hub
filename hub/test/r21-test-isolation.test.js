'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// Deliberately lexical, not a JS data-flow analyzer: recognize literal server.js
// references plus spawn calls (including -e/preload wrappers), or a path.join
// launcher identifier passed directly after literal -File or first in an array
// before a literal dash flag, then check each
// simple env object containing HUB_ROOT. Only literal DRY '1' is exempt;
// omitted/dynamic DRY values fail closed. This cannot follow imported helpers,
// computed filenames, aliased launcher arguments, env mutations after construction
// or prove a home is temp. Text-only launcher reads are outside this scan.
// A wholly synthetic installer fixture is outside this real-server scan because
// it writes its own server.js and never names the repository server as a target.
function environments(source){
  const result=[];
  // Existing fixtures keep their env values free of nested object literals.
  for(const match of source.matchAll(/\{[^{}]*\bHUB_ROOT\s*:[^{}]*\}/g))result.push(match[0]);
  return result;
}
function violations(source){
  const launcher=[...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*path\.join\([^();\n]*?['"][^'"]*start-windows\.ps1['"]\s*\)/g)].some(m=>
    [...source.matchAll(/['"]-File['"]\s*,\s*([A-Za-z_$][\w$]*)\b|\[\s*([A-Za-z_$][\w$]*)\s*,\s*['"]-/g)].some(arg=>(arg[1]||arg[2])===m[1]));
  if(!launcher&&(!/\bspawn\s*\(/.test(source)||!/(?:['"]\.\.\/server\.js['"]|path\.join\(hub,\s*['"]server\.js['"]\)|\[\s*['"]server\.js['"]|,\s*['"]server\.js['"]\s*\])/.test(source)))return [];
  const envs=environments(source);
  if(!envs.length)return ['no inspectable server environment'];
  return envs.filter(env=>! /\bHUB_DRY_RUN\s*:\s*(['"])1\1\s*[,}]/.test(env)).flatMap(env=>{
    const errors=[];
    if(!/\bPROJECT_HUB_GROK_ACL_REVOKE\s*:\s*(['"])0\1\s*[,}]/.test(env))errors.push('non-DRY env needs PROJECT_HUB_GROK_ACL_REVOKE: 0');
    if(!/\bPROJECT_HUB_GROK_AUTO_REFRESH\s*:\s*(['"])0\1\s*[,}]/.test(env))errors.push('non-DRY env needs PROJECT_HUB_GROK_AUTO_REFRESH: 0');
    if(!/\bUSERPROFILE\s*:\s*(?!process\.env\b)[^,}\s]+/.test(env))errors.push('non-DRY env needs an explicit synthetic USERPROFILE');
    return errors;
  });
}
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):e.isFile()&&e.name.endsWith('.js')?[path.join(dir,e.name)]:[]);}
test('R21 every non-DRY test server has revocation and auto refresh disabled and an explicit owner home',()=>{
  const failures=[];
  for(const file of files(__dirname)){
    if(file===__filename)continue; // This file scans text; it never spawns a server.
    for(const error of violations(fs.readFileSync(file,'utf8')))failures.push(path.relative(__dirname,file)+': '+error);
  }
  assert.deepEqual(failures,[]);
});
test('R29 isolation guard checks launcher execution and ignores text-only reads',()=>{
  const declaration="const ps=path.join(root,'powershell.exe'),script=path.join(__dirname,'../start-windows.ps1');",launch="exec(['-File',script,'-NoBrowser'],env);";
  assert.deepEqual(violations(declaration+launch),['no inspectable server environment']);
  assert.deepEqual(violations(declaration+"const env={HUB_ROOT:root};"+launch),[
    'non-DRY env needs PROJECT_HUB_GROK_ACL_REVOKE: 0','non-DRY env needs PROJECT_HUB_GROK_AUTO_REFRESH: 0','non-DRY env needs an explicit synthetic USERPROFILE']);
  assert.deepEqual(violations(declaration+"run([script,'-NoBrowser'],env);"),['no inspectable server environment']);
  assert.deepEqual(violations(declaration+"fs.readFileSync(script,'utf8');"),[]);
  assert.deepEqual(violations(declaration+"const env={HUB_ROOT:root,PROJECT_HUB_GROK_ACL_REVOKE:'0',PROJECT_HUB_GROK_AUTO_REFRESH:'0',USERPROFILE:path.join(root,'home')};"+launch),[]);
});

test('R21 isolation guard rejects omitted/dynamic DRY and unrelated environment protections',()=>{
  const direct="spawn(node,['server.js'],{env:{HUB_ROOT:root,HUB_DRY_RUN:'0'}})",boot="spawn(node,['-e',boot,path.join(__dirname,'../server.js')],{env})";
  assert.equal(violations(direct).length,3);
  for(const dry of ["HUB_DRY_RUN:'0',","HUB_DRY_RUN:live?'0':'1',",'']){
    const bad="const env={HUB_ROOT:root,"+dry+"};"+boot;
    assert.equal(violations(bad).length,3);
    assert.equal(violations(bad+"const unrelated={USERPROFILE:home,PROJECT_HUB_GROK_ACL_REVOKE:'0',PROJECT_HUB_GROK_AUTO_REFRESH:'0'}").length,3);
    assert.deepEqual(violations("const env={HUB_ROOT:root,"+dry+"USERPROFILE:home,PROJECT_HUB_GROK_ACL_REVOKE:'0',PROJECT_HUB_GROK_AUTO_REFRESH:'0'};"+boot),[]);
    for(const auto of ['',"PROJECT_HUB_GROK_AUTO_REFRESH:'1',","PROJECT_HUB_GROK_AUTO_REFRESH:flag,"]){
      assert.deepEqual(violations("const env={HUB_ROOT:root,USERPROFILE:home,PROJECT_HUB_GROK_ACL_REVOKE:'0',"+auto+"};"+boot),['non-DRY env needs PROJECT_HUB_GROK_AUTO_REFRESH: 0']);
    }
  }
  assert.deepEqual(violations("spawn(node,['server.js'],{env:{HUB_ROOT:root,HUB_DRY_RUN:'1'}})"),[]);
});
