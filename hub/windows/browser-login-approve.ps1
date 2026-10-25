<#
.SYNOPSIS
  Native owner approval for the one-time browser login (Windows PowerShell 5.1).

.DESCRIPTION
  The browser shows a public 32-hex request ID. This script lets the Windows owner
  approve exactly that ID. It never starts, stops or restarts any service: it only
  talks to an already running Hub whose identity it can prove.

  Order of checks (every failure stops before the owner credential leaves memory):
    1. exact DataRoot / hubDir / port, local non-aliased paths, bounded regular state file
    2. saved PID + creation time + node.exe path, and EVERY listener on the port belongs to that PID on 127.0.0.1
    3. DPAPI (CurrentUser) unprotect of the saved credential, held only in this process
    4. HMAC instance proof from GET /api/local/proof BEFORE the credential is sent anywhere
    5. login (credential in the JSON body only) -> approve the exact ID with the resulting owner cookie

  The credential never appears in argv, URL, environment, files, clipboard or output.
  Output is one fixed JSON line. A failure carries only a fixed reason code.

.PARAMETER DataRoot
  Exact Hub data root (the launcher's HUB_ROOT after GetFullPath).

.PARAMETER Port
  Exact Hub TCP port.

.PARAMETER RequestId
  Optional. Exactly 32 lowercase hex characters. When omitted a native window asks for it.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$Port,
    [string]$RequestId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
# Must stay identical to start-windows.ps1; a test compares the two files.
$script:Entropy = [Text.Encoding]::UTF8.GetBytes('ProjectHub.Windows.Launcher.v1')
$script:HubDir = Split-Path -Parent $PSScriptRoot
$script:MaxStateBytes = 16384
$script:MaxResponseBytes = 4096

function Fail([string]$Code) { throw ('HUBLOGIN:' + $Code) }

function Get-ReasonCode($ErrorRecord) {
    $message = [string]$ErrorRecord.Exception.Message
    if ($message -cmatch '\AHUBLOGIN:([A-Z_]{1,40})\z') { return $Matches[1] }
    return 'INTERNAL'
}

# .NET '$' also matches before a trailing newline, so every check uses \A ... \z.
function Test-RequestId([string]$Value) {
    return ($Value -cmatch '\A[0-9a-f]{32}\z')
}

function ConvertTo-Hex([byte[]]$Bytes) {
    return ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
}

function Test-FixedTimeEqual([string]$Left, [string]$Right) {
    $a = [Text.Encoding]::ASCII.GetBytes($Left)
    $b = [Text.Encoding]::ASCII.GetBytes($Right)
    if ($a.Length -ne $b.Length) { return $false }
    $difference = 0
    for ($i = 0; $i -lt $a.Length; $i++) { $difference = $difference -bor ($a[$i] -bxor $b[$i]) }
    return ($difference -eq 0)
}

function Resolve-DataRoot([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -cmatch '[\x00-\x1F\x7F"]') { Fail 'INVALID_DATA_ROOT' }
    if ($Value.StartsWith('\\') -or $Value.StartsWith('//')) { Fail 'INVALID_DATA_ROOT' }
    $full = $null
    try { $full = [IO.Path]::GetFullPath($Value) } catch { Fail 'INVALID_DATA_ROOT' }
    if ($full -cnotmatch '\A[A-Za-z]:\\') { Fail 'INVALID_DATA_ROOT' }
    return $full
}

# Same node-based alias check the launcher uses (no junction, symlink, ADS, device or network path).
function Confirm-LocalPaths([string]$NodeFile, [string[]]$Paths) {
    $code = 1
    Push-Location -LiteralPath $script:HubDir
    try {
        $null = & $NodeFile -e "try{for(const p of process.argv.slice(1))require('./lib/safe-path').localPath(p)}catch{process.exit(1)}" @Paths
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -ne 0) { Fail 'PATH_NOT_LOCAL' }
}

function Get-StateField($Object, [string]$Name) {
    if (-not ($Object.PSObject.Properties.Name -ccontains $Name)) { return $null }
    return $Object.PSObject.Properties[$Name].Value
}

# Parses the already opened state stream. The caller keeps the stream open for the whole handshake.
function Read-StateFromStream([IO.FileStream]$Stream, [string]$Root, [int]$ExpectedPort) {
    if ($Stream.Length -gt $script:MaxStateBytes) { Fail 'STATE_TOO_LARGE' }
    $buffer = New-Object byte[] ([int]$Stream.Length)
    $total = 0
    while ($total -lt $buffer.Length) {
        $read = $Stream.Read($buffer, $total, $buffer.Length - $total)
        if ($read -le 0) { break }
        $total += $read
    }
    if ($total -ne $buffer.Length) { Fail 'STATE_INVALID' }
    $parsed = $null
    try {
        $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($buffer)
        $parsed = $text | ConvertFrom-Json
    } catch { Fail 'STATE_INVALID' }
    if ($parsed -isnot [System.Management.Automation.PSCustomObject]) { Fail 'STATE_INVALID' }

    $version = Get-StateField $parsed 'version'
    $stateRoot = Get-StateField $parsed 'root'
    $stateHub = Get-StateField $parsed 'hubDir'
    $statePort = Get-StateField $parsed 'port'
    $statePid = Get-StateField $parsed 'pid'
    $ticks = Get-StateField $parsed 'createdTicks'
    $protected = Get-StateField $parsed 'protectedToken'
    $recovery = Get-StateField $parsed 'recoveryOnly'
    if ($version -isnot [int] -or $version -ne 1) { Fail 'STATE_INVALID' }
    if ($stateRoot -isnot [string] -or $stateHub -isnot [string]) { Fail 'STATE_INVALID' }
    if ($statePort -isnot [int] -or $statePid -isnot [int] -or $statePid -le 0) { Fail 'STATE_INVALID' }
    if ($ticks -isnot [string] -or $ticks -cnotmatch '\A[0-9]{1,19}\z') { Fail 'STATE_INVALID' }
    if ($protected -isnot [string] -or $protected.Length -gt 8192 -or $protected -cnotmatch '\A[A-Za-z0-9+/]+={0,2}\z') { Fail 'STATE_INVALID' }
    if ($null -ne $recovery -and $recovery -isnot [bool]) { Fail 'STATE_INVALID' }
    if ($stateRoot -cne $Root) { Fail 'STATE_ROOT_MISMATCH' }
    if ($stateHub -cne $script:HubDir) { Fail 'STATE_HUBDIR_MISMATCH' }
    if ($statePort -ne $ExpectedPort) { Fail 'STATE_PORT_MISMATCH' }
    return [pscustomobject]@{ ProcessId = $statePid; Ticks = $ticks; Protected = $protected }
}

function Confirm-OwnerProcess([int]$ProcessId, [string]$Ticks, [string]$NodeFile) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { Fail 'PROCESS_NOT_FOUND' }
    $file = $null
    $started = $null
    try {
        if ($process.HasExited) { $file = $null } else {
            $file = $process.Path
            $started = $process.StartTime.ToUniversalTime().Ticks.ToString()
        }
    } catch { Fail 'PROCESS_UNVERIFIABLE' }
    if (-not $file -or -not $started) { Fail 'PROCESS_NOT_FOUND' }
    if ($file -ine $NodeFile) { Fail 'PROCESS_PATH_MISMATCH' }
    if ($started -cne $Ticks) { Fail 'PROCESS_IDENTITY_MISMATCH' }
}

