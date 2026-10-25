'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {localPath}=require('./safe-path');
const MAX=50*1024*1024,OUTPUT_MAX=140*1024*1024,TIMEOUT=15000;
const FORMATS=new Map([['.png','png'],['.jpg','jpeg'],['.jpeg','jpeg'],['.gif','gif'],['.webp','webp'],['.heic','heic']]);
let binary,digest;
function fail(code) {const e=Error('Windows 圖片處理拒絕：'+code);e.code=code;return e;}
function ensure() {
  if(process.platform!=='win32'||process.arch!=='x64')throw fail('UNSUPPORTED_PLATFORM');
  if(binary) {localPath(binary);if(createHash('sha256').update(fs.readFileSync(binary)).digest('hex')!==digest)throw fail('HELPER_CHANGED');return binary;}
  const source=localPath(path.join(__dirname,'../windows/image-codec.cs'));
  const runtime=localPath(path.join(__dirname,'../.runtime'),{allowMissing:true});fs.mkdirSync(runtime,{recursive:true});
  const file=localPath(path.join(runtime,'image-codec-'+randomUUID()+'.exe'),{allowMissing:true});
  try {
    const compiler=localPath(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'));
    execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll','/out:'+file,source],{timeout:30000,maxBuffer:128*1024,windowsHide:true,stdio:'pipe'});
    digest=createHash('sha256').update(fs.readFileSync(file)).digest('hex');binary=file;return file;
  } catch {try{fs.unlinkSync(file);}catch{}throw fail('COMPILATION_FAILED');}
}
function parse(raw,expected) {
  if(!Buffer.isBuffer(raw)||raw.length>OUTPUT_MAX)throw fail('INVALID_RESPONSE');
  const newline=raw.indexOf(10);if(newline<1||newline>1024)throw fail('INVALID_RESPONSE');
  let value;try{value=JSON.parse(raw.subarray(0,newline).toString('utf8'));}catch{throw fail('INVALID_RESPONSE');}
  if(!value||value.ok!==true)throw fail(typeof value?.code==='string'&&/^[A-Z_]{1,64}$/.test(value.code)?value.code:'DECODE_FAILED');
  const keys=Object.keys(value).sort().join(','),fallback=keys==='backend,backendVersion,convertedLength,format,frames,height,ok,width';
  if(keys!=='convertedLength,format,frames,height,ok,width'&&!fallback||fallback&&(value.backend!=='ffmpeg'||value.backendVersion!=='9.0.2-essentials_build-www.gyan.dev'||value.format!=='heic')||!['png','jpeg','gif','webp','heic'].includes(value.format)||!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1||value.width>32768||value.height>32768||value.width*value.height>32000000||!Number.isInteger(value.frames)||value.frames<1||value.frames>4096||!Number.isInteger(value.convertedLength)||value.convertedLength<0||value.convertedLength!==raw.length-newline-1)throw fail('INVALID_RESPONSE');
  if(value.format!==expected)throw fail('FORMAT_MISMATCH');
  const converted=value.convertedLength?Buffer.from(raw.subarray(newline+1)):null;
  if(['png','jpeg'].includes(value.format)?converted!==null:!converted||!converted.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw fail('INVALID_RESPONSE');
  return {format:value.format,width:value.width,height:value.height,frames:value.frames,converted,backend:fallback?'ffmpeg':'wic',...(fallback?{backendVersion:value.backendVersion}:{})};
}
function backendArgs(options) {
  const configured=options.heicDecoder ?? (['HUB_FFMPEG_PATH','HUB_FFMPEG_SHA256','HUB_FFMPEG_VERSION'].some(key=>process.env[key])?{path:process.env.HUB_FFMPEG_PATH,sha256:process.env.HUB_FFMPEG_SHA256,version:process.env.HUB_FFMPEG_VERSION}:null);
  if(configured===null)return [];
  if(!configured||typeof configured!=='object'||Array.isArray(configured)||Object.keys(configured).sort().join(',')!=='path,sha256,version'||typeof configured.path!=='string'||typeof configured.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(configured.sha256)||configured.version!=='9.0.2-essentials_build-www.gyan.dev')throw fail('BACKEND_CONFIG_INVALID');
  let file;try{file=localPath(configured.path);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size<256||stat.size>512*1024*1024)throw Error();}catch{throw fail('BACKEND_PATH_INVALID');}
  return [file,configured.sha256.toLowerCase(),configured.version];
}
function processImage(data,extension,options={}) {
  if(!Buffer.isBuffer(data)||data.length===0||data.length>MAX)throw fail('INPUT_LIMIT');
  const format=typeof extension==='string'&&FORMATS.get(extension.toLowerCase());if(!format)throw fail('FORMAT_UNSUPPORTED');
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='heicDecoder'))throw fail('BACKEND_CONFIG_INVALID');
  const args=format==='heic'?backendArgs(options):[];
  let raw;
  try {raw=execFileSync(ensure(),args,{input:data,timeout:TIMEOUT,maxBuffer:OUTPUT_MAX,windowsHide:true,encoding:null,env:{SystemRoot:process.env.SystemRoot||'C:\\Windows',WINDIR:process.env.SystemRoot||'C:\\Windows'}});}
  catch(error) {if(error.message?.startsWith('Windows 圖片處理拒絕：'))throw error;throw fail(error.code==='ETIMEDOUT'?'DECODE_TIMEOUT':'DECODE_INTERRUPTED');}
  const result=parse(raw,format);
  if(result.backend==='ffmpeg') {
    const verified=processImage(result.converted,'.png');
    if(verified.width!==result.width||verified.height!==result.height||verified.frames!==1)throw fail('BACKEND_OUTPUT_MISMATCH');
  }
  return result;
}
module.exports={process:processImage,parse,MAX,TIMEOUT};
