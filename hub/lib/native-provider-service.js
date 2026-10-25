'use strict';
const {MAX_WALL_MS}=require('./native-turn-limits');
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {NativeProviderRuntime}=require('./native-provider-runtime');
const {NativeProviderApprovals}=require('./native-provider-approvals');
const {createPlan}=require('./provider-native-plan');
const host=require('./provider-native-host'),egress=require('./provider-egress');
const artifacts=require('./native-cli-update');
const safe=require('./safe-path');
const scoped=require('./scoped-file');
const {canonical}=require('./providers/claude-protocol');
const registry=require('./provider-registry');
const {CLI_DEFAULT_LABEL}=require('./launch');
const {decide}=require('./native-provider-tool-policy');
const {TOOLS:CLAUDE_TOOLS}=require('./claude-subagent-context');
const hash=x=>crypto.createHash('sha256').update(canonical(x)).digest('hex');
const fail=()=>Object.assign(Error('原生 CLI 設定或版本尚未核對；未啟動。'),{code:'NATIVE_PROFILE_UNAVAILABLE',status:409,notStarted:true});
const GROK_PROFILE=Object.freeze({name:'hub-development',description:'Approved task development',agentsMd:false,
  discoverSkills:false,inheritSkills:false,skills:[],hooks:{},permissionMode:'default',
  // Canonical filter IDs; ACP permission display names are not filter IDs.
  tools:['read_file','grep','search_replace','write','run_terminal_cmd','task','search_tool','use_tool']});