# EVERY listener on the port must be the saved process on 127.0.0.1; one foreign listener refuses.
function Confirm-OwnerListener([int]$ProcessId, [int]$ExpectedPort) {
    $rows = @(Get-NetTCPConnection -State Listen -LocalPort $ExpectedPort -ErrorAction SilentlyContinue)
    if ($rows.Count -lt 1) { Fail 'NO_LISTENER' }
    foreach ($row in $rows) {
        if ([int]$row.OwningProcess -ne $ProcessId -or [string]$row.LocalAddress -cne '127.0.0.1') { Fail 'LISTENER_MISMATCH' }
    }
}

function Get-OwnerToken([string]$Protected) {
    $plain = $null
    $text = $null
    try {
        $cipher = [Convert]::FromBase64String($Protected)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $script:Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $text = [Text.Encoding]::UTF8.GetString($plain)
    } catch { Fail 'CREDENTIAL_UNAVAILABLE' } finally {
        if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
    }
    if ($text -cnotmatch '\A[A-Za-z0-9_-]{43}\z') { Fail 'CREDENTIAL_INVALID' }
    return $text
}

function New-HubClient {
    [Net.ServicePointManager]::Expect100Continue = $false
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = New-Object System.Net.Http.HttpClient($handler, $true)
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    $client.MaxResponseContentBufferSize = 8192
    return $client
}

