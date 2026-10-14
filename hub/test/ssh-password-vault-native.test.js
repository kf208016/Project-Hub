'use strict';
// Explicit native synthetic integration: fresh product-only vault entry, loopback only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const vault=require('../lib/ssh-password-vault');
const enabled=process.platform==='win32'&&process.env.HUB_RUN_VAULT_NATIVE_TEST==='1';
const native=enabled?test:test.skip;
native('real Git SSH uses native ASKPASS, saves once, reconnects without UI and forgets exact synthetic entry',{timeout:120000},async t=>{
  const server=cp.spawn('python',[path.join(__dirname,'fixtures/ssh-vault-server.py'),'--connections','3'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';server.stderr.on('data',x=>errors+=x);t.after(()=>server.kill());
  const ready=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(Error('fixture timeout')),10000);server.stdout.on('data',x=>{s+=x;if(s.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(s.split('\n')[0]));}catch(e){reject(e);}}});server.on('error',reject);});
  const parent=path.resolve(__dirname,'../../..');const prepared=await vault.prepare({parentRoot:parent,leaf:'vault-fixture-'+require('node:crypto').randomBytes(6).toString('hex')});
  const d=vault.descriptor({host:'127.0.0.1',port:ready.port,user:'fixture',hostKey:ready.publicKey,hostFingerprint:ready.fingerprint,ssh:'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',stageCommand:"python3 -I -c 'print(\"合成 🔐 <>&\")'"},prepared,{fixture:true});
  fs.writeFileSync(path.join(prepared.root,'fixture-descriptor.json'),vault.canonical(d),{flag:'wx'});
  let stored=false;
  try {
    // Corrupt/local existing registration state must be rejected before any
    // enrollment event, secret submission or connection, including directory
    // objects that File.Exists alone would incorrectly treat as absent.
    for(const [leaf,kind,code] of [
      ['registration.bin','file','REGISTRATION_ALREADY_EXISTS'],
      ['registration.bin','directory','REGISTRATION_ALREADY_EXISTS'],
      ['forgotten.bin','file','REGISTRATION_FORGOTTEN'],
      ['forgotten.bin','directory','REGISTRATION_FORGOTTEN'],
    ]){
      const target=path.join(prepared.root,leaf);
      assert.equal(path.dirname(target),prepared.root);
      if(kind==='directory')fs.mkdirSync(target);
      else fs.writeFileSync(target,'SYNTHETIC_EXISTING_REGISTRATION_STATE\n',{flag:'wx'});
      try {
        await assert.rejects(vault.operation('enroll-fixture',d,{fixture:true}),error=>{
          assert.equal(error.code,code,leaf+' '+kind);
          assert.equal(error.childCloseObserved,true);
          assert.equal(error.events.some(event=>/^(?:SUBMITTED$|SSH_|PROMPT_|ENROLLMENT_)/.test(event)),false);
          assert.deepEqual(error.events,[]);
          return true;
        });
      } finally {
        // Remove only the exact object just created in this fresh fixture root.
        if(kind==='directory')fs.rmdirSync(target);
        else fs.unlinkSync(target);
      }
    }
    const enrolled=await vault.operation('enroll-fixture',d,{fixture:true});stored=true;
    assert.equal(enrolled.state,'stored');assert.equal(enrolled.uid,1000);
    for(const required of ['SUBMITTED','ASKPASS_SUPPLIED','SSH_HOST_PIN_MATCHED','SSH_PASSWORD_AUTHENTICATED','IDENTITY_VERIFIED','STORED'])assert.ok(enrolled.events.includes(required),required);
    for(let i=0;i<2;i++){
      // Each invocation is a fresh native broker and fresh SSH connection.
      const r=await vault.operation('probe',d,{fixture:true});assert.equal(r.state,'connected');assert.equal(r.uid,1000);assert.ok(!r.events.includes('SUBMITTED'));assert.ok(r.events.includes('ASKPASS_SUPPLIED'));
    }
    const changed={...d,sshSHA256:'0'.repeat(64)};await assert.rejects(vault.operation('probe',changed,{fixture:true}),{code:'CODE_IDENTITY_CHANGED'});
    assert.equal((await vault.operation('status',d,{fixture:true})).state,'stored');
    assert.equal((await vault.operation('forget',d,{fixture:true})).state,'forgotten');stored=false;
    await assert.rejects(vault.operation('probe',d,{fixture:true}));
    assert.equal(errors,'');
  } catch(e){e.message+=' events='+JSON.stringify(e.events||[])+' fixture='+errors;throw e;}
  finally {
    if(stored)await vault.operation('forget',d,{fixture:true});
    // Keep failed-test receipts for diagnosis; delete only exact owned files on success.
    if(!stored&&fs.existsSync(path.join(prepared.root,'forgotten.bin'))){for(const name of ['known_hosts','registration.lock','registration.bin','forgotten.bin','fixture-descriptor.json'])fs.unlinkSync(path.join(prepared.root,name));fs.rmdirSync(prepared.root);}
  }
});
