'use strict';
const path=require('node:path'),{execFileSync}=require('node:child_process');
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const owned=new Map();
function rememberPid(pid){
 if(!Number.isSafeInteger(pid)||pid<=0||owned.has(pid))return;
 try{const ticks=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`],{windowsHide:true,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();if(/^[0-9]{1,19}$/.test(ticks))owned.set(pid,ticks);}catch{}
}
function killPid(pid){
 const ticks=owned.get(pid);owned.delete(pid);if(!ticks)return;
 // Check and terminate the same Process object, not a newly looked-up PID.
 try{execFileSync(ps,['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid} -ErrorAction Stop;if($p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${ticks}'){$p.Kill()}`],{windowsHide:true,timeout:15000,stdio:'ignore'});}catch{}
}
function killPidWithTicks(pid,ticks){if(!Number.isSafeInteger(pid)||pid<=0||!/^[0-9]{1,19}$/.test(String(ticks)))return;owned.set(pid,String(ticks));killPid(pid);}
module.exports={rememberPid,killPid,killPidWithTicks};