# One bounded request. Returns Status, parsed Json object and every Set-Cookie value.
function Invoke-HubJson($Client, [string]$Method, [string]$Uri, [string]$JsonBody, [string]$Cookie) {
    $request = $null
    $content = $null
    $response = $null
    try {
        $verb = if ($Method -ceq 'POST') { [System.Net.Http.HttpMethod]::Post } else { [System.Net.Http.HttpMethod]::Get }
        $request = New-Object System.Net.Http.HttpRequestMessage($verb, $Uri)
        [void]$request.Headers.TryAddWithoutValidation('X-Hub', '1')
        if ($Cookie) { [void]$request.Headers.TryAddWithoutValidation('Cookie', $Cookie) }
        if ($Method -ceq 'POST') {
            $content = New-Object System.Net.Http.StringContent($JsonBody, (New-Object Text.UTF8Encoding($false)), 'application/json')
            $request.Content = $content
        }
        $bytes = $null
        try {
            $response = $Client.SendAsync($request).GetAwaiter().GetResult()
            $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        } catch { Fail 'HTTP_FAILED' }
        if ($bytes.Length -gt $script:MaxResponseBytes) { Fail 'RESPONSE_TOO_LARGE' }
        $json = $null
        try { $json = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes) | ConvertFrom-Json } catch { Fail 'RESPONSE_INVALID' }
        if ($json -isnot [System.Management.Automation.PSCustomObject]) { Fail 'RESPONSE_INVALID' }
        $cookies = @()
        if ($response.Headers.Contains('Set-Cookie')) { $cookies = @($response.Headers.GetValues('Set-Cookie')) }
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Json = $json; SetCookie = $cookies }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $content) { $content.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
    }
}

function Confirm-InstanceProof($Client, [string]$BaseUri, [string]$Token) {
    $random = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($random) } finally { $generator.Dispose() }
    $challenge = ConvertTo-Hex $random
    $key = [Text.Encoding]::UTF8.GetBytes($Token)
    $hmac = New-Object Security.Cryptography.HMACSHA256
    $expected = $null
    try {
        $hmac.Key = $key
        $expected = ConvertTo-Hex ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('project-hub-instance-v1:' + $challenge)))
    } finally {
        $hmac.Dispose()
        [Array]::Clear($key, 0, $key.Length)
    }
    $result = Invoke-HubJson $Client 'GET' ($BaseUri + '/api/local/proof?challenge=' + $challenge) $null $null
    $proof = Get-StateField $result.Json 'proof'
    if ($result.Status -ne 200 -or $proof -isnot [string] -or $proof -cnotmatch '\A[0-9a-f]{64}\z') { Fail 'PROOF_MISMATCH' }
    if (-not (Test-FixedTimeEqual $proof $expected)) { Fail 'PROOF_MISMATCH' }
}

