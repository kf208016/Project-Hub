'use strict';
const net=require('node:net'),path=require('node:path');
const {randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events');
const {ensureRunner}=require('./managed-process');

// Keep ConPTY's interactive console while assigning the real CLI to the same
// suspended-before-assignment Windows Job lifecycle used by chat subprocesses.
function spawn(file,args,options) {
  const pty=require('node-pty');
  if(process.platform!=='win32')return pty.spawn(file,args,options);
  if(!path.isAbsolute(file)||file.includes('\0')||!Array.isArray(args)||args.some(x=>typeof x!=='string'||x.includes('\0')))throw Error('Invalid PTY invocation');
  const runner=ensureRunner(),pipe='project-hub-pty-'+randomUUID(),nonce=randomUUID();
  const pin=options.dirPin;
  if(pin&&(!pin||typeof pin!=='object'||Object.keys(pin).sort().join(',')!=='root,rootFingerprint'||typeof pin.root!=='string'||pin.root!==options.cwd||!path.isAbsolute(pin.root)||! /^[a-f0-9]{64}$/.test(pin.rootFingerprint||'')))throw Error('Invalid PTY root identity');
  const spec=JSON.stringify({file,args,cwd:options.cwd,pipe,nonce,pty:true,...(pin?{dirPin:pin}:{})});
  if(spec.length>24000)throw Error('Windows 終端機參數超過上限，請用會話模式傳送長文');
  const events=new EventEmitter();let real,owner,pending='',ready=false,ended=false,killed=false,resolveStarted;
  const started=new Promise(r=>resolveStarted=r);
  const server=net.createServer(socket=>{
    let hello='';socket.setTimeout(10000,()=>socket.destroy());socket.on('error',()=>{});
    const accept=data=>{hello+=data.toString();if(hello.length>128)return socket.destroy();if(!hello.endsWith('\n'))return;if(hello!==nonce+'\n'||owner)return socket.destroy();owner=socket;socket.removeListener('data',accept);socket.setTimeout(0);server.close();};
    socket.on('data',accept);
  });
  const finish=exitCode=>{
    if(ended)return;ended=true;clearTimeout(timer);owner?.destroy();server.close();resolveStarted(ready);
    // node-pty 1.1.0 leaves its output worker referenced on natural exit.
    // The DLL path closes console handles without PID-list based termination.
    if(real){real.kill();real._agent._conoutSocketWorker.dispose();}
    if(!ready&&!killed)events.emit('data','\r\nWindows 終端機啟動失敗，CLI 未確認啟動。\r\n');
    events.emit('exit',{exitCode});
  };
  const result={started,get pid(){return real?.pid;},get cols(){return real?.cols;},get rows(){return real?.rows;},
    onData(fn){events.on('data',fn);return{dispose:()=>events.off('data',fn)};},onExit(fn){events.on('exit',fn);return{dispose:()=>events.off('exit',fn)};},
    write(data){if(ready&&!ended)real.write(data);},resize(cols,rows){if(real&&!ended)real.resize(cols,rows);},
    kill(){killed=true;owner?.destroy();if(real&&!ended)real.kill();else finish(125);}
  };
  const timer=setTimeout(()=>{events.emit('data','\r\nWindows 終端機啟動逾時。\r\n');result.kill();},15000);
  server.on('error',()=>result.kill());
  server.listen('\\\\.\\pipe\\'+pipe,()=>{
    if(ended)return server.close();
    try {real=pty.spawn(runner,[],{...options,env:{...options.env,HUB_PROCESS_SPEC:spec},useConpty:true,useConptyDll:true});}
    catch {return finish(125);}
    real.onData(data=>{
      if(ready)return events.emit('data',data);
      pending+=data;
      // ConPTY may surround this line with VT cursor/visibility sequences.
      const pattern=new RegExp('HUB_JOB_READY:'+nonce+':(\\d+)\\r?\\n');
      const match=pattern.exec(pending);
      if(match){ready=true;clearTimeout(timer);resolveStarted(true);const visible=pending.replace(pattern,'');pending='';events.emit('data',visible);}
      else if(pending.length>32768)result.kill();
      // Windows asks for cursor position during initial console attachment.
      if(data.includes('\x1b[6n'))real.write('\x1b[1;1R');
    });
    real.onExit(({exitCode})=>finish(exitCode));
  });
  return result;
}
module.exports={spawn};
