'use strict';
const {performance}=require('node:perf_hooks');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(fn,{deadlineMs=30000,intervalMs=100,message='Condition timed out'}={}){
 const end=performance.now()+deadlineMs;let last;
 do{last=await fn();if(last)return last;await pause(Math.min(intervalMs,Math.max(0,end-performance.now())));}while(performance.now()<end);
 throw Error(message+'; last='+JSON.stringify(last));
}
async function waitForHub(base,child,diag=()=>'',{deadlineMs=60000,intervalMs=100}={}){
 const end=performance.now()+deadlineMs;let output='',last='listen signal not observed';
 const data=chunk=>{output=(output+chunk).slice(-8192);};child.stdout?.on('data',data);
 const diagnostic=()=>String(typeof diag==='function'?diag():diag).slice(-2000);
 try{
  do{
   if(child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)throw Error('Hub exited before readiness: '+child.exitCode+'/'+child.signalCode+'; '+diagnostic());
   if(output.includes('HUB_LISTENING')||output.includes('Project Hub: '+base)){
    try{const response=await fetch(base+'/api/state',{signal:AbortSignal.timeout(Math.max(1,Math.min(1000,Math.ceil(end-performance.now()))))});await response.body?.cancel();if(response.status===200)return;last='HTTP '+response.status;}catch(error){last=String(error.message);}
   }
   await pause(Math.min(intervalMs,Math.max(0,end-performance.now())));
  }while(performance.now()<end);
  throw Error('Hub readiness deadline exceeded; last='+last+'; '+diagnostic());
 }finally{child.stdout?.off('data',data);}
}
module.exports={waitForHub,waitFor};
