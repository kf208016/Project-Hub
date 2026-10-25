# Start/reopen local Hub. Closing the interface keeps owned jobs alive.
param([switch]$Stop, [switch]$Restart, [switch]$NoBrowser, [switch]$RecoveryOnly, [int]$ExpectedPid = 0, [string]$ExpectedCreatedTicks = '')
$ErrorActionPreference = 'Stop'
if ($Stop -and $Restart) { throw 'Stop and Restart are mutually exclusive.' }
if ($Stop -and $RecoveryOnly) { throw 'RecoveryOnly cannot be combined with Stop.' }
if (-not $Restart -and ($ExpectedPid -ne 0 -or $ExpectedCreatedTicks)) { throw 'Expected identity is only valid for Restart.' }
[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$entropy = [Text.Encoding]::UTF8.GetBytes('ProjectHub.Windows.Launcher.v1')
if ($env:OS -ne 'Windows_NT') { throw 'Windows is required.' }
$hubDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
function Confirm-LocalPaths([string[]]$paths) {
    Push-Location $hubDir
    try { & $node -e "try{for(const p of process.argv.slice(1))require('./lib/safe-path').localPath(p,{allowMissing:true})}catch{process.exit(1)}" @paths }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'The workspace and launcher files must be local paths without filesystem aliases.' }
}
function ConvertTo-WindowsArgument([string]$Value) {
    $result = New-Object Text.StringBuilder
    [void]$result.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$result.Append(('\' * (($backslashes * 2) + 1)))
            [void]$result.Append('"')
        } else {
            if ($backslashes -gt 0) { [void]$result.Append(('\' * $backslashes)) }
            [void]$result.Append($character)
        }
        $backslashes = 0
    }
    if ($backslashes -gt 0) { [void]$result.Append(('\' * ($backslashes * 2))) }
    [void]$result.Append('"')
    return $result.ToString()
}
if ([int]((& $node --version).TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
if (-not $RecoveryOnly -and -not $Stop) { Get-Command git.exe -ErrorAction Stop | Out-Null }
if (-not $RecoveryOnly -and -not $Stop) {
    Push-Location $hubDir
    try { $codexPath = & $node -e "const p=require('./lib/cli-platform').resolveProvider('codex');process.stdout.write(p.file)" 2>$null }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or -not $codexPath) { throw 'Codex CLI was not found in PATH.' }
}
$root = [IO.Path]::GetFullPath($(if ($env:HUB_ROOT) { $env:HUB_ROOT } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'AI-Workspace' }))
$logDir = Join-Path $root '_hub'
Confirm-LocalPaths @($root, $logDir)
if (-not $Stop) {
    Push-Location $hubDir
    try { & $node -e "try{require('./lib/web-chat-admission').check(process.argv[1],{hubDir:process.cwd(),recoveryOnly:process.argv[2]==='1'})}catch(error){process.stderr.write(error.message);process.exit(1)}" $root $(if ($RecoveryOnly) { '1' } else { '0' }) }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'The selected release cannot start this DataRoot in the requested mode.' }
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$statePath = Join-Path $logDir 'desktop-state.json'
$lockPath = Join-Path $logDir 'desktop-launch.lock'
Confirm-LocalPaths @($statePath, $lockPath, (Join-Path $logDir 'roles.yaml'), (Join-Path $logDir 'server.stdout.log'), (Join-Path $logDir 'server.stderr.log'), (Join-Path $logDir 'Trash'), (Join-Path $root 'Product'), (Join-Path $root 'Work'))
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$ownedProcess = $null
$completed = $false
function New-HexChallenge {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Confirm-Instance([int]$port, [string]$secret) {
    $challenge = New-HexChallenge
    $hmac = New-Object Security.Cryptography.HMACSHA256
    try {
        $hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
        $expected = ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('project-hub-instance-v1:' + $challenge)))).Replace('-', '').ToLowerInvariant()
    } finally { $hmac.Dispose() }
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/local/proof?challenge=$challenge" -TimeoutSec 2
    if ($result.proof -cne $expected) { throw 'Local service identity verification failed. No login credential was sent.' }
}
try {
    $port = if ($env:HUB_PORT) { [int]$env:HUB_PORT } else { 4545 }
    if ($port -lt 1024 -or $port -gt 65535) { throw 'HUB_PORT must be between 1024 and 65535.' }
    $running = $false
    if (Test-Path -LiteralPath $statePath) {
        $stateFile = Get-Item -LiteralPath $statePath
        if ($stateFile.PSIsContainer -or $stateFile.Length -gt 16384) { throw 'The saved launcher state is not a bounded regular file.' }
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($state.version -isnot [int] -or $state.version -ne 1 -or $state.pid -isnot [int] -or $state.pid -le 0 -or
            $state.createdTicks -isnot [string] -or $state.createdTicks -notmatch '^[0-9]{1,19}$') { throw 'The saved launcher state has invalid process identity fields.' }
        $stateNode = $node
        if ($state.PSObject.Properties.Name -contains 'node') {
            if ($state.node -isnot [string] -or -not [IO.Path]::IsPathRooted($state.node)) { throw 'The saved launcher node path is invalid.' }
            $stateNode = [IO.Path]::GetFullPath($state.node)
        }
        $savedProcess = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
        $identityMatches = $false
        if ($savedProcess) {
            try { $identityMatches = $savedProcess.StartTime.ToUniversalTime().Ticks.ToString() -eq $state.createdTicks -and $savedProcess.Path -ieq $stateNode }
            catch { throw 'The saved launcher process identity could not be verified.' }
        }
        if (-not $identityMatches) {
            $stalePath = Join-Path $logDir ('desktop-state.stale-' + $state.createdTicks + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.json')
            Confirm-LocalPaths @($stalePath)
            Move-Item -LiteralPath $statePath -Destination $stalePath
            Write-Host 'Cleared stale launcher state.'
            $state = $null
            if ($Stop) { $completed = $true; return }
        } else {
            if ($null -ne $state.recoveryOnly -and $state.recoveryOnly -isnot [bool]) { throw 'The saved launcher recovery mode is invalid.' }
            if ($state.root -isnot [string] -or $state.hubDir -isnot [string] -or $state.root -cne $root -or $state.hubDir -cne $hubDir) { throw 'The saved launcher state belongs to a different workspace/version directory.' }
            if ($state.port -isnot [int] -or $state.port -lt 1024 -or $state.port -gt 65535 -or
                $state.protectedToken -isnot [string] -or $state.protectedToken.Length -gt 8192 -or $state.protectedToken -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'The saved launcher state has invalid credential fields.' }
            $port = [int]$state.port
            $token = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($state.protectedToken), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser))
            if ($token -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw 'The saved launcher credential is invalid.' }
            Confirm-Instance $port $token
            $running = $true
            if (-not $Stop -and [bool]$state.recoveryOnly -ne [bool]$RecoveryOnly) { throw 'The running instance uses a different recovery mode. Stop its verified instance first.' }
        }
    }
    $restartToken = $null
    if ($Restart) {
        if (-not $running) { throw 'Restart requires the verified running workspace instance.' }
        if ($ExpectedPid -le 0 -or $ExpectedCreatedTicks -notmatch '^[0-9]{1,19}$' -or $state.pid -ne $ExpectedPid -or $state.createdTicks -cne $ExpectedCreatedTicks) { throw 'Restart owner identity changed; the service has not been stopped.' }
        $restartToken = $token
        $restartSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/local/login" -Method Post -ContentType 'application/json' -Headers @{ 'X-Hub' = '1' } -Body (@{token=$token}|ConvertTo-Json -Compress) -WebSession $restartSession | Out-Null
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/quit" -Method Post -ContentType 'application/json' -Headers @{ 'X-Hub' = '1' } -Body '{"reason":"windows-restart"}' -WebSession $restartSession | Out-Null
        if (-not $savedProcess.WaitForExit(10000)) { throw 'Restart did not stop the verified old process; saved state has been retained.' }
        $running = $false
    }
    if ($Stop) {
        if (-not $running) { Write-Host 'Project Hub is not running for this workspace.'; $completed = $true; return }
        $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/local/login" -Method Post -ContentType 'application/json' -Headers @{ 'X-Hub' = '1' } -Body (@{token=$token}|ConvertTo-Json -Compress) -WebSession $session | Out-Null
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/quit" -Method Post -ContentType 'application/json' -Headers @{ 'X-Hub' = '1' } -Body '{"reason":"windows-launcher"}' -WebSession $session | Out-Null
        if (-not $savedProcess.WaitForExit(5000)) { throw 'Hub has not exited; its state has been retained.' }
        Remove-Item -LiteralPath $statePath
        $completed = $true
        Write-Host 'Project Hub stopped.'
        return
    }
    if (-not $running) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start() } catch { throw "Port $port is occupied by an unverified service. No login credential was sent." } finally { $listener.Stop() }
        New-Item -ItemType Directory -Force -Path (Join-Path $root 'Product'), (Join-Path $root 'Work') | Out-Null
        $rolesFile = Join-Path $logDir 'roles.yaml'
        if (-not (Test-Path -LiteralPath $rolesFile)) { Copy-Item -LiteralPath (Join-Path $hubDir 'windows\roles.yaml') -Destination $rolesFile }
        if ($restartToken) { $token = $restartToken }
        else {
            $tokenBytes = New-Object byte[] 32
            $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
            $token = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
        }
        $env:HUB_ROOT = $root
        $env:HUB_TRASH = Join-Path $logDir 'Trash'
        $env:HUB_PORT = "$port"
        $env:HUB_LOCAL_TOKEN = $token
        $env:HUB_RECOVERY_ONLY = $(if ($RecoveryOnly) { '1' } else { '0' })
        try {
            $ownedProcess = Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $hubDir -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $logDir 'server.stdout.log') -RedirectStandardError (Join-Path $logDir 'server.stderr.log')
            [void]$ownedProcess.Handle
        } finally { Remove-Item Env:HUB_LOCAL_TOKEN -ErrorAction SilentlyContinue }
        $ready = $false
        for ($i = 0; $i -lt 40; $i++) {
            if ($ownedProcess.HasExited) { throw "Project Hub stopped during startup. Check $logDir." }
            try { Confirm-Instance $port $token; $ready = $true; break } catch { Start-Sleep -Milliseconds 250 }
        }
        if (-not $ready) { throw "Hub did not pass instance verification. Check $logDir." }
        $protected = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($token), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser))
        $state = @{version=1;root=$root;hubDir=$hubDir;node=$node;pid=$ownedProcess.Id;createdTicks=$ownedProcess.StartTime.ToUniversalTime().Ticks.ToString();port=$port;protectedToken=$protected;recoveryOnly=[bool]$RecoveryOnly}
        $tempState = $statePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        Confirm-LocalPaths @($statePath, $tempState)
        [IO.File]::WriteAllText($tempState, ($state|ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempState -Destination $statePath -Force
    }
    $completed = $true
    if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
        $url = "http://127.0.0.1:$port/"
        $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $edge) { Start-Process -FilePath $edge -ArgumentList @('--no-first-run', '--no-default-browser-check', "--app=$url") | Out-Null }
        else { Start-Process -FilePath 'explorer.exe' -ArgumentList @($url) | Out-Null }
    }
    Write-Host "Project Hub is running on 127.0.0.1:$port. Close the interface to keep working in the background."
    Write-Host 'Re-run this launcher to reopen it; use -Stop after active AI work finishes.'
} finally {
    if (-not $completed -and $ownedProcess -and -not $ownedProcess.HasExited) { $ownedProcess.Kill(); $ownedProcess.WaitForExit() }
    $lock.Dispose()
    # Keep the lock inode. Removing it after release can race another launcher.
}
