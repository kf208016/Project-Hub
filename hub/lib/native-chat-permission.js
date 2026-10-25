'use strict';
const providers=require('./provider-registry');
// Native Chat uses the private prepared runtime. Never ask the legacy raw
// command resolver to construct a command, and never grant a PTY authority.
function forChat(ai,{legacy,platform=process.platform,nativeAuthorities}={}){
  const actor=providers.cliActor(ai).id;
  if(platform==='win32'&&['claude','grok'].includes(actor)){
    providers.assertCapability(actor,'chat',{platform,nativeAuthorities});
    return 'hub-native-chat:'+actor;
  }
  if(typeof legacy!=='function')throw Error('Chat permission resolver unavailable');
  return legacy(actor);
}
module.exports={forChat};
