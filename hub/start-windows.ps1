# Windows browser entry point. Keep this PowerShell window open while using Hub.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows is required.' }
$hubDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw 'Node.js 22 or newer is required.' }
Get-Command git.exe -ErrorAction Stop | Out-Null
Push-Location $hubDir
try { $codexPath = & $node -e "const p=require('./lib/cli-platform').resolve('codex');process.stdout.write(p.file)" 2>$null }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0 -or -not $codexPath) { throw 'Codex CLI was not found in PATH.' }
$port = if ($env:HUB_PORT) { [int]$env:HUB_PORT } else { 4545 }
if ($port -lt 1024 -or $port -gt 65535) { throw 'HUB_PORT must be between 1024 and 65535.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
try { $listener.Start() } catch { throw "Port $port is already in use." } finally { $listener.Stop() }
$root = if ($env:HUB_ROOT) { $env:HUB_ROOT } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'AI-Workspace' }
$logDir = Join-Path $root '_hub'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'Product'), (Join-Path $root 'Work') | Out-Null
$rolesFile = Join-Path $logDir 'roles.yaml'
if (-not (Test-Path -LiteralPath $rolesFile)) { Copy-Item -LiteralPath (Join-Path $hubDir 'windows\roles.yaml') -Destination $rolesFile }
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$env:HUB_ROOT = $root
$env:HUB_TRASH = Join-Path $logDir 'Trash'
$env:HUB_PORT = "$port"
$env:HUB_LOCAL_TOKEN = $token
try {
  $process = Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $hubDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'server.stdout.log') -RedirectStandardError (Join-Path $logDir 'server.stderr.log')
} finally { Remove-Item Env:HUB_LOCAL_TOKEN -ErrorAction SilentlyContinue }
try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ($process.HasExited) { throw "Project Hub stopped during startup. Check $logDir." }
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/state" -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -ne 401) { throw 'The local API did not require authentication.' }
    } catch {
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $ready = $true; break }
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "Project Hub did not pass its local authentication check. Check $logDir." }
  if ($env:HUB_NO_BROWSER -ne '1') {
    try { Start-Process -FilePath 'explorer.exe' -ArgumentList @("http://127.0.0.1:$port/#auth=$token") -ErrorAction Stop | Out-Null }
    catch {
      Write-Warning '無法自動開啟瀏覽器，請在本機瀏覽器貼上下一行網址。'
      Write-Host "http://127.0.0.1:$port/#auth=$token"
    }
  }
  Write-Host "Project Hub is running on 127.0.0.1:$port. Press Ctrl+C here to stop it."
  $process.WaitForExit()
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
}
