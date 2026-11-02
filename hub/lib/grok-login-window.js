'use strict';
const {loginState,ttlFromEnv,marginFromEnv}=require('./grok-login');
const MODES=Object.freeze({refresh:['models'],login:['login'],device:['login','--device-auth']});
const fail=(code='GROK_LOGIN_UNAVAILABLE',status=409)=>Object.assign(Error(code),{code,status});
function createGrokLoginWindow({resolveGrok,spawn,now=Date.now,record,isGrokTurnActive,home,env,
  comspec=process.env.ComSpec,setTimeout:schedule=global.setTimeout,clearTimeout:unschedule=global.clearTimeout,kill}){
  const ttlMs=ttlFromEnv(env.PROJECT_HUB_GROK_LOGIN_TTL_MS),marginMs=marginFromEnv(env.PROJECT_HUB_GROK_LOGIN_MARGIN_MS,ttlMs),metadata=()=>loginState({home,now:now(),ttlMs,marginMs});
  let current=null,disposed=false;
  let last={running:false,mode:null,startedAt:null,finishedAt:null,exitCode:null,outcome:null,timedOut:false};
  function finish(run,exitCode,{timedOut=false,forced=false}={}){
    if(current!==run)return;
    if(run.timer!==undefined)unschedule(run.timer);
    const after=metadata(),present=after.mtime!==null;
    const changed=present&&(run.before.state==='missing'||run.before.mtime!==null&&after.mtime>run.before.mtime);
    const outcome=forced?'failed':changed?'refreshed':exitCode===0&&present&&after.mtime===run.before.mtime?'unchanged':'failed';
    last={running:false,mode:run.mode,startedAt:run.startedAt,finishedAt:now(),exitCode,outcome,timedOut};current=null;
    const fields={mode:run.mode,exitCode,outcome,timedOut,durationMs:Math.max(0,last.finishedAt-run.startedAt)};
    if(run.resolve){
      try{record('grok-login-window',fields);}catch{/* Automatic refresh must always settle. */}
      run.resolve(Object.freeze({outcome,timedOut}));
    }else record('grok-login-window',fields);
  }
  function stop(run,timedOut=false){
    if(current!==run)return;
    // PID is provided by our child, never by a route parameter.
    run.stopping={timedOut,forced:true};
    try{if(Number.isSafeInteger(run.child?.pid)&&run.child.pid>0)kill(run.child.pid);}catch{/* Still report failure; never claim successful cleanup. */}finally{finish(run,null,run.stopping);}
  }
  async function start(mode){
    if(typeof mode!=='string'||!Object.hasOwn(MODES,mode))throw fail('GROK_LOGIN_UNAVAILABLE',400);
    if(current)throw fail(current.mode==='auto'?'GROK_LOGIN_AUTO_REFRESHING':'GROK_LOGIN_WINDOW_OPEN');
    if(disposed)throw fail();
    if(isGrokTurnActive())throw fail('GROK_LOGIN_TURN_ACTIVE');
    if(typeof home!=='string'||typeof env.USERPROFILE!=='string'||home.toLowerCase()!==env.USERPROFILE.toLowerCase())throw fail();
    const run={mode,startedAt:now(),before:metadata()};current=run;
    last={running:true,mode,startedAt:run.startedAt,finishedAt:null,exitCode:null,outcome:null,timedOut:false};
    try{
      let file;try{file=await resolveGrok();}catch{throw fail();}
      if(current!==run||disposed)throw fail();
      if(typeof file!=='string'||!(/^[A-Za-z]:\\[^"%^&|<>!\r\n]+\\grok\.exe$/i).test(file))throw fail();
      if(isGrokTurnActive())throw fail('GROK_LOGIN_TURN_ACTIVE');
      const cleanEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!(/^(PROJECT_HUB_|HUB_)/i).test(key)&&!(/^(GROK_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i).test(key)));
      if(mode==='refresh')cleanEnv.GROK_AUTH_EARLY_INVALIDATION_SECS='21600';
      run.before=metadata();
      run.child=spawn(comspec,['/d','/s','/c',`start "Grok login" /wait "${file}" ${MODES[mode].join(' ')}`],
        {windowsVerbatimArguments:true,windowsHide:true,stdio:'ignore',cwd:home,env:cleanEnv});
      run.child.once('error',()=>finish(run,null,{forced:true}));
      run.child.once('exit',code=>finish(run,Number.isInteger(code)?code:null,run.stopping));
      run.timer=schedule(()=>stop(run,true),mode==='refresh'?120000:900000);
      run.timer?.unref?.();
      return state();
    }catch(error){finish(run,null,{forced:true});throw fail(error.code==='GROK_LOGIN_TURN_ACTIVE'?error.code:undefined);}
  }
  function autoRefresh(){
    if(current)return current.mode==='auto'?current.promise:Promise.resolve(Object.freeze({outcome:'busy',timedOut:false}));
    const failed=()=>Promise.resolve(Object.freeze({outcome:'failed',timedOut:false}));
    let run;
    try{
      if(disposed||typeof home!=='string'||typeof env.USERPROFILE!=='string'||home.toLowerCase()!==env.USERPROFILE.toLowerCase())return failed();
      run={mode:'auto',startedAt:now(),before:metadata()};
      run.promise=new Promise(resolve=>{run.resolve=resolve;});current=run;
      last={running:true,mode:'auto',startedAt:run.startedAt,finishedAt:null,exitCode:null,outcome:null,timedOut:false};
    }catch{return failed();}
    void (async()=>{
      try{
        const file=await resolveGrok();
        if(current!==run||disposed)return;
        if(typeof file!=='string'||!(/^[A-Za-z]:\\[^"%^&|<>!\r\n]+\\grok\.exe$/i).test(file))throw fail();
        const cleanEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!(/^(PROJECT_HUB_|HUB_)/i).test(key)&&!(/^(GROK_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|GROK_AUTH_EARLY_INVALIDATION_SECS)$/i).test(key)));
        cleanEnv.GROK_AUTH_EARLY_INVALIDATION_SECS='21600';
        run.before=metadata();
        run.child=spawn(file,['models'],{windowsHide:true,stdio:'ignore',cwd:home,env:cleanEnv});
        run.child.once('error',()=>finish(run,null,{forced:true}));
        run.child.once('exit',code=>finish(run,Number.isInteger(code)?code:null,run.stopping));
        run.timer=schedule(()=>stop(run,true),60000);
        run.timer?.unref?.();
      }catch{stop(run);}
    })();
    return run.promise;
  }
  function state(){return {...last,login:metadata()};}
  function dispose(){disposed=true;if(current)stop(current);}
  return Object.freeze({start,autoRefresh,state,dispose});
}
module.exports={createGrokLoginWindow};
