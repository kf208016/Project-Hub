param(
 [ValidateSet('Preview','Install','Start','Stop','Rollback','Status','Recover-Current')][string]$Action='Preview',
 [string]$PackageRoot='', [string]$ManifestSha256='',
 [string]$InstallBase=(Join-Path $env:LOCALAPPDATA 'ProjectHub'),
 [string]$DataRoot=(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'AI-Workspace'),
 [int]$Port=4545, [switch]$NoBrowser, [string]$Backup='', [string]$ExpectedHash=''
)
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw '需要 Windows。'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
if([int]((& $node --version).TrimStart('v').Split('.')[0]) -lt 22){throw '需要 Node.js 22 以上。'}
$options=@{}
if($Action -in @('Preview','Install')){$options=@{packageRoot=[IO.Path]::GetFullPath($PackageRoot);manifestSha256=$ManifestSha256.ToLowerInvariant()}}
elseif($Action -eq 'Recover-Current'){$options=@{backup=$Backup;expectedHash=$ExpectedHash.ToLowerInvariant()}}
elseif($Action -eq 'Start'){$options=@{noBrowser=[bool]$NoBrowser}}
$request=@{action=$Action.ToLowerInvariant();installBase=[IO.Path]::GetFullPath($InstallBase);dataRoot=[IO.Path]::GetFullPath($DataRoot);port=$Port;options=$options}|ConvertTo-Json -Depth 8 -Compress
$oldEncoding=$OutputEncoding
try{$OutputEncoding=[Text.UTF8Encoding]::new($false);$request | & $node (Join-Path $PSScriptRoot 'native-install.cjs');if($LASTEXITCODE -ne 0){throw '安裝操作失敗或未確認完成，請依錯誤及保留的版本／history 紀錄檢查；不自動重試。'}}finally{$OutputEncoding=$oldEncoding}
