param(
 [ValidateSet('Preview','Install','Start','Stop','Rollback','Status','Recover-Current')][string]$Action='Preview',
 [string]$PackageRoot='', [string]$ManifestSha256='',
 [string]$InstallBase=(Join-Path $env:LOCALAPPDATA 'ProjectHub'),
 [string]$DataRoot=(Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'AI-Workspace'),
 [int]$Port=4545, [switch]$NoBrowser, [switch]$RecoveryOnly, [string]$Backup='', [string]$ExpectedHash=''
)
$ErrorActionPreference='Stop'
if($RecoveryOnly -and $Action -ne 'Start'){throw 'RecoveryOnly 僅適用同版 Start。'}
if($env:OS -ne 'Windows_NT'){throw '需要 Windows。'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
if([int]((& $node --version).TrimStart('v').Split('.')[0]) -lt 22){throw '需要 Node.js 22 以上。'}
$options=@{}
if($Action -in @('Preview','Install')){$options=@{packageRoot=[IO.Path]::GetFullPath($PackageRoot);manifestSha256=$ManifestSha256.ToLowerInvariant()}}
elseif($Action -eq 'Recover-Current'){$options=@{backup=$Backup;expectedHash=$ExpectedHash.ToLowerInvariant()}}
elseif($Action -eq 'Start'){$options=@{noBrowser=[bool]$NoBrowser;recoveryOnly=[bool]$RecoveryOnly}}
$request=@{action=$Action.ToLowerInvariant();installBase=[IO.Path]::GetFullPath($InstallBase);dataRoot=[IO.Path]::GetFullPath($DataRoot);port=$Port;options=$options}|ConvertTo-Json -Depth 8 -Compress
$oldEncoding=$OutputEncoding
$tmp=[IO.Path]::Combine([IO.Path]::GetFullPath($env:TEMP),('project-hub-install-'+[Guid]::NewGuid().ToString('N')+'.json'))
try{
 $OutputEncoding=[Text.UTF8Encoding]::new($false)
 [IO.File]::WriteAllText($tmp,$request,[Text.UTF8Encoding]::new($false))
 # Windows PowerShell 5.1 turns native stderr into a terminating error under 'Stop'; keep the exit code path reachable.
 $previousPreference=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try{$output=@(& $node (Join-Path $PSScriptRoot 'native-install.cjs') --request-file $tmp 2>&1|ForEach-Object{"$_"});$exitCode=$LASTEXITCODE}finally{$ErrorActionPreference=$previousPreference}
 $output|ForEach-Object{Write-Output $_}
 if($exitCode -ne 0){
  if(($output|Out-String) -match 'INSTALL_BASE_VIRTUALIZED'){throw '目前在 MSIX 封裝環境或重新導向的安裝位置執行，資料可能是虛擬化副本。請從檔案總管或一般 PowerShell 執行安裝、啟動與停止。'}
  throw '安裝操作失敗或未確認完成，請依錯誤及保留的版本／history 紀錄檢查；不自動重試。'
 }
}finally{
 if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force}
 $OutputEncoding=$oldEncoding
}
