'use strict';
// Loopback synthetic certificates only. Certificate verification stays enabled;
// DPAPI and the actual Hub HTTPS/configuration routes are exercised by callers.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),https=require('node:https'),tls=require('node:tls'),{execFileSync}=require('node:child_process');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function nativeTlsFixture(root){
  const certFile=path.join(root,'synthetic-certificate.pem'),keyFile=path.join(root,'synthetic-private.key'),configFile=path.join(root,'synthetic-openssl.cnf');fs.writeFileSync(configFile,'[req]\ndistinguished_name=dn\n[dn]\n');
  execFileSync(path.join(process.env.ProgramFiles||'C:\\Program Files','Git/usr/bin/openssl.exe'),['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-config',configFile],{windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000});
  const config={host:'localhost',bindAddress:'127.0.0.1',port:await freePort(),certFile,keyFile},certificate=fs.readFileSync(certFile);
  const request=(route,{body,headers={},cookie,method,peer}={})=>new Promise((resolve,reject)=>{
    const data=body===undefined?null:JSON.stringify(body),req=https.request({hostname:'127.0.0.1',port:config.port,path:encodeURI(route),servername:'localhost',ca:certificate,checkServerIdentity:(_,cert)=>tls.checkServerIdentity('localhost',cert),...(peer?{localAddress:peer}:{}),method:method||(data?'POST':'GET'),headers:{Host:config.host+':'+config.port,...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-Hub':'1',Origin:'https://'+config.host+':'+config.port}:{}),...(cookie?{Cookie:cookie}:{}),Connection:'close',...headers}},res=>{
      const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8'),value={status:res.statusCode,headers:{get:key=>{const v=res.headers[key.toLowerCase()];return Array.isArray(v)?v.join(', '):v??null;}},text:async()=>text,json:async()=>JSON.parse(text)};value.clone=()=>value;resolve(value);});
    });req.setTimeout(60000,()=>req.destroy(Error('synthetic HTTPS request timeout')));req.on('error',reject);if(data)req.write(data);req.end();
  });return {config,request,origin:'https://localhost:'+config.port};
}
module.exports={freePort,nativeTlsFixture};