function Invoke-OwnerApproval([string]$ObservedRequestId) {
    if (-not (Test-RequestId $ObservedRequestId)) { Fail 'INVALID_REQUEST_ID' }
    if ($env:OS -ne 'Windows_NT') { Fail 'WINDOWS_REQUIRED' }
    $root = Resolve-DataRoot $DataRoot
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { Fail 'NODE_NOT_FOUND' }
    $nodeFile = [string]$nodeCommand.Source
    if (-not (Test-Path -LiteralPath (Join-Path $script:HubDir 'start-windows.ps1') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $script:HubDir 'lib\safe-path.js') -PathType Leaf)) { Fail 'RELEASE_INCOMPLETE' }

    $logDir = Join-Path $root '_hub'
    $statePath = Join-Path $logDir 'desktop-state.json'
    Confirm-LocalPaths $nodeFile @($root, $logDir)
    $info = New-Object IO.FileInfo($statePath)
    if (-not $info.Exists) { Fail 'STATE_MISSING' }
    if (($info.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)) -ne 0) { Fail 'STATE_INVALID' }
    Confirm-LocalPaths $nodeFile @($statePath)

    $approvalStateStream = $null
    $client = $null
    $token = $null
    $ownerCookie = $null
    try {
        # Share=Read keeps the checked file unchanged and undeletable until the handshake ends.
        try { $approvalStateStream = New-Object IO.FileStream($statePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read) }
        catch { Fail 'STATE_UNAVAILABLE' }
        $saved = Read-StateFromStream $approvalStateStream $root $Port
        Confirm-OwnerProcess $saved.ProcessId $saved.Ticks $nodeFile
        Confirm-OwnerListener $saved.ProcessId $Port

        $token = Get-OwnerToken $saved.Protected
        Add-Type -AssemblyName System.Net.Http
        $client = New-HubClient
        $base = 'http://127.0.0.1:' + $Port
        Confirm-InstanceProof $client $base $token

        # The proof only shows the listener knows the secret; re-bind identity right before sending it.
        Confirm-OwnerProcess $saved.ProcessId $saved.Ticks $nodeFile
        Confirm-OwnerListener $saved.ProcessId $Port

        $login = Invoke-HubJson $client 'POST' ($base + '/api/local/login') ('{"token":"' + $token + '"}') $null
        $loginOk = Get-StateField $login.Json 'ok'
        if ($login.Status -ne 200 -or $loginOk -isnot [bool] -or $loginOk -ne $true) { Fail 'LOGIN_REJECTED' }
        $cookieHeader = if ($login.SetCookie.Count -eq 1) { [string]$login.SetCookie[0] } else { '' }
        if ($cookieHeader -cnotmatch '\Ahub_local_session=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict\z') { Fail 'LOGIN_REJECTED' }
        $ownerCookie = $cookieHeader.Substring(0, $cookieHeader.IndexOf(';'))

        $approve = Invoke-HubJson $client 'POST' ($base + '/api/local/browser/approve') ('{"requestId":"' + $ObservedRequestId + '"}') $ownerCookie
        if ($approve.Status -eq 409) { Fail 'REQUEST_REJECTED' }
        $approveOk = Get-StateField $approve.Json 'ok'
        if ($approve.Status -ne 200 -or $approveOk -isnot [bool] -or $approveOk -ne $true) { Fail 'APPROVE_REJECTED' }
    } finally {
        if ($null -ne $client) { $client.Dispose() }
        if ($null -ne $approvalStateStream) { $approvalStateStream.Dispose() }
        $token = $null
        $ownerCookie = $null
    }
}

function Get-FriendlyMessage([string]$Reason) {
    $messages = @{
        'INVALID_REQUEST_ID' = '代碼格式不正確，請確認已貼上瀏覽器顯示的完整 32 碼。'
        'REQUEST_REJECTED'   = '代碼已逾時、已使用或不存在，請回到瀏覽器重新產生。'
        'STATE_MISSING'      = '找不到執行中的 Project Hub，未傳送任何登入憑證。'
        'PROCESS_NOT_FOUND'  = '找不到執行中的 Project Hub，未傳送任何登入憑證。'
        'NO_LISTENER'        = '找不到執行中的 Project Hub，未傳送任何登入憑證。'
        'PROOF_MISMATCH'     = '無法確認對方是這個 Hub，未傳送登入憑證。'
        'LISTENER_MISMATCH'  = '連接埠上有無法確認的服務，未傳送登入憑證。'
    }
    if ($messages.ContainsKey($Reason)) { return $messages[$Reason] }
    return '無法完成核准，未變更任何設定。請重新開啟啟動器後再試。'
}

# A process started with -WindowStyle Hidden hands that "hidden" flag to the FIRST ShowWindow call it makes, which would
# hide this dialog as well. Consuming that call on our own console lets the dialog appear. The P/Invoke is defined in
# memory with Reflection.Emit on purpose: Add-Type compiles through csc.exe into %TEMP%, which fails for a non-ANSI or
# read-only TEMP folder and would leave the hidden child without any window.
function Hide-OwnConsole {
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'HubLoginNative'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
    $builder = $assembly.DefineDynamicModule('HubLoginNative').DefineType('Win32', [Reflection.TypeAttributes]'Public, Class, Sealed, Abstract')
    function Add-Import($name, $library, $return, $parameters) {
        $method = $builder.DefinePInvokeMethod($name, $library, [Reflection.MethodAttributes]'Public, Static, PinvokeImpl, HideBySig', [Reflection.CallingConventions]::Standard, $return, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Auto)
        $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
    }
    Add-Import 'GetConsoleWindow' 'kernel32.dll' ([IntPtr]) ([Type[]]@())
    Add-Import 'GetConsoleProcessList' 'kernel32.dll' ([uint32]) ([Type[]]@([uint32[]], [uint32]))
    Add-Import 'ShowWindow' 'user32.dll' ([bool]) ([Type[]]@([IntPtr], [int]))
    $native = $builder.CreateType()
    $consoleProcesses = New-Object uint32[] 2
    # Only when this process is the only one attached to its console: a person who runs the script by hand from their
    # own console keeps that console (the process was not started hidden in that case either).
    if ($native::GetConsoleProcessList($consoleProcesses, 2) -eq 1) { [void]$native::ShowWindow($native::GetConsoleWindow(), 0) }
}

