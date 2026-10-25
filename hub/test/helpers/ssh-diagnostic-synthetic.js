'use strict';
// Fresh synthetic registrations for diagnostic admission tests. The historical
// maintenance binaries and source remain frozen; no production descriptor loads.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const vault=require('../../lib/ssh-password-vault');
const maintenance=require('../../lib/ssh-vault-maintenance');
const PARENT=path.resolve(__dirname,'../../../..');
const FROZEN_SOURCE='80ea2f5beb6a463948defebfb53ae6fcba937afa21725ebbe80a02c6de3d8315';
const BOOT_ID='3d68605d-fc17-42f4-972b-40a18df72dbc';

function environment(){const env={};for(const key of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];return env;}
function noSecret(value){assert.doesNotMatch(JSON.stringify(value),/Hub fixture|密碼|🔐|PROMPT_REQUESTED|ENROLLMENT_READY|ENROLLMENT_REQUESTED/);}
function directMaintenance(manifest,mode){
  assert.ok(['fixture-inspect','fixture-cleanup'].includes(mode));
  assert.equal(manifest.sourceDescriptor.host,'127.0.0.1');assert.equal(manifest.sourceDescriptor.user,'fixture');
  assert.equal(manifest.destinationDescriptor.host,'127.0.0.1');assert.equal(manifest.destinationDescriptor.user,'fixture');
  assert.equal(maintenance.hash(fs.readFileSync(manifest.helper)),manifest.helperSHA256);
  const env={...environment(),HUB_SSH_MAINTENANCE_REQUEST:Buffer.from(maintenance.canonical({mode,manifest})).toString('base64')};
  const result=cp.spawnSync(manifest.helper,[],{env,windowsHide:true,timeout:20000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);noSecret({stdout:result.stdout,stderr:result.stderr});
  const value=JSON.parse(result.stdout);assert.equal(result.status,0,value.code);assert.equal(value.ok,true);return value;
}
function ownedRemove(root){
  assert.equal(path.dirname(root),PARENT);assert.match(path.basename(root),/^vault-diagnostic-[a-f0-9]{12}-[sdpg]$/);assert.equal(fs.realpathSync(root),root);
  function remove(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){const entry=path.join(directory,item.name),stat=fs.lstatSync(entry);assert.equal(stat.isSymbolicLink(),false);assert.ok(entry.startsWith(root+path.sep));if(stat.isDirectory())remove(entry);else fs.unlinkSync(entry);}fs.rmdirSync(directory);}
  remove(root);
}

async function createRoots(t){
  const build=maintenance.ensure({fixture:true}),oldBuild=vault.ensure({fixture:true});assert.equal(build.sourceHash,FROZEN_SOURCE);
  const id=crypto.randomBytes(6).toString('hex'),roots=[],state={manifest:null,source:null,enrolled:false,roots};
  t.after(async()=>{
    if(state.manifest){directMaintenance(state.manifest,'fixture-cleanup');const remaining=directMaintenance(state.manifest,'fixture-inspect');assert.equal(remaining.sourceExists,false);assert.equal(remaining.destinationExists,false);}
    else if(state.enrolled)await vault.operation('forget',state.source,{fixture:true});
    for(const root of roots.reverse())ownedRemove(root.root);
  });
  for(const suffix of ['s','d','p','g'])roots.push(await vault.prepare({parentRoot:PARENT,leaf:'vault-diagnostic-'+id+'-'+suffix}));
  return {id,build,oldBuild,sourceRoot:roots[0],destinationRoot:roots[1],pointerRoot:roots[2],grantRoot:roots[3],state};
}

async function completeMigration(bundle,server){
  const {build,oldBuild,sourceRoot,destinationRoot,pointerRoot,state}=bundle;
  const config={host:'127.0.0.1',port:server.config.port,user:'fixture',hostKey:server.config.publicKey,hostFingerprint:server.config.fingerprint,ssh:'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',stageCommand:'synthetic-source-stage-never-executed'};
  const source=vault.descriptor(config,sourceRoot,{fixture:true});state.source=source;
  const enrolled=await vault.operation('enroll-fixture',source,{fixture:true});state.enrolled=true;assert.equal(enrolled.uid,1000);
  const destination={...source,registrationId:crypto.randomUUID(),root:destinationRoot.root,rootFingerprint:destinationRoot.rootFingerprint,brokerSHA256:build.broker.sha256,stageCommand:build.catalog.command,stageCommandSHA256:maintenance.hash(Buffer.from(build.catalog.command))};
  const now=Math.floor(Date.now()/1000);
  const manifest={schemaVersion:1,migrationId:crypto.randomUUID(),issuedAt:now-2,expiresAt:now+3600,reviewReference:maintenance.REVIEW,sourceDescriptor:source,destinationDescriptor:destination,sourceReceiptSHA256:maintenance.hash(fs.readFileSync(path.join(source.root,'registration.bin'))),sourceUid:1000,sourceBroker:oldBuild.file,helper:build.helper.file,helperSHA256:build.helper.sha256,destinationBroker:build.broker.file,catalogSHA256:build.catalog.catalogSHA256,payloadSHA256:build.catalog.payloadSHA256,payloadLength:build.catalog.payloadLength,pointerRoot:pointerRoot.root,pointerRootFingerprint:pointerRoot.rootFingerprint,pointerExpectedSHA256:'absent',pointerFileName:'active-registration.json'};
  maintenance.validateManifest(manifest);state.manifest=manifest;
  const result=await maintenance.invokeHelper('migrate',manifest,{fixture:true});noSecret(result);assert.equal(result.state,'completed');
  const inspected=directMaintenance(manifest,'fixture-inspect');assert.equal(inspected.sourceExists,false);assert.equal(inspected.destinationExists,true);
  return {...bundle,manifest,source,destination,server,inspect:()=>directMaintenance(manifest,'fixture-inspect')};
}

module.exports={PARENT,FROZEN_SOURCE,BOOT_ID,environment,noSecret,ownedRemove,createRoots,completeMigration,directMaintenance};
