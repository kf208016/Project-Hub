'use strict';
const {TextDecoder}=require('node:util');
const MAX_FRAME=1024*1024;
function rejected(code){return Object.assign(Error(code),{code});}
function check(condition,code){if(!condition)throw rejected(code);}
// JSON.parse alone silently replaces duplicate keys and can round integers.
function decode(bytes){
  check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_FRAME,'WORKER_FRAME_SIZE_BOUND');
  let source;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw rejected('WORKER_FRAME_ENCODING_INVALID');}
  let position=0,nodes=0;
  const space=()=>{while(/[\x20\x09\x0a\x0d]/.test(source[position]??'')&&position<source.length)position++;};
  function string(){
    const start=position;check(source[position++]==='"','WORKER_JSON_INVALID');
    let ended=false;
    while(position<source.length){const char=source[position++];if(char==='"'){ended=true;break;}check(char.charCodeAt(0)>=32,'WORKER_JSON_INVALID');if(char==='\\'){const next=source[position++];if(next==='u'){check(/^[0-9a-fA-F]{4}$/.test(source.slice(position,position+4)),'WORKER_JSON_INVALID');position+=4;}else check(next!==undefined&&'"\\/bfnrt'.includes(next),'WORKER_JSON_INVALID');}}
    check(ended,'WORKER_JSON_INVALID');let value;try{value=JSON.parse(source.slice(start,position));}catch{throw rejected('WORKER_JSON_INVALID');}
    check(value.isWellFormed()&&!value.includes('\0'),'WORKER_JSON_UNICODE_INVALID');return value;
  }
  function value(depth){
    check(depth<=16&&++nodes<=16384,'WORKER_JSON_COMPLEXITY_BOUND');space();const char=source[position];
    if(char==='"')return string();
    if(char==='{'){
      position++;space();const object=Object.create(null);if(source[position]==='}'){position++;return object;}
      while(true){space();check(depth+1<=16&&++nodes<=16384,'WORKER_JSON_COMPLEXITY_BOUND');const key=string();check(!Object.hasOwn(object,key),'WORKER_JSON_DUPLICATE_KEY');space();check(source[position++]===':','WORKER_JSON_INVALID');object[key]=value(depth+1);space();const separator=source[position++];if(separator==='}')return object;check(separator===',','WORKER_JSON_INVALID');}
    }
    if(char==='['){position++;space();const array=[];if(source[position]===']'){position++;return array;}while(true){array.push(value(depth+1));space();const separator=source[position++];if(separator===']')return array;check(separator===',','WORKER_JSON_INVALID');}}
    for(const [literal,result]of [['true',true],['false',false],['null',null]])if(source.startsWith(literal,position)){position+=literal.length;return result;}
    const match=source.slice(position).match(/^-?(?:0|[1-9][0-9]*)/);check(match,'WORKER_JSON_INVALID');position+=match[0].length;
    const number=Number(match[0]);check(Number.isSafeInteger(number),'WORKER_JSON_NUMBER_INVALID');return number;
  }
  const result=value(0);space();check(position===source.length&&result&&typeof result==='object'&&!Array.isArray(result),'WORKER_FRAME_OBJECT_REQUIRED');return result;
}
function canonical(value,depth=0,budget={nodes:0}){
  check(depth<=16&&++budget.nodes<=16384,'WORKER_JSON_COMPLEXITY_BOUND');
  if(typeof value==='string'){check(value.isWellFormed()&&!value.includes('\0'),'WORKER_JSON_UNICODE_INVALID');return JSON.stringify(value);}
  if(typeof value==='number'){check(Number.isSafeInteger(value),'WORKER_JSON_NUMBER_INVALID');return JSON.stringify(value);}
  if(value===null||typeof value==='boolean')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(item=>canonical(item,depth+1,budget)).join(',')+']';
  check(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'WORKER_JSON_TYPE_INVALID');
  return '{'+Object.keys(value).sort().map(key=>canonical(key,depth+1,budget)+':'+canonical(value[key],depth+1,budget)).join(',')+'}';
}
function encode(value){const body=Buffer.from(canonical(value));check(body.length>0&&body.length<=MAX_FRAME,'WORKER_FRAME_SIZE_BOUND');const prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);return Buffer.concat([prefix,body]);}
class FramedChannel{
  constructor(input,output){
    this.input=input;this.output=output;this.buffer=Buffer.alloc(0);this.queue=[];this.pending=null;this.error=null;
    input.on('data',chunk=>{try{this.accept(chunk);}catch(error){this.fail(error);}});
    input.on('error',()=>this.fail(rejected('WORKER_CHANNEL_IO_FAILED')));
    output.on('error',()=>this.fail(rejected('WORKER_CHANNEL_IO_FAILED')));
    input.on('end',()=>this.fail(rejected(this.buffer.length?'WORKER_FRAME_TRUNCATED':'WORKER_CHANNEL_EOF')));
  }
  accept(chunk){
    if(this.error)return;check(Buffer.isBuffer(chunk)&&this.buffer.length+chunk.length<=2*MAX_FRAME+8,'WORKER_CHANNEL_BUFFER_BOUND');
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4){
      const size=this.buffer.readUInt32BE(0);check(size>0&&size<=MAX_FRAME,'WORKER_FRAME_SIZE_BOUND');if(this.buffer.length<size+4)return;
      const message=decode(this.buffer.subarray(4,size+4));this.buffer=this.buffer.subarray(size+4);
      if(this.pending){const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.resolve(message);}
      else{check(this.queue.length<4,'WORKER_CHANNEL_QUEUE_BOUND');this.queue.push(message);}
    }
  }
  fail(error){if(this.error)return;this.error=error;if(error.code!=='WORKER_CHANNEL_EOF')this.queue=[];if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}this.input.destroy();}
  read(milliseconds=30000){
    check(Number.isSafeInteger(milliseconds)&&milliseconds>0&&milliseconds<=180000,'WORKER_TIMEOUT_INVALID');
    if(this.error&&!(this.error.code==='WORKER_CHANNEL_EOF'&&this.queue.length))return Promise.reject(this.error);if(this.queue.length)return Promise.resolve(this.queue.shift());check(!this.pending,'WORKER_CONCURRENT_READ_REJECTED');
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail(rejected('WORKER_CHANNEL_TIMEOUT')),milliseconds);this.pending={resolve,reject,timer};});
  }
  async write(message){if(this.error)throw this.error;const bytes=encode(message);await new Promise((resolve,reject)=>this.output.write(bytes,error=>error?reject(rejected('WORKER_CHANNEL_IO_FAILED')):resolve()));}
  close(){this.fail(rejected('WORKER_CHANNEL_CLOSED'));this.output.destroy();}
}
module.exports={MAX_FRAME,decode,encode,canonical,FramedChannel};
