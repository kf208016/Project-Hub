# Test helper: writes a desktop-state.json exactly like start-windows.ps1 does (same fields, same DPAPI entropy).
# The synthetic credential arrives on stdin only. It is never an argument.
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$HubDir
)
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$entropy = [Text.Encoding]::UTF8.GetBytes('ProjectHub.Windows.Launcher.v1')
$token = [Console]::In.ReadToEnd().Trim()
$process = Get-Process -Id $ProcessId
$protected = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($token), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser))
$state = @{ version = 1; root = $Root; hubDir = $HubDir; pid = $process.Id; createdTicks = $process.StartTime.ToUniversalTime().Ticks.ToString(); port = $Port; protectedToken = $protected; recoveryOnly = $false }
$logDir = Join-Path $Root '_hub'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
[IO.File]::WriteAllText((Join-Path $logDir 'desktop-state.json'), ($state | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
