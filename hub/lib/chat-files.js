'use strict';
const path=require('node:path'),{randomUUID}=require('node:crypto');
const files=(pdir,task)=>({log:path.join(pdir,'.ai','chat',`${task}.jsonl`),meta:path.join(pdir,'.ai','chat',`${task}.json`),queue:path.join(pdir,'.ai','chat',`${task}.queue.json`)});
const metaTemp=f=>f+'.'+randomUUID()+'.tmp',queueTemp=f=>f+'.limit-'+process.pid+'.tmp';
const validTaskId=id=>typeof id==='string'&&/^[^/\\\0]+$/.test(id)&&!/^[_\.]/.test(id)&&!/[. ]$|[<>"|?*\x00-\x1f\x7f]/.test(id)&&!/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(id);
const patterns=[/^(.+)\.jsonl$/,/^(.+)\.queue\.json$/,/^(.+)\.json$/,/^(.+)\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/,/^(.+)\.queue\.json\.limit-[1-9][0-9]{0,9}\.tmp$/];
function taskOf(name,ids){if(typeof name!=='string')return null;for(const pattern of patterns){const id=name.match(pattern)?.[1];if(id&&validTaskId(id)&&ids.has(id))return id;}return null;}
module.exports={files,metaTemp,queueTemp,validTaskId,taskOf};