// This is the production composition. Its callbacks belong to the authenticated
// server controller; HTTP/MCP input cannot replace binaries, scope or factories.
class NativeProviderService {
  #resolve;#profile;#model;#effort;#mcp;#dispose;#runtime;#approvals;
  #authorities;
  #toolPolicy;#recordDecision;
  constructor({resolveWorkspace,profile,modelFlag,effortFlag,supervisedSpawn,mcpFor=async()=>null,httpFor=()=>null,dispose=async()=>{},toolPolicyFor=()=>null,recordDecision=()=>{}}){
    if([resolveWorkspace,profile,modelFlag,effortFlag,supervisedSpawn,mcpFor,httpFor,dispose,toolPolicyFor,recordDecision].some(f=>typeof f!=='function'))throw fail();
    this.#toolPolicy=toolPolicyFor;this.#recordDecision=recordDecision;
    this.#resolve=resolveWorkspace;this.#profile=profile;this.#model=modelFlag;this.#effort=effortFlag;this.#mcp=mcpFor;this.#dispose=dispose;
    this.#approvals=new NativeProviderApprovals({describe:(r,b)=>this.#describe(r,b)});
    this.#runtime=new NativeProviderRuntime({
      resolve:r=>this.#binding(r),
      authorize:async(r,b,context)=>{
        const descriptor=await this.#approvals.authorize(r,b);
        const mcp=await this.#mcp(Object.freeze({...r,runId:context.runId}),b);
        if(mcp!==null){
          if(r.actor==='claude')descriptor.validatedMcpConfig=mcp;
          else descriptor.validatedMcpServers=mcp;
        }
        return descriptor;
      },
      createBroker:(o,context)=>{const handleHttp=httpFor(context);return egress.create({...o,...(handleHttp?{handleHttp}:{})});},launch:o=>host.launch(o,supervisedSpawn),dispose:r=>this.#dispose(r)
    });
    this.#authorities=Object.freeze(Object.fromEntries(['claude','grok'].map(actor=>[actor,registry.createNativeAuthority(actor,
      ['chat','delegate','queue','resume','stop','transcript','mcp'],()=>true)])));
  }
  async #binding(r){
    const value=await this.#resolve(r.project,r.task);
    if(!value||value.project!==r.project||value.task!==r.task)throw fail();
    return {project:value.project,task:value.task,dir:value.dir,rootFingerprint:value.rootFingerprint,workspaceRun:value.run};
  }
  async #describe(r,resolvedBinding){
    // This identity map lives only for this describe/authorize, never across turns.
    const identities=new Map(),identityFor=file=>{const key=path.resolve(file).toLowerCase();if(!identities.has(key))identities.set(key,scoped.identity(file));return identities.get(key);};
    const binding=resolvedBinding||await this.#binding(r),settings=await this.#profile(r.actor,{identity:identityFor});
    const modelFlag=this.#model(r.actor,r.model),effortFlag=this.#effort(r.actor,r.effort);
    if(!settings||(!modelFlag&&!(modelFlag===''&&['claude','grok'].includes(r.actor)&&r.model===CLI_DEFAULT_LABEL))||!effortFlag)throw fail();
    const launchOptions={...settings,actor:r.actor,cwd:binding.dir,rootFingerprint:binding.rootFingerprint,maxWallMs:MAX_WALL_MS};
    const plan=createPlan({...launchOptions,providerArgs:[],proxyUrl:'http://hub:'+'0'.repeat(64)+'@127.0.0.1:1'});
    // Pin the already-resolved physical base on every describe. This metadata
    // becomes part of both the approval and persisted conversation binding.
    const runtimeIdentity=await identityFor(plan.runtimeBase);
    const fingerprintDescriptor=runtimeIdentity&&Object.getOwnPropertyDescriptor(runtimeIdentity,'rootFingerprint');
    const runtimeBaseFingerprint=fingerprintDescriptor&&Object.hasOwn(fingerprintDescriptor,'value')?fingerprintDescriptor.value:null;
    if(typeof runtimeBaseFingerprint!=='string'||!(/^[0-9a-f]{64}$/).test(runtimeBaseFingerprint))throw fail();
    // Refuse known invalid binaries before reserving an endpoint/broker. Host
    // repeats these checks immediately before supervisedSpawn; no gate relaxed.
    for(const file of [plan.providerFile,plan.file]){
      safe.localPath(file);const stat=fs.lstatSync(file,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink?.()||stat.nlink!==1n||stat.size<1n||stat.size>512n*1024n*1024n)throw fail();
    }
    if(artifacts.digestFile(plan.providerFile)!==host.PROVIDER_HASHES[r.actor]||artifacts.digestFile(plan.file)!==plan.codexSHA256)throw fail();
    // Only metadata is inspected. Credential bytes are never read or hashed.
    // Identity pins the owner credential location, not its refreshable contents.
    // An account switch in the same file is left to the provider; a rejected
    // resume is retired by the runtime session fallback.
    const identity=plan.credentialFiles.map(file=>{
      safe.localPath(file);const st=fs.lstatSync(file,{bigint:true});
      if(!st.isFile()||st.nlink!==1n||st.size>4n*1024n*1024n)throw fail();
      return {path:process.platform==='win32'?file.toLowerCase():file,device:String(st.dev)};
    });
    if(plan.lockFile){safe.localPath(plan.lockFile);const st=fs.lstatSync(plan.lockFile);if(!st.isFile()||st.nlink!==1||st.size>4*1024*1024)throw fail();}
    const accountProfileId='auth-'+hash(identity);
    const runtimeProfileId='runtime-'+hash({actor:r.actor,policyVersion:4,
      runtimeBase:plan.runtimeBase,runtimeBaseFingerprint,userProfileMode:'owner-home',
      ...(r.actor==='grok'?{subagentRouting:'runtime-parent-prompt-v2'}:{}),
      stateDirectory:plan.stateDirectory,
      tools:r.actor==='grok'?GROK_PROFILE:CLAUDE_TOOLS,mcp:'controller-registered-only'});
    const descriptor={scope:{project:r.project,task:r.task,actor:r.actor,runtimeProfileId,accountProfileId,rootFingerprint:binding.rootFingerprint},
      modelFlag,effortFlag,maxWallMs:plan.maxWallMs,launchOptions,
      ...(r.actor==='claude'?{validatedMcpConfig:{mcpServers:{}}}:{validatedMcpServers:[],validatedAgentProfile:GROK_PROFILE})};
    const review={destination:r.actor==='claude'?'Anthropic':'xAI',workspace:binding.dir,rootFingerprint:binding.rootFingerprint,
      modelFlag,effortFlag,maxWallMs:plan.maxWallMs,authenticationRead:plan.credentialFiles,lockWrite:plan.lockFile,
      runtimeBase:plan.runtimeBase,runtimeBaseFingerprint,
      sessionWrite:plan.stateDirectory,tempWrite:plan.tempDirectory,mcpCredentialRead:plan.mcpDirectory,providerSHA256:host.PROVIDER_HASHES[r.actor],codexSHA256:plan.codexSHA256,
      accountProfileId,runtimeProfileId,credentialContentVisibleToOwnCliTools:true,
      commands:'核准工作區內的完整開發命令與 CLI 子代理；不提供 Hub owner 憑證。',
      mcp:'只由控制端供應已核准註冊及 task/run 限定的 MCP。',
      networkHosts:r.actor==='claude'?['api.anthropic.com','claude.ai']:['api.x.ai','cli-chat-proxy.grok.com']};
    return {binding,descriptor,review};
  }
  handlers(){
    const supplied=this.#runtime.handlers(),handlers={};
    for(const [actor,handler] of Object.entries(supplied)){
      handlers[actor]=Object.freeze({...handler,authority:this.#authorities[actor],onApprovals:(child,context,rows)=>{
        // CLI default becomes a concrete, bridge-validated model for the
        // existing tool policy only; the launch and session selection stay default.
        if(!rows.length)return;
        let policyContext=context;
        if(['claude','grok'].includes(actor)&&context.modelFlag===''){
          if(typeof child.reportedModel!=='string'||!(actor==='claude'?/^claude-[a-z0-9-]+$/:/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/).test(child.reportedModel)||child.reportedModel!==child.reportedModel.trim()){child.kill();return;}
          policyContext=Object.freeze({...context,modelFlag:child.reportedModel});
        }
        const policy=this.#toolPolicy(policyContext);if(!policy)return;
        for(const row of rows){
          if(row.project!==context.project||row.task!==context.task||row.runId!==context.runId||!child.listApprovals().some(a=>a.token===row.token))continue;
          let detail;try{detail=JSON.parse(row.detail);}catch{child.kill();return;}
          const decision=decide(actor,detail,policy);if(decision==='manual')continue;
          try{this.#recordDecision(context,row,decision);}
          catch{child.kill();return;}
          child.respond(row.token,decision==='accept'?'accept':'decline');
        }
      }});
    }
    return Object.freeze(handlers);
  }
  authorities(){return this.#authorities;}
  prepareTurn(o){
    const r={actor:o.ai,project:o.project,task:o.task,dir:o.dir,model:o.model,effort:o.effort??'',rootFingerprint:o.nativeRootPin?.rootFingerprint};
    return this.#runtime.prepareTurn(r);
  }
  preview(r){return this.#approvals.preview(r);}
  approve(r){return this.#approvals.approve(r);}
  async revoke(r){const changed=this.#approvals.revoke(r);await this.#runtime.cancel(r);return {ok:true,revoked:changed};}
  cancel(r){return this.#runtime.cancel(r);}
  active(){return this.#runtime.active();}
}
module.exports={NativeProviderService,GROK_PROFILE};
