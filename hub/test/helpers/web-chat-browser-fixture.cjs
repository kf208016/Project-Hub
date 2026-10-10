'use strict';
// Local browser acceptance fixture: synthetic data and owned fake Codex only.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const fixture=require('./owned-native-fixture'),{Store}=require('../../lib/store');
(async()=>{
 const parent=path.resolve(process.argv[2]||'');if(!fs.existsSync(parent)||!path.basename(parent).startsWith('web-chat-ui-owned-'))throw Error('Owned fixture directory required');
 const root=path.join(parent,'workspace'),store=new Store(root),project=store.readProject('合成介面驗收')||store.createProject({name:'合成介面驗收'}).project,task=project.tasks.find(item=>item.title==='手動交接流程')||store.createTask(project.id,{title:'手動交接流程',owner:'codex',model:'GPT-6.1-Sol'});
 fs.copyFileSync(path.join(__dirname,'../../windows/roles.yaml'),path.join(root,'_hub/roles.yaml'));
 const fake=fixture.provider(parent,{count:path.join(parent,'provider-starts.txt')}),restore=fixture.freshInventory();
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 Object.assign(process.env,{PATH:fixture.environment(fake.bin),HUB_ROOT:root,HUB_PORT:String(port),HUB_DRY_RUN:'1',HUB_LOCAL_TOKEN:'F'.repeat(43),HUB_AI_HOME:path.join(parent,'empty-home')});
 const app=require('../../server');await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(parent,'scope.json'),JSON.stringify({port,project:project.id,task:task.id,root},null,2));
 console.log(JSON.stringify({ready:true,port,project:project.id,task:task.id}));
 let closing=false;async function close(){if(closing)return;closing=true;restore();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));console.log('Owned fixture stopped');process.exit(0);}
 process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='STOP')close().catch(error=>{console.error(error.message);process.exit(1);});});
 process.on('SIGINT',()=>close());process.on('SIGTERM',()=>close());
})().catch(error=>{console.error(error.message);process.exit(1);});
