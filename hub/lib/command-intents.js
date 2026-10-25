'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TERMINAL = new Set(['completed','failed','expired','declined','canceled']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const error = (code, status = 409) => Object.assign(Error('Command intent: ' + code), { code, status });
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = value => path.resolve(value).replace(/\/+$/,'').toLowerCase();
class CommandIntents {
  constructor({resolve,execute,record=()=>{},now=Date.now,monotonic=()=>Number(process.hrtime.bigint()/1000000n),ttlMs=10*60*1000}={}) {
    if([resolve,execute,record,now,monotonic].some(fn=>typeof fn!=='function')||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>3600000)throw error('INVALID_CONFIGURATION');
    Object.assign(this,{resolve,execute,record,now,monotonic,ttlMs});this.rows=new Map();this.lastClock={wall:0,mono:0};
  }
  _clock() {
    let wall,mono;try{wall=this.now();mono=this.monotonic();}catch{wall=NaN;mono=NaN;}
    if(!Number.isSafeInteger(wall)||wall<0||wall>8640000000000000-this.ttlMs||!Number.isSafeInteger(mono)||mono<0||mono>Number.MAX_SAFE_INTEGER-this.ttlMs||wall<this.lastClock.wall||mono<this.lastClock.mono){
      for(const row of this.rows.values()){
        if(row.state==='pending'){row.state='expired';this._finish(row,this.lastClock);}
        else if(row.state==='validating'){row.state='canceled';this._finish(row,this.lastClock);}
        else if(row.state==='running'){row.state='canceling';try{row.cancel?.();}catch{}}
      }
      throw error('INVALID_CLOCK');
    }
    return(this.lastClock={wall,mono});
  }
  _finish(row,clock=this.lastClock){row.finishedAt=clock.wall;row.finishedMono=clock.mono;}
  _armExpiry(row){
    if(row.state!=='running')return;
    let clock;try{clock=this._clock();}catch{return;}
    const remaining=Math.min(row.expiresAt-clock.wall,row.expiresMono-clock.mono);
    if(remaining<=0){row.state='canceling';row.cancelReason='CAPABILITY_EXPIRED';try{row.cancel();}catch{}return;}
    row.expiryTimer=setTimeout(()=>this._armExpiry(row),Math.max(1,remaining));row.expiryTimer.unref?.();
  }
  _scope(scope) {
    if(!plain(scope)||typeof scope.id!=='string'||!UUID.test(scope.id)||typeof scope.run!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(scope.run)||typeof scope.project!=='string'||!scope.project||typeof scope.task!=='string'||!scope.task||typeof scope.taskHash!=='string'||!HASH.test(scope.taskHash)||typeof scope.rootFingerprint!=='string'||!HASH.test(scope.rootFingerprint)||typeof scope.root!=='string'||!path.isAbsolute(scope.root)||scope.expiresAt!==undefined&&(!Number.isSafeInteger(scope.expiresAt)||scope.expiresAt<0)||scope.remainingCalls!==undefined&&(!Number.isSafeInteger(scope.remainingCalls)||scope.remainingCalls<0))throw error('INVALID_SCOPE',403);
  }
  _boundScope(row){return{id:row.capId,project:row.project,task:row.task,run:row.run,taskHash:row.taskHash,root:row.root,rootFingerprint:row.rootFingerprint,...(row.capExpiresAt===undefined?{}:{expiresAt:row.capExpiresAt})};}
  _expire(row,clock) {
    if(row.state==='pending'&&(clock.wall>=row.expiresAt||clock.mono>=row.expiresMono)){row.state='expired';this._finish(row,clock);}
    return row;
  }
  _prune(clock,reserve=false){
    for(const row of this.rows.values()){this._expire(row,clock);if(TERMINAL.has(row.state)&&row.finishedMono+this.ttlMs<=clock.mono)this.rows.delete(row.id);}
    if(reserve&&this.rows.size>=128){const terminal=[...this.rows.values()].filter(row=>TERMINAL.has(row.state)).sort((a,b)=>a.finishedMono-b.finishedMono||(a.id<b.id?-1:a.id>b.id?1:0));for(const row of terminal){this.rows.delete(row.id);if(this.rows.size<128)break;}}
  }
  _public(row,clock=this._clock()) {
    this._expire(row,clock);
    const {id,capId,project,task,run,taskHash,rootFingerprint,argv,cwd,timeoutMs,createdAt,expiresAt,state,finishedAt,result,outcome}=row;
    return{id,capId,project,task,run,taskHash,rootFingerprint,argv:argv.slice(),cwd,timeoutMs,createdAt,expiresAt,state,...(finishedAt===undefined?{}:{finishedAt}),...(result===undefined?{}:{result:structuredClone(result)}),...(outcome===undefined?{}:{outcome}),readBoundary:'broader-than-task',networkBoundary:'networkAccess=false is not a complete network boundary'};
  }
  async _validate(scope, argv, cwd, expectedHash) {
    this._scope(scope);const clock=this._clock();if(scope.expiresAt!==undefined&&scope.expiresAt<=clock.wall||scope.remainingCalls===0)throw error('CAPABILITY_EXPIRED',403);
    if(!Array.isArray(argv) || !argv.length || argv.length > 128 || argv.some(a=>typeof a!=='string'||a.length>8192||a.includes('\0')) || !path.isAbsolute(argv[0]) || Buffer.byteLength(JSON.stringify(argv))>20000 || typeof cwd!=='string' || !path.isAbsolute(cwd) || cwd!==scope.root || expectedHash!==scope.taskHash) throw error('INVALID_REQUEST',400);
    const current=await this.resolve(scope.project,scope.task,scope);
    if(!current||current.taskHash!==scope.taskHash||current.rootFingerprint!==scope.rootFingerprint||typeof current.root!=='string'||canonical(current.root)!==canonical(scope.root)||current.remainingCalls!==undefined&&(!Number.isSafeInteger(current.remainingCalls)||current.remainingCalls<=0))throw error('SCOPE_CHANGED');
    return current;
  }
  async request(scope, body) {
    if(!plain(body) || Object.keys(body).some(k=>!['argv','cwd','timeoutMs','expectedHash'].includes(k))) throw error('INVALID_REQUEST',400);
    const timeoutMs=body.timeoutMs === undefined ? 30000 : body.timeoutMs;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw error('INVALID_TIMEOUT',400);
    this._prune(this._clock(),true);if(this.rows.size>=128)throw error('INTENT_LIMIT');
    await this._validate(scope,body.argv,body.cwd,body.expectedHash);
    const clock=this._clock();this._prune(clock,true);if(this.rows.size>=128)throw error('INTENT_LIMIT');const expiresAt=Math.min(clock.wall+this.ttlMs,scope.expiresAt===undefined?Infinity:scope.expiresAt),duration=expiresAt-clock.wall;if(duration<=0)throw error('CAPABILITY_EXPIRED',403);
    const row={id:crypto.randomUUID(),capId:scope.id,project:scope.project,task:scope.task,run:scope.run,taskHash:scope.taskHash,root:scope.root,rootFingerprint:scope.rootFingerprint,capExpiresAt:scope.expiresAt,argv:body.argv.slice(),cwd:body.cwd,timeoutMs,createdAt:clock.wall,expiresAt,createdMono:clock.mono,expiresMono:clock.mono+duration,state:'pending'};
    this.rows.set(row.id,row);return this._public(row,clock);
  }
  list(){const clock=this._clock();this._prune(clock);return[...this.rows.values()].map(row=>this._public(row,clock));}
  get(scope,id){this._scope(scope);const clock=this._clock();this._prune(clock);const row=this.rows.get(id);if(!row||row.capId!==scope.id||row.run!==scope.run||row.project!==scope.project||row.task!==scope.task)throw error('NOT_FOUND',404);return this._public(row,clock);}
  async decide(body) {
    if(!plain(body) || Object.keys(body).some(k=>!['id','decision','confirm','ackBroaderRead','ackNetworkLimits','argv','cwd','expectedHash','rootFingerprint'].includes(k)))throw error('INVALID_DECISION',400);
    const clock=this._clock();this._prune(clock);const row=this.rows.get(body.id);if(!row)throw error('NOT_FOUND',404);this._expire(row,clock);if(row.state!=='pending')throw error('NOT_PENDING');
    if(body.confirm!==true || !['approve','decline'].includes(body.decision))throw error('CONFIRM_REQUIRED',400);
    if(body.decision==='decline'){row.state='declined';this._finish(row,clock);return this._public(row,clock);}
    if(body.ackBroaderRead!==true||body.ackNetworkLimits!==true || !equal(body.argv,row.argv)||body.cwd!==row.cwd||body.expectedHash!==row.taskHash||body.rootFingerprint!==row.rootFingerprint)throw error('APPROVAL_MISMATCH',400);
    // Claim approval before awaiting any filesystem probe. Concurrent approvals
    // never get a second execution, including failure and timeout paths.
    row.state='validating';
    try {
      const scope=this._boundScope(row);await this._validate(scope,row.argv,row.cwd,row.taskHash);
      if(row.state!=='validating')throw error('CANCELED');
      const beforeRecord=this._clock();if(beforeRecord.wall>=row.expiresAt||beforeRecord.mono>=row.expiresMono)throw error('EXPIRED');
      await this.record(this._public(row,beforeRecord));await this._validate(scope,row.argv,row.cwd,row.taskHash);
      if(row.state!=='validating')throw error('CANCELED');const approvedClock=this._clock();if(approvedClock.wall>=row.expiresAt||approvedClock.mono>=row.expiresMono)throw error('EXPIRED');
      row.state='running';const owned=this.execute(this._public(row,approvedClock),{root:row.root,rootFingerprint:row.rootFingerprint});
      if(!owned || typeof owned.cancel!=='function' || !owned.promise || typeof owned.promise.then!=='function')throw error('INVALID_EXECUTOR');
      row.cancel=owned.cancel;
      Promise.resolve(owned.promise).then(result=>{try{row.result=structuredClone(result);row.state=row.state==='canceling'||result?.canceled===true?'canceled':'completed';row.outcome=row.state==='canceled'?'canceled':Number.isSafeInteger(result?.exitCode)&&result.exitCode===0?'success':'failure';}catch{row.result={error:'INVALID_RESULT'};row.state='failed';row.outcome='failure';}},()=>{row.result={error:'EXECUTION_FAILED'};row.state=row.state==='canceling'?'canceled':'failed';row.outcome=row.state==='canceled'?'canceled':'failure';}).finally(()=>{clearTimeout(row.expiryTimer);try{this._finish(row,this._clock());}catch{this._finish(row);}delete row.cancel;});
      this._armExpiry(row);
      return this._public(row,approvedClock);
    }catch(e){row.state=row.state==='canceled'?'canceled':'failed';this._finish(row);row.result={error:typeof e.code==='string'?e.code:'VALIDATION_FAILED'};row.outcome=row.state==='canceled'?'canceled':'failure';throw e;}
  }
  cancel(scope,id) {
    this.get(scope,id);const row=this.rows.get(id);
    if(['pending','validating'].includes(row.state)){row.state='canceled';this._finish(row);}
    else if(row.state==='running'){row.state='canceling';row.cancel();}
    return this._public(row);
  }
  cancelRun(run) {for(const row of this.rows.values())if(row.run===run && ['pending','validating','running'].includes(row.state))this.cancel(this._boundScope(row),row.id);}
  active() {return [...this.rows.values()].filter(row=>['validating','running','canceling'].includes(row.state)).length;}
}
module.exports={CommandIntents};