function Show-ApprovalDialog {
    Hide-OwnConsole

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $ui = @{ Approved = $false; Reason = 'CANCELLED' }
    $form = New-Object System.Windows.Forms.Form
    $timer = New-Object System.Windows.Forms.Timer
    try {
        $form.Text = 'Project Hub 本機登入確認'
        $form.ClientSize = New-Object System.Drawing.Size(480, 210)
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.TopMost = $true

        $label = New-Object System.Windows.Forms.Label
        $label.Text = '請貼上瀏覽器畫面顯示的「待核准代碼」（32 碼）。只核准您剛剛在自己的瀏覽器按下「產生一次性登入代碼」的那一個。'
        $label.SetBounds(16, 14, 448, 54)
        $form.Controls.Add($label)

        $box = New-Object System.Windows.Forms.TextBox
        $box.SetBounds(16, 76, 448, 26)
        $box.MaxLength = 80
        $box.Font = New-Object System.Drawing.Font('Consolas', 11)
        $form.Controls.Add($box)

        $status = New-Object System.Windows.Forms.Label
        $status.ForeColor = [System.Drawing.Color]::Firebrick
        $status.SetBounds(16, 110, 448, 40)
        $form.Controls.Add($status)

        $approve = New-Object System.Windows.Forms.Button
        $approve.Text = '核准登入'
        $approve.SetBounds(262, 164, 100, 30)
        $form.Controls.Add($approve)

        $cancel = New-Object System.Windows.Forms.Button
        $cancel.Text = '取消'
        $cancel.SetBounds(372, 164, 92, 30)
        $form.Controls.Add($cancel)
        $form.CancelButton = $cancel

        $timer.Interval = 180000
        $timer.Add_Tick({
            $ui.Reason = 'TIMEOUT'
            $form.Close()
        })
        $cancel.Add_Click({ $form.Close() })
        $approve.Add_Click({
            $status.Text = ''
            # Paste tolerance only: case, spaces and hyphens. The result still has to be exactly 32 lowercase hex.
            $candidate = ([string]$box.Text -replace '[\s-]', '').ToLowerInvariant()
            if (-not (Test-RequestId $candidate)) { $status.Text = Get-FriendlyMessage 'INVALID_REQUEST_ID'; return }
            $approve.Enabled = $false
            $cancel.Enabled = $false
            $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
            # The checks take a few seconds (listener inspection) and keep the UI thread busy; say so first.
            $status.ForeColor = [System.Drawing.SystemColors]::GrayText
            $status.Text = '正在核對 Hub，請稍候…'
            $status.Refresh()
            try {
                Invoke-OwnerApproval $candidate
                $ui.Approved = $true
                $ui.Reason = 'APPROVED'
                $form.Close()
            } catch {
                $status.ForeColor = [System.Drawing.Color]::Firebrick
                $status.Text = Get-FriendlyMessage (Get-ReasonCode $_)
                $approve.Enabled = $true
                $cancel.Enabled = $true
            } finally {
                $form.Cursor = [System.Windows.Forms.Cursors]::Default
            }
        })
        $timer.Start()
        [void]$form.ShowDialog()
    } finally {
        $timer.Stop()
        $timer.Dispose()
        $form.Dispose()
    }
    return $ui
}

function Write-Result([bool]$Ok, [string]$Reason) {
    if ($Ok) { [Console]::Out.WriteLine('{"ok":true,"code":"BROWSER_LOGIN_APPROVED"}') }
    else { [Console]::Out.WriteLine('{"ok":false,"code":"BROWSER_LOGIN_FAILED","reason":"' + $Reason + '"}') }
}

$exitCode = 1
try {
    if ($PSBoundParameters.ContainsKey('RequestId')) {
        Invoke-OwnerApproval $RequestId
        Write-Result $true ''
        $exitCode = 0
    } else {
        $outcome = @(Show-ApprovalDialog)[-1]
        if ($outcome.Approved) { Write-Result $true ''; $exitCode = 0 }
        else { Write-Result $false ([string]$outcome.Reason) }
    }
} catch {
    Write-Result $false (Get-ReasonCode $_)
}
exit $exitCode
