(function(global){
  'use strict';
  const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
  function specOf(value){if(!value||!UUID.test(value.operation||'')||!HASH.test(value.sourceHash||'')||! /^[A-Za-z0-9_-]{43}$/.test(value.statusKey||'')||!Number.isSafeInteger(value.statusPort)||value.statusPort<1024||value.statusPort>65535)throw Error('重新啟動證明設定無效');return{operation:value.operation,sourceHash:value.sourceHash,statusKey:value.statusKey,statusPort:value.statusPort};}
  async function verify(response,challenge,spec,crypto=global.crypto){
    spec=specOf(spec);if(!HASH.test(challenge)||typeof response?.body!=='string'||response.body.length>4096||!HASH.test(response.proof||''))throw Error('重新啟動證明格式無效');
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(spec.statusKey),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const proof=Uint8Array.from(response.proof.match(/../g),hex=>parseInt(hex,16));
    if(!await crypto.subtle.verify('HMAC',key,proof,new TextEncoder().encode('hub-restart-status-v1\n'+challenge+'\n'+response.body)))throw Error('重新啟動證明不符');
    let body;try{body=JSON.parse(response.body);}catch{throw Error('重新啟動狀態無效');}
    if(!body||body.operation!==spec.operation||body.sourceHash!==spec.sourceHash||!['starting','ready','failed'].includes(body.phase)||body.phase==='ready'&&(!Number.isSafeInteger(body.pid)||body.pid<=0||typeof body.createdTicks!=='string'||! /^[0-9]{1,19}$/.test(body.createdTicks)))throw Error('重新啟動身分綁定不符');return body;
  }
  class RestartClient{
    constructor({fetch=global.fetch?.bind(global),crypto=global.crypto,notify=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),monotonic=()=>global.performance.now()}={}){Object.assign(this,{fetch,crypto,notify,sleep,monotonic});this.paused=false;this.spec=null;}
    pause(){this.paused=true;this.notify('pause');}
    resumePreflight(result){if(this.spec||result?.notStarted!==true||!['busy','preflight'].includes(result.stage))throw Error('缺少重新啟動尚未開始的證明');this.paused=false;this.notify('resume');}
    async wait(input){this.spec=specOf(input);this.pause();const began=this.monotonic();if(!Number.isFinite(began)||began<0)throw Error('重新啟動時計無效');
      for(let n=0;n<180;n++){
        const now=this.monotonic();if(!Number.isFinite(now)||now<began)throw Error('重新啟動時計無效');if(now-began>=90000)break;
        const bytes=this.crypto.getRandomValues(new Uint8Array(32)),challenge=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
        try{const response=await this.fetch('http://127.0.0.1:'+this.spec.statusPort+'/status?'+new URLSearchParams({operation:this.spec.operation,challenge}),{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(3000)});if(response.ok){const body=await verify(await response.json(),challenge,this.spec,this.crypto);if(body.phase==='ready'){this.paused=false;this.notify('ready',body);return body;}if(body.phase==='failed')throw Error('Hub 重新啟動失敗：'+(body.error||'UNKNOWN'));}}
        catch(error){if(error.message.startsWith('Hub 重新啟動失敗')||error.message.startsWith('重新啟動'))throw error;}
        await this.sleep(500);
      }
      throw Error('無法取得重新啟動完成證明；介面已停止傳送憑證，請由啟動器重新開啟。');
    }
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={RestartClient,verify,specOf};
  else{
    const client=new RestartClient({notify:(type,body)=>global.dispatchEvent(new CustomEvent('hub-restart-'+type,{detail:body}))});let channel;
    if(typeof global.BroadcastChannel==='function'){channel=new global.BroadcastChannel('project-hub-native-restart-v1');channel.onmessage=event=>{if(event.data?.type==='pause')client.pause();if(event.data?.type==='begin')client.wait(event.data.spec).then(()=>global.location.reload()).catch(()=>{});if(event.data?.type==='resume-preflight'){try{client.resumePreflight(event.data.result);global.location.reload();}catch{}}};}
    client.broadcastPause=()=>{client.pause();channel?.postMessage({type:'pause'});};
    client.broadcastResumePreflight=result=>{client.resumePreflight(result);channel?.postMessage({type:'resume-preflight',result:{notStarted:true,stage:result.stage}});};
    client.begin=spec=>{spec=specOf(spec);channel?.postMessage({type:'begin',spec});return client.wait(spec);};global.HubNativeRestart=client;
  }
})(typeof window==='undefined'?globalThis:window);
