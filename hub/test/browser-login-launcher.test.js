'use strict';
// Launcher and hidden approval window contract tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');

const win = process.platform === 'win32' ? test : test.skip;
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const launcher = path.join(__dirname, '../start-windows.ps1');
const approveScript = path.join(__dirname, '../windows/browser-login-approve.ps1');
const driver = path.join(__dirname, 'helpers/drive-approval-dialog.ps1');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function runPs(args, { env, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ps, args, { windowsHide: true, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(Error('powershell timed out\n' + stderr.slice(-1000))); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(Object.assign(Error(stderr || stdout), { code, stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function environment(root) {
  const fixture = require('./helpers/portable-cli').install(root, "if(process.argv.includes('--version')){console.log('codex-cli fixture');process.exit(0);}throw Error('launcher fixture must not run model requests');", 'codex');
  return { ...process.env, PATH: fixture.bin + path.delimiter + process.env.PATH, HUB_AI_HOME: path.join(root, 'home') };
}

function runLauncher(args, env) {
  return new Promise((resolve, reject) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-File', launcher, '-NoBrowser', ...args], { windowsHide: true, env, timeout: 30000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { safeOutput: String(stdout || '') + '\n' + String(stderr || '') }));
      else resolve(String(stdout || ''));
    });
  });
}

const {rememberPid,killPid,killPidWithTicks}=require('./helpers/owned-pid');

function writableDriver(dir) {
  const source = fs.readFileSync(driver);
  const frozen = Buffer.from('[Parameter(Mandatory = $true)][string]$Text,');
  const allowed = Buffer.from('[Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,');
  if (source.includes(allowed)) return driver;
  const at = source.indexOf(frozen);
  if (at < 0) throw Error('drive-approval-dialog.ps1 Text parameter is not the frozen signature');
  const copy = path.join(dir, 'drive-approval-dialog.ps1');
  fs.writeFileSync(copy, Buffer.concat([source.subarray(0, at), allowed, source.subarray(at + frozen.length)]));
  return copy;
}

const ANALYZER = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:HUB_PARSE_TARGET
$bytes = [System.IO.File]::ReadAllBytes($target)
$bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)
$high = 0
foreach ($b in $bytes) { if ($b -gt 127) { $high++ } }

function ConvertTo-Expr([System.Management.Automation.Language.Ast]$node) {
  if ($null -eq $node) { return $null }
  $text = $node.Extent.Text
  if ($node -is [System.Management.Automation.Language.ParenExpressionAst]) {
    $elements = @($node.Pipeline.PipelineElements)
    if ($elements.Count -eq 1) { return ConvertTo-Expr $elements[0] }
  }
  if ($node -is [System.Management.Automation.Language.SubExpressionAst]) {
    $stmts = @($node.SubExpression.Statements)
    if ($stmts.Count -eq 1) { return ConvertTo-StatementExpr $stmts[0] }
  }
  if ($node -is [System.Management.Automation.Language.ArrayExpressionAst]) { return ConvertTo-ArgumentValue $node }
  if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    return @{ kind = 'string'; value = [string]$node.Value; text = $text }
  }
  if ($node -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    return @{ kind = 'expandable'; text = $text }
  }
  if ($node -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    return @{ kind = 'constant'; value = [string]$node.Value; text = $text }
  }
  if ($node -is [System.Management.Automation.Language.VariableExpressionAst]) {
    return @{ kind = 'variable'; name = [string]$node.VariablePath.UserPath; text = $text }
  }
  if ($node -is [System.Management.Automation.Language.BinaryExpressionAst]) {
    return @{ kind = 'binary'; op = [string]$node.Operator; left = (ConvertTo-Expr $node.Left); right = (ConvertTo-Expr $node.Right); text = $text }
  }
  if ($node -is [System.Management.Automation.Language.CommandExpressionAst]) { return ConvertTo-Expr $node.Expression }
  if ($node -is [System.Management.Automation.Language.CommandAst]) { return ConvertTo-Command $node }
  if ($node -is [System.Management.Automation.Language.CommandParameterAst]) {
    return @{ kind = 'parameter'; name = [string]$node.ParameterName; text = $text }
  }
  if ($node -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($el in $node.Elements) { [void]$items.Add((ConvertTo-Expr $el)) }
    return @{ kind = 'array'; items = $items; text = $text }
  }
  return @{ kind = 'other'; type = $node.GetType().Name; text = $text }
}

function ConvertTo-Command([System.Management.Automation.Language.CommandAst]$cmd) {
  $cmdArgs = New-Object System.Collections.Generic.List[object]
  $first = $true
  foreach ($el in $cmd.CommandElements) {
    if ($first) { $first = $false; continue }
    [void]$cmdArgs.Add((ConvertTo-Expr $el))
  }
  return @{ kind = 'command'; name = [string]$cmd.GetCommandName(); args = $cmdArgs; text = $cmd.Extent.Text }
}

function ConvertTo-StatementExpr($node) {
  if ($null -eq $node) { return $null }
  if ($node -is [System.Management.Automation.Language.PipelineAst]) {
    $elements = @($node.PipelineElements)
    if ($elements.Count -eq 1) { return ConvertTo-Expr $elements[0] }
    return @{ kind = 'other'; type = 'PipelineAst'; text = $node.Extent.Text }
  }
  return ConvertTo-Expr $node
}

function ConvertTo-ArgumentValue([System.Management.Automation.Language.Ast]$node) {
  $expr = $node
  if ($expr -is [System.Management.Automation.Language.ArrayExpressionAst]) {
    $stmt = @($expr.SubExpression.Statements)[0]
    $pe = @($stmt.PipelineElements)[0]
    if ($pe -is [System.Management.Automation.Language.CommandExpressionAst]) { $expr = $pe.Expression }
  }
  if ($expr -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($el in $expr.Elements) { [void]$items.Add((ConvertTo-Expr $el)) }
    return @{ kind = 'array'; items = $items; text = $node.Extent.Text }
  }
  return ConvertTo-Expr $expr
}

function ConvertTo-StartProcess([System.Management.Automation.Language.CommandAst]$cmd) {
  $parameters = @{}
  $pending = $null
  foreach ($el in $cmd.CommandElements) {
    if ($el -is [System.Management.Automation.Language.CommandParameterAst]) { $pending = [string]$el.ParameterName; continue }
    if ($el -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $el.Value -eq 'Start-Process') { continue }
    $described = ConvertTo-ArgumentValue $el
    if ($pending) { $parameters[$pending] = $described; $pending = $null }
  }
  $tryNode = $null
  $ifNode = $null
  $outerIf = $null
  $parent = $cmd.Parent
  while ($parent) {
    if (-not $tryNode -and $parent -is [System.Management.Automation.Language.TryStatementAst]) { $tryNode = $parent }
    if (-not $ifNode -and $parent -is [System.Management.Automation.Language.IfStatementAst]) { $ifNode = $parent }
    if ($parent -is [System.Management.Automation.Language.IfStatementAst]) {
      foreach ($clause in $parent.Clauses) {
        $body = $clause.Item2
        $insideBody = $cmd.Extent.StartOffset -ge $body.Extent.StartOffset -and $cmd.Extent.EndOffset -le $body.Extent.EndOffset
        if ($insideBody) {
          $condText = $clause.Item1.Extent.Text
          if ($condText -match '\$NoBrowser\b' -and $condText -match 'HUB_NO_BROWSER') {
            $outerIf = @{ start = $parent.Extent.StartOffset; end = $parent.Extent.EndOffset; condition = $condText }
          }
        }
      }
    }
    $parent = $parent.Parent
  }
  $ifInfo = $null
  if ($ifNode) {
    $condition = ''
    foreach ($clause in $ifNode.Clauses) {
      $body = $clause.Item2
      if ($cmd.Extent.StartOffset -ge $body.Extent.StartOffset -and $cmd.Extent.EndOffset -le $body.Extent.EndOffset) { $condition = $clause.Item1.Extent.Text }
    }
    if (-not $condition) { $condition = $ifNode.Clauses[0].Item1.Extent.Text }
    $ifInfo = @{ start = $ifNode.Extent.StartOffset; end = $ifNode.Extent.EndOffset; condition = $condition }
  }
  $tryInfo = $null
  if ($tryNode) {
    $writeWarning = $false
    $throws = 0
    $exits = 0
    foreach ($catch in $tryNode.CatchClauses) {
      $warns = @($catch.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Write-Warning' }, $true))
      if ($warns.Count -gt 0) { $writeWarning = $true }
      $throws += @($catch.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.ThrowStatementAst] }, $true)).Count
      $exits += @($catch.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'exit' }, $true)).Count
      $exits += @($catch.Body.FindAll({ param($n) $n.GetType().Name -eq 'ExitStatementAst' }, $true)).Count
    }
    $tryInfo = @{ writeWarning = $writeWarning; throws = $throws; exits = $exits }
  }
  $tryInsideIf = $false
  if ($tryNode -and $ifNode) {
    $tryInsideIf = $tryNode.Extent.StartOffset -gt $ifNode.Extent.StartOffset -and $tryNode.Extent.EndOffset -lt $ifNode.Extent.EndOffset
  }
  $tryInsideOuter = $false
  if ($tryNode -and $outerIf) {
    $tryInsideOuter = $tryNode.Extent.StartOffset -ge $outerIf.start -and $tryNode.Extent.EndOffset -le $outerIf.end
  }
  $extent = $cmd.Extent.Text
  $hasToken = ($extent -match '\$token\b') -or ($extent -match 'HUB_LOCAL_TOKEN')
  return @{
    text = $extent
    start = $cmd.Extent.StartOffset
    end = $cmd.Extent.EndOffset
    hasToken = [bool]$hasToken
    parameters = $parameters
    if = $ifInfo
    outerIf = $outerIf
    tryCatch = $tryInfo
    tryInsideIf = [bool]$tryInsideIf
    tryInsideOuter = [bool]$tryInsideOuter
  }
}

function Get-Report([string]$source, [bool]$isFile) {
  $tokens = $null
  $errors = $null
  if ($isFile) { $ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors) }
  else { $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) }
  $commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Start-Process' }, $true))
  $starts = New-Object System.Collections.Generic.List[object]
  foreach ($cmd in $commands) { [void]$starts.Add((ConvertTo-StartProcess $cmd)) }
  $assignmentList = New-Object System.Collections.Generic.List[object]
  $assignNodes = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))
  foreach ($assign in $assignNodes) {
    if ([string]$assign.Operator -ne 'Equals') { continue }
    if (-not ($assign.Left -is [System.Management.Automation.Language.VariableExpressionAst])) { continue }
    $varName = [string]$assign.Left.VariablePath.UserPath
    if ($varName -match ':') { continue }
    [void]$assignmentList.Add(@{ name = $varName.ToLowerInvariant(); expr = (ConvertTo-StatementExpr $assign.Right); start = $assign.Extent.StartOffset })
  }
  $functionList = New-Object System.Collections.Generic.List[object]
  $fnNodes = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
  foreach ($fn in $fnNodes) {
    $entry = @{ name = [string]$fn.Name; start = $fn.Extent.StartOffset; end = $fn.Extent.EndOffset }
    if ($fn.Name.ToLowerInvariant() -eq 'convertto-windowsargument') { $entry.text = $fn.Extent.Text }
    [void]$functionList.Add($entry)
  }
  $urlToken = New-Object System.Collections.Generic.List[string]
  $auth = New-Object System.Collections.Generic.List[string]
  $exprs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ExpressionAst] }, $true))
  foreach ($n in $exprs) {
    $text = $n.Extent.Text
    if (($n -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) -and $text.Contains('#auth=')) {
      [void]$auth.Add($text)
    }
    if ($text.Length -le 500) {
      $url = ($text -match '127\.0\.0\.1') -or ($text -match '://localhost')
      $tok = ($text -match '\$token\b') -or ($text -match 'HUB_LOCAL_TOKEN')
      if ($url -and $tok) { [void]$urlToken.Add($text) }
    }
  }
  return @{
    parseErrors = $(if ($null -eq $errors) { 0 } else { @($errors).Count })
    startProcesses = $starts
    urlTokenExpressions = $urlToken
    authExpressions = $auth
    assignments = $assignmentList
    functions = $functionList
  }
}

$sample = @'
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  Start-Process -FilePath $browser -ArgumentList $url
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', ('"' + (Join-Path $hubDir 'windows\browser-login-approve.ps1') + '"'),
      '-DataRoot', ('"' + $root + '"'), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
}
'@
$sampleVariable = @'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  Start-Process -FilePath $browser -ArgumentList $url
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
}
'@
$sampleTwoLevel = @'
$inner = Join-Path $hubDir 'windows\browser-login-approve.ps1'
$approveScript = $inner
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  Start-Process -FilePath $browser -ArgumentList $url
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
}
'@
$sampleNested = @'
$root = Join-Path $env:LOCALAPPDATA 'ProjectHub'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
function ConvertTo-WindowsArgument([string]$Value) { return $Value }
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
}
'@
$sampleRootAlias = @'
$root = Join-Path $env:LOCALAPPDATA 'ProjectHub'
$dataRoot = $root
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
function ConvertTo-WindowsArgument([string]$Value) { return $Value }
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $dataRoot), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
}
'@
$sampleBefore = @'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
}
'@
$sampleOutside = @'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
try {
  Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
    '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
} catch {
  Write-Warning 'manual'
}
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
}
'@
$sampleNoTry = @'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
  Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
    '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
}
'@
$sampleRethrow = @'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
    throw
  }
}
'@
$sampleToken = @'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -WorkingDirectory $token -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
}
'@
$sampleNoHidden = @'
$approveScript = Join-Path $hubDir 'windows\browser-login-approve.ps1'
if (-not $NoBrowser -and $env:HUB_NO_BROWSER -ne '1') {
  if (Test-Path $browser) {
    Start-Process -FilePath $browser -ArgumentList $url
  } else {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $url
  }
  try {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','RemoteSigned','-File', (ConvertTo-WindowsArgument $approveScript),
      '-DataRoot', (ConvertTo-WindowsArgument $root), '-Port', "$port")
  } catch {
    Write-Warning 'manual'
  }
}
'@
$fileReport = Get-Report $target $true
$sampleReport = Get-Report $sample $false
$sampleVariableReport = Get-Report $sampleVariable $false
$sampleTwoLevelReport = Get-Report $sampleTwoLevel $false
$fixtures = @{
  nested = (Get-Report $sampleNested $false)
  rootAlias = (Get-Report $sampleRootAlias $false)
  before = (Get-Report $sampleBefore $false)
  outside = (Get-Report $sampleOutside $false)
  noTry = (Get-Report $sampleNoTry $false)
  rethrow = (Get-Report $sampleRethrow $false)
  token = (Get-Report $sampleToken $false)
  noHidden = (Get-Report $sampleNoHidden $false)
}
$payload = @{
  bom = [bool]$bom
  highBytes = $high
  parseErrors = $fileReport.parseErrors
  startProcesses = $fileReport.startProcesses
  urlTokenExpressions = $fileReport.urlTokenExpressions
  authExpressions = $fileReport.authExpressions
  assignments = $fileReport.assignments
  functions = $fileReport.functions
  sampleParseErrors = $sampleReport.parseErrors
  sampleStartProcesses = $sampleReport.startProcesses
  sampleAssignments = $sampleReport.assignments
  sampleVariableParseErrors = $sampleVariableReport.parseErrors
  sampleVariableStartProcesses = $sampleVariableReport.startProcesses
  sampleVariableAssignments = $sampleVariableReport.assignments
  sampleTwoLevelParseErrors = $sampleTwoLevelReport.parseErrors
  sampleTwoLevelStartProcesses = $sampleTwoLevelReport.startProcesses
  sampleTwoLevelAssignments = $sampleTwoLevelReport.assignments
  fixtures = $fixtures
}
function ConvertTo-JsonText($value) {
  if ($null -eq $value) { return 'null' }
  if ($value -is [bool]) { if ($value) { return 'true' } else { return 'false' } }
  if ($value -is [byte] -or $value -is [int] -or $value -is [long] -or $value -is [double]) { return ([string]$value) }
  if ($value -is [string]) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $value.ToCharArray()) {
      $code = [int]$ch
      if ($ch -eq '"') { [void]$sb.Append('\"') }
      elseif ($ch -eq '\') { [void]$sb.Append('\\') }
      elseif ($code -eq 10) { [void]$sb.Append('\n') }
      elseif ($code -eq 13) { [void]$sb.Append('\r') }
      elseif ($code -eq 9) { [void]$sb.Append('\t') }
      elseif ($code -lt 32) { [void]$sb.Append('\u' + $code.ToString('x4')) }
      else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
  }
  if ($value -is [System.Collections.IDictionary]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($key in @($value.Keys)) { [void]$parts.Add(((ConvertTo-JsonText ([string]$key)) + ':' + (ConvertTo-JsonText $value[$key]))) }
    return '{' + ($parts -join ',') + '}'
  }
  if ($value -is [System.Collections.IEnumerable]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $value) { [void]$parts.Add((ConvertTo-JsonText $item)) }
    return '[' + ($parts -join ',') + ']'
  }
  return (ConvertTo-JsonText ([string]$value))
}
[Console]::Out.WriteLine((ConvertTo-JsonText $payload))
`;

let reportPromise;
function launcherReport() {
  if (!reportPromise) reportPromise = (async () => {
    const file = path.join(os.tmpdir(), `hub-launcher-ast-${process.pid}.ps1`);
    fs.writeFileSync(file, ANALYZER.replace(/^\uFEFF/, ''), { encoding: 'ascii' });
    try {
      const { stdout } = await runPs(['-NoProfile', '-NonInteractive', '-File', file], {
        env: { ...process.env, HUB_PARSE_TARGET: launcher },
        timeout: 20000,
      });
      return JSON.parse(stdout);
    } finally {
      fs.rmSync(file, { force: true });
    }
  })();
  return reportPromise;
}

function textOf(expr) {
  if (!expr) return '';
  if (typeof expr.text === 'string' && expr.text.length) return expr.text;
  if (expr.kind === 'string') return String(expr.value);
  if (expr.kind === 'variable') return '$' + expr.name;
  if (expr.kind === 'array') return (expr.items || []).map(textOf).join(',');
  if (expr.kind === 'binary') return textOf(expr.left) + String(expr.op) + textOf(expr.right);
  return expr.name || '';
}

function childExprs(expr) {
  return [expr.left, expr.right, expr.inner, ...(expr.items || []), ...(expr.args || [])].filter(Boolean);
}

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function containsScriptLiteral(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (normalizePath(expr.value).includes('windows\\browser-login-approve.ps1')) return true;
  if (normalizePath(expr.text).includes('windows\\browser-login-approve.ps1')) return true;
  return childExprs(expr).some(containsScriptLiteral);
}

function containsToken(expr) {
  if (!expr || typeof expr !== 'object') return false;
  const blob = `${expr.text || ''}\n${expr.value || ''}\n${expr.name || ''}`;
  if (/\$token\b/i.test(blob) || /HUB_LOCAL_TOKEN/.test(blob)) return true;
  return childExprs(expr).some(containsToken);
}

function assignmentMap(list) {
  const groups = new Map();
  for (const item of list || []) {
    const name = String(item.name || '').toLowerCase();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item.expr);
  }
  const single = new Map();
  for (const [name, exprs] of groups) if (exprs.length === 1) single.set(name, exprs[0]);
  return single;
}

function substituteOnce(expr, assignments) {
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.kind === 'variable') {
    const key = String(expr.name || '').toLowerCase();
    if (assignments.has(key)) return assignments.get(key);
    return expr;
  }
  const copy = { ...expr };
  if (expr.left) copy.left = substituteOnce(expr.left, assignments);
  if (expr.right) copy.right = substituteOnce(expr.right, assignments);
  if (expr.inner) copy.inner = substituteOnce(expr.inner, assignments);
  if (expr.items) copy.items = expr.items.map(item => substituteOnce(item, assignments));
  if (expr.args) copy.args = expr.args.map(item => substituteOnce(item, assignments));
  return copy;
}

function isConvertFunctionName(name) {
  return String(name || '').toLowerCase() === 'convertto-windowsargument';
}

function isConvertCall(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.kind === 'paren' || expr.kind === 'subexpr') return isConvertCall(expr.inner);
  return expr.kind === 'command' && isConvertFunctionName(expr.name);
}

function convertArgument(expr) {
  if (!expr || typeof expr !== 'object') return null;
  if (expr.kind === 'paren' || expr.kind === 'subexpr') return convertArgument(expr.inner);
  if (!isConvertCall(expr)) return null;
  const args = (expr.args || []).filter(arg => arg && arg.kind !== 'parameter');
  return args.length === 1 ? args[0] : null;
}

function isRootSource(expr, assignments) {
  if (!expr || expr.kind !== 'variable') return false;
  const name = String(expr.name || '').toLowerCase();
  if (name === 'root') return true;
  if (!assignments || !assignments.has(name)) return false;
  const assigned = assignments.get(name);
  return !!(assigned && assigned.kind === 'variable' && String(assigned.name || '').toLowerCase() === 'root');
}

function concatenationUsesRoot(expr, assignments) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.kind === 'variable') return isRootSource(expr, assignments);
  if (expr.kind === 'paren' || expr.kind === 'subexpr') return concatenationUsesRoot(expr.inner, assignments);
  if (expr.kind === 'binary' && String(expr.op) === 'Plus') return concatenationUsesRoot(expr.left, assignments) || concatenationUsesRoot(expr.right, assignments);
  return false;
}

function isBuiltFromRoot(expr, assignments) {
  const arg = convertArgument(expr);
  if (arg && isRootSource(arg, assignments)) return true;
  return concatenationUsesRoot(expr, assignments);
}

function isApprovalFileValue(expr) {
  const arg = convertArgument(expr);
  if (arg) return containsScriptLiteral(arg);
  return containsScriptLiteral(expr);
}

function isSystemPowerShell(expr) {
  const norm = textOf(expr).replace(/\//g, '\\').toLowerCase();
  return norm.includes('systemroot') && norm.includes('\\windowspowershell\\v1.0\\powershell.exe');
}

function argumentProblems(originalItems, resolvedItems, assignments) {
  const problems = [];
  const items = originalItems;
  const resolved = resolvedItems || originalItems;
  if (!Array.isArray(items) || items.length !== 9 || !Array.isArray(resolved) || resolved.length !== 9) return [`ArgumentList has ${Array.isArray(items) ? items.length : 0} elements, expected exactly -NoProfile -ExecutionPolicy RemoteSigned -File <approval script> -DataRoot <value from $root> -Port "$port"`];
  const value = item => item && item.kind === 'string' ? item.value : null;
  if (value(items[0]) !== '-NoProfile' || value(items[1]) !== '-ExecutionPolicy' || value(items[2]) !== 'RemoteSigned') problems.push('powershell arguments are not exactly -NoProfile -ExecutionPolicy RemoteSigned before -File');
  if (value(items[3]) !== '-File') problems.push('missing -File');
  if (!isApprovalFileValue(resolved[4])) problems.push('-File value does not contain windows\\browser-login-approve.ps1 after one variable substitution');
  if (value(items[5]) !== '-DataRoot') problems.push('missing -DataRoot');
  if (!isBuiltFromRoot(items[6], assignments)) problems.push('-DataRoot is not a value built from $root');
  if (value(items[7]) !== '-Port') problems.push('missing -Port');
  const port = items[8];
  const portText = port ? String(port.text || '') : '';
  if (!(port && port.kind === 'expandable' && /^"\$\{?port\}?"$/.test(portText))) problems.push('-Port is not followed by "$port"');
  return problems;
}

function approvalProcesses(report) {
  const assignments = assignmentMap(report.assignments);
  return (report.startProcesses || []).filter(proc => {
    const resolved = substituteOnce(proc.parameters && proc.parameters.ArgumentList, assignments);
    return containsScriptLiteral(resolved) || normalizePath(proc.text).includes('windows\\browser-login-approve.ps1');
  });
}

function describeApproval(proc, report) {
  const problems = [];
  const assignments = assignmentMap(report.assignments);
  const params = proc.parameters || {};
  const filePath = substituteOnce(params.FilePath, assignments);
  const originalList = params.ArgumentList;
  const argumentList = substituteOnce(originalList, assignments);
  if (!isSystemPowerShell(filePath)) problems.push('FilePath is not powershell.exe under $env:SystemRoot\\System32\\WindowsPowerShell\\v1.0');
  if (!params.WindowStyle || params.WindowStyle.kind !== 'string' || params.WindowStyle.value !== 'Hidden') problems.push('missing -WindowStyle Hidden');
  const originalItems = originalList && originalList.kind === 'array' ? originalList.items : null;
  const items = argumentList && argumentList.kind === 'array' ? argumentList.items : null;
  problems.push(...argumentProblems(originalItems, items, assignments));
  if (proc.hasToken || containsToken(originalList) || containsToken(argumentList) || containsToken(filePath)) problems.push('approval Start-Process arguments contain $token or HUB_LOCAL_TOKEN');
  const outer = proc.outerIf;
  const outerOk = !!(outer && /\$NoBrowser\b/.test(outer.condition || '') && /HUB_NO_BROWSER/.test(outer.condition || ''));
  if (!outerOk) problems.push('approval Start-Process is not inside the if that tests $NoBrowser and $env:HUB_NO_BROWSER');
  if (!proc.tryInsideOuter || !proc.tryCatch) problems.push('approval Start-Process is not inside a try in that same if');
  else {
    if (!proc.tryCatch.writeWarning) problems.push('the catch does not call Write-Warning');
    if (proc.tryCatch.throws) problems.push('the catch rethrows');
    if (proc.tryCatch.exits) problems.push('the catch stops the launcher');
  }
  const launches = outerOk ? (report.startProcesses || []).filter(other => other.start !== proc.start && other.start >= outer.start && other.end <= outer.end) : [];
  if (!launches.length || launches.some(other => !(proc.start > other.end))) problems.push('approval Start-Process is not after the browser Start-Process in the outer if');
  return problems;
}

function parsedFixture(report, name) {
  const bundle = report.fixtures && report.fixtures[name];
  assert.ok(bundle, 'missing analyzer fixture ' + name);
  assert.equal(bundle.parseErrors, 0, name + ' fixture did not parse');
  return bundle;
}

function oneApproval(bundle, label) {
  const hits = approvalProcesses(bundle);
  assert.equal(hits.length, 1, label + ' expected one approval Start-Process, found ' + hits.length);
  return hits[0];
}

win('5.2.1 launcher has no #auth= fragment and no host URL combined with a token variable', async () => {
  const bytes = fs.readFileSync(launcher);
  const text = bytes.toString('latin1');
  assert.equal(text.includes('#auth='), false, 'start-windows.ps1 still contains #auth=');
  const report = await launcherReport();
  assert.equal(report.parseErrors, 0, 'start-windows.ps1 did not parse');
  assert.deepEqual(report.authExpressions, [], 'a string still contains #auth=');
  assert.deepEqual(report.urlTokenExpressions, [], 'a string still combines the host URL with a token variable: ' + (report.urlTokenExpressions || []).join(' | ').slice(0, 300));
});

win('5.2.2 no Start-Process arguments contain $token or HUB_LOCAL_TOKEN', async () => {
  const report = await launcherReport();
  const leaked = (report.startProcesses || []).filter(proc => proc.hasToken).map(proc => proc.text.replace(/\s+/g, ' ').slice(0, 240));
  assert.deepEqual(leaked, [], 'Start-Process still carries the owner token:\n' + leaked.join('\n'));
});

win('5.2.3 launcher no longer starts approval; legacy analyzer fixtures remain valid', async () => {
  const report = await launcherReport();
  assert.equal(report.sampleParseErrors, 0, 'analyzer self-check sample did not parse');
  const sample = { startProcesses: report.sampleStartProcesses || [], assignments: report.sampleAssignments || [] };
  const sampleHits = approvalProcesses(sample);
  assert.equal(sampleHits.length, 1, 'analyzer self-check did not find the sample approval Start-Process');
  assert.deepEqual(describeApproval(sampleHits[0], sample), [], 'analyzer self-check rejected the sample required by the spec');
  assert.equal(report.sampleVariableParseErrors, 0, 'one-level variable sample did not parse');
  const variableSample = { startProcesses: report.sampleVariableStartProcesses || [], assignments: report.sampleVariableAssignments || [] };
  const variableHits = approvalProcesses(variableSample);
  assert.equal(variableHits.length, 1, 'one-level variable assignment was not resolved to windows\\browser-login-approve.ps1');
  assert.deepEqual(describeApproval(variableHits[0], variableSample), [], 'variable sample was not accepted as the approval Start-Process: ' + describeApproval(variableHits[0], variableSample).join('; '));
  assert.equal(report.sampleTwoLevelParseErrors, 0, 'two-level variable sample did not parse');
  const twoLevel = { startProcesses: report.sampleTwoLevelStartProcesses || [], assignments: report.sampleTwoLevelAssignments || [] };
  assert.equal(approvalProcesses(twoLevel).length, 0, 'analyzer resolved more than one assignment level');
  const nested = parsedFixture(report, 'nested');
  assert.deepEqual(describeApproval(oneApproval(nested, 'nested'), nested), [], 'nested outer-if sample was rejected: ' + describeApproval(oneApproval(nested, 'nested'), nested).join('; '));
  const rootAlias = parsedFixture(report, 'rootAlias');
  assert.deepEqual(describeApproval(oneApproval(rootAlias, 'rootAlias'), rootAlias), [], 'DataRoot variable assigned from $root was rejected: ' + describeApproval(oneApproval(rootAlias, 'rootAlias'), rootAlias).join('; '));
  assert.deepEqual(describeApproval(oneApproval(parsedFixture(report, 'before'), 'before'), parsedFixture(report, 'before')), [
    'approval Start-Process is not after the browser Start-Process in the outer if',
  ]);
  assert.deepEqual(describeApproval(oneApproval(parsedFixture(report, 'outside'), 'outside'), parsedFixture(report, 'outside')), [
    'approval Start-Process is not inside the if that tests $NoBrowser and $env:HUB_NO_BROWSER',
    'approval Start-Process is not inside a try in that same if',
    'approval Start-Process is not after the browser Start-Process in the outer if',
  ]);
  assert.deepEqual(describeApproval(oneApproval(parsedFixture(report, 'noTry'), 'noTry'), parsedFixture(report, 'noTry')), [
    'approval Start-Process is not inside a try in that same if',
  ]);
  assert.deepEqual(describeApproval(oneApproval(parsedFixture(report, 'rethrow'), 'rethrow'), parsedFixture(report, 'rethrow')), [
    'the catch rethrows',
  ]);
  assert.deepEqual(describeApproval(oneApproval(parsedFixture(report, 'token'), 'token'), parsedFixture(report, 'token')), [
    'approval Start-Process arguments contain $token or HUB_LOCAL_TOKEN',
  ]);
  assert.deepEqual(describeApproval(oneApproval(parsedFixture(report, 'noHidden'), 'noHidden'), parsedFixture(report, 'noHidden')), [
    'missing -WindowStyle Hidden',
  ]);
  const hits = approvalProcesses(report);
  assert.equal(hits.length, 0, 'launcher must not open the legacy approval window');
});

win('5.2.4 legacy guard fixtures remain valid and the launcher has no approval process', async () => {
  const report = await launcherReport();
  const guard = problems => problems.filter(problem => /if that tests|inside a try|catch|after the browser/.test(problem));
  const nested = parsedFixture(report, 'nested');
  assert.deepEqual(guard(describeApproval(oneApproval(nested, 'nested'), nested)), []);
  const before = parsedFixture(report, 'before');
  assert.deepEqual(guard(describeApproval(oneApproval(before, 'before'), before)), [
    'approval Start-Process is not after the browser Start-Process in the outer if',
  ]);
  const hits = approvalProcesses(report);
  assert.equal(hits.length, 0, 'launcher must only open the browser URL');
});

win('5.2.5 launcher script is ASCII and has no BOM', () => {
  const bytes = fs.readFileSync(launcher);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  assert.equal(bom, false, 'start-windows.ps1 has a UTF-8 BOM');
  const high = [...bytes].filter(byte => byte > 127);
  assert.deepEqual(high, [], 'start-windows.ps1 is not ASCII-only');
});

win('5.2.6 -NoBrowser does not start browser-login-approve', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-launcher-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  assert.ok(port >= 1024);
  const env = { ...environment(root), HUB_ROOT: root, HUB_PORT: String(port) };
  delete env.HUB_DRY_RUN;
  delete env.HUB_LOCAL_TOKEN;
  const found = new Set();
  let polls = 0;
  let pollError = '';
  let stop = false;
  const listScript = path.join(root, 'list-approve.ps1');
  fs.writeFileSync(listScript, [
    'param([string]$Root)',
    "$needle = 'browser-login-approve'",
    '$root = $Root.ToLowerInvariant()',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $cmd = $_.CommandLine',
    '  if (-not $cmd) { return }',
    '  $low = $cmd.ToLowerInvariant()',
    '  if ($low.Contains($needle) -and $low.Contains($root)) { Write-Output $_.ProcessId }',
    '}',
    '',
  ].join('\r\n'), { encoding: 'ascii' });
  async function scan() {
    try {
      const { stdout } = await runPs(['-NoProfile', '-NonInteractive', '-File', listScript, '-Root', root], { timeout: 15000 });
      polls += 1;
      for (const line of stdout.split(/\r?\n/)) if (/^\d+$/.test(line.trim())) {const pid=Number(line.trim());if(!found.has(pid))rememberPid(pid);found.add(pid);}
    } catch (error) {
      pollError = error.message;
    }
  }
  const watching = (async () => {
    while (!stop) {
      await scan();
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  })();
  let started = false;
  t.after(async () => {
    stop = true;
    await watching.catch(() => {});
    try { if (started) await runLauncher(['-Stop'], env); } catch { /* the service may already be stopped */ }
    for (const pid of found) killPid(pid);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  let output;
  try { output = await runLauncher([], env); started = true; }
  catch (error) { throw Error(error.safeOutput || error.message); }
  await scan();
  assert.match(output, /running on/);
  stop = true;
  await watching.catch(() => {});
  assert.ok(polls >= 1, 'could not query Win32_Process: ' + pollError);
  assert.equal(found.size, 0, ` -NoBrowser started browser-login-approve pid ${[...found].join(',')}`);
  await runLauncher(['-Stop'], env);
  started = false;
  await scan();
  assert.equal(found.size, 0, `browser-login-approve was still running after -Stop: ${[...found].join(',')}`);
});

win('5.2.7 a hidden approval process shows Project Hub login window and cancel exits CANCELLED', { timeout: 50000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-approve-'));
  const port = await freePort();
  assert.ok(port >= 1024);
  const stdoutPath = path.join(root, 'approve.stdout.txt');
  const stderrPath = path.join(root, 'approve.stderr.txt');
  const starterPath = path.join(root, 'start-hidden.ps1');
  const finderPath = path.join(root, 'find-window.ps1');
  fs.writeFileSync(starterPath, [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$ApproveScript,',
    '  [Parameter(Mandatory=$true)][string]$DataRoot,',
    '  [Parameter(Mandatory=$true)][int]$Port,',
    '  [Parameter(Mandatory=$true)][string]$StdOut,',
    '  [Parameter(Mandatory=$true)][string]$StdErr',
    ')',
    "$ErrorActionPreference = 'Stop'",
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$quotedScript = '\"' + $ApproveScript + '\"'",
    "$quotedRoot = '\"' + $DataRoot + '\"'",
    '$proc = Start-Process -FilePath $ps -WindowStyle Hidden -PassThru -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr -ArgumentList @(',
    "  '-NoProfile','-ExecutionPolicy','RemoteSigned','-File',$quotedScript,'-DataRoot',$quotedRoot,'-Port',\"$Port\")",
    '[void]$proc.Handle',
    '[Console]::Out.WriteLine($proc.Id)',
    '[Console]::Out.Flush()',
    'if (-not $proc.WaitForExit(40000)) { [Console]::Out.WriteLine("TIMEOUT"); exit 2 }',
    '[Console]::Out.WriteLine($proc.ExitCode)',
    '',
  ].join('\r\n'), { encoding: 'ascii' });
  fs.writeFileSync(finderPath, [
    'param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$Title)',
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    '$root = [System.Windows.Automation.AutomationElement]::RootElement',
    '$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)',
    '$deadline = (Get-Date).AddSeconds(15)',
    '$matched = @()',
    '$total = 0',
    'do {',
    '  $all = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))',
    '  $total = $all.Count',
    '  $matched = @()',
    '  foreach ($window in $all) {',
    '    if ($window.Current.Name -ceq $Title) {',
    '      $rect = $window.Current.BoundingRectangle',
    '      $matched += [pscustomobject]@{ offscreen = [bool]$window.Current.IsOffscreen; width = [double]$rect.Width; height = [double]$rect.Height }',
    '    }',
    '  }',
    '  $visible = @($matched | Where-Object { -not $_.offscreen -and $_.width -gt 0 -and $_.height -gt 0 })',
    '  if ($visible.Count -eq 1 -and $matched.Count -eq 1) {',
    "    Write-Output ('{\"matched\":1,\"offscreen\":false,\"width\":' + [int]$visible[0].width + ',\"height\":' + [int]$visible[0].height + ',\"topLevel\":' + $total + '}')",
    '    exit 0',
    '  }',
    '  Start-Sleep -Milliseconds 200',
    '} while ((Get-Date) -lt $deadline)',
    '$off = $false; $width = 0; $height = 0',
    'if ($matched.Count -ge 1) { $off = [bool]$matched[0].offscreen; $width = [int]$matched[0].width; $height = [int]$matched[0].height }',
    "$offText = 'false'; if ($off) { $offText = 'true' }",
    "Write-Output ('{\"matched\":' + $matched.Count + ',\"offscreen\":' + $offText + ',\"width\":' + $width + ',\"height\":' + $height + ',\"topLevel\":' + $total + '}')",
    '',
  ].join('\r\n'), { encoding: 'ascii' });
  const starter = spawn(ps, ['-NoProfile', '-NonInteractive', '-File', starterPath, '-ApproveScript', approveScript, '-DataRoot', root, '-Port', String(port), '-StdOut', stdoutPath, '-StdErr', stderrPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let starterOut = '', starterErr = '';
  const lines = [];
  const waiters = [];
  starter.stdout.on('data', chunk => {
    starterOut += chunk;
    let newline;
    while ((newline = starterOut.indexOf('\n')) >= 0) {
      const line = starterOut.slice(0, newline).replace(/\r$/, '');
      starterOut = starterOut.slice(newline + 1);
      if (waiters.length) waiters.shift()(line);
      else lines.push(line);
    }
  });
  starter.stderr.on('data', chunk => { starterErr += chunk; });
  const nextLine = () => lines.length ? Promise.resolve(lines.shift()) : new Promise(resolve => waiters.push(resolve));
  let approvePid = 0;
  t.after(async () => {
    killPid(approvePid);
    if (starter.exitCode === null) starter.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const pidLine = await Promise.race([
    nextLine(),
    new Promise(resolve => setTimeout(() => resolve(''), 10000)),
  ]);
  assert.match(pidLine, /^\d+$/, `hidden approval process did not start (stdout=${pidLine} stderr=${starterErr.slice(0, 400)})`);
  approvePid = Number(pidLine);rememberPid(approvePid);
  let commandLine = '';
  try {
    const queried = await runPs(['-NoProfile', '-NonInteractive', '-Command', `Write-Output ((Get-CimInstance Win32_Process -Filter "ProcessId=${approvePid}").CommandLine)`], { timeout: 15000 });
    commandLine = queried.stdout;
  } catch (error) {
    commandLine = error.message;
  }
  assert.equal(/HUB_LOCAL_TOKEN/.test(commandLine), false, 'hidden approval command line contains HUB_LOCAL_TOKEN');
  assert.match(commandLine, /browser-login-approve\.ps1/, 'hidden process is not browser-login-approve.ps1: ' + commandLine.slice(0, 300));
  const found = await runPs(['-NoProfile', '-NonInteractive', '-File', finderPath, '-ProcessId', String(approvePid), '-Title', 'Project Hub 本機登入確認'], { timeout: 20000 });
  const window = JSON.parse(found.stdout.trim());
  assert.equal(window.matched, 1, `expected exactly one visible "Project Hub 本機登入確認" window within 15s when started -WindowStyle Hidden, got ${found.stdout.trim()} stderr=${fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8').slice(0, 400) : ''}`);
  assert.equal(window.offscreen, false, 'approval window is off-screen');
  assert.ok(window.width > 0 && window.height > 0, 'approval window has no visible size');
  const driven = await runPs(['-NoProfile', '-NonInteractive', '-File', writableDriver(root), '-ProcessId', String(approvePid), '-Title', 'Project Hub 本機登入確認', '-ButtonName', '取消', '-Text', ''], { timeout: 30000 });
  assert.match(driven.stdout, /INVOKED/, 'approval dialog helper did not click 取消: ' + driven.stdout);
  const exitLine = await Promise.race([
    nextLine(),
    new Promise(resolve => setTimeout(() => resolve(''), 20000)),
  ]);
  assert.equal(exitLine, '1', `approval process exit code, starter stderr=${starterErr.slice(0, 300)} line=${exitLine}`);
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8').trim() : '';
  assert.equal(stdout, '{"ok":false,"code":"BROWSER_LOGIN_FAILED","reason":"CANCELLED"}');
});

const QUOTE_VALUES = ['C:\\Hub', 'C:\\Hub Folder', 'D:\\', 'C:\\a b\\', 'C:\\a b\\\\', 'C:\\x"y', 'C:\\p\\"q', 'D:\\@專案\\x y\\', 'C:\\t\\\\\\', ''];

let nodeShortPath;
async function nodeExe() {
  if (!nodeShortPath) {
    const command = `$f = New-Object -ComObject Scripting.FileSystemObject; Write-Output $f.GetFile('${process.execPath.replace(/'/g, "''")}').ShortPath`;
    const { stdout } = await runPs(['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 });
    nodeShortPath = stdout.trim();
  }
  if (!nodeShortPath || /\s/.test(nodeShortPath)) throw Error('node executable short path is missing or contains a space: ' + nodeShortPath);
  return nodeShortPath;
}

function resolvedArgumentItems(proc, report) {
  const argumentList = substituteOnce(proc.parameters && proc.parameters.ArgumentList, assignmentMap(report.assignments));
  return argumentList && argumentList.kind === 'array' ? argumentList.items : null;
}

async function quoteWithFunction(functionText, values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quote-'));
  const valuesPath = path.join(dir, 'values.json');
  const outPath = path.join(dir, 'quoted.json');
  const scriptPath = path.join(dir, 'quote.ps1');
  fs.writeFileSync(valuesPath, JSON.stringify(values));
  const script = [
    'param([Parameter(Mandatory=$true)][string]$ValuesPath,[Parameter(Mandatory=$true)][string]$OutPath)',
    functionText,
    "$ErrorActionPreference = 'Stop'",
    '$raw = [System.IO.File]::ReadAllText($ValuesPath, (New-Object System.Text.UTF8Encoding $false))',
    '$values = $raw | ConvertFrom-Json',
    '$list = New-Object System.Collections.Generic.List[string]',
    'foreach ($item in @($values)) { [void]$list.Add((ConvertTo-WindowsArgument ([string]$item))) }',
    '$json = ConvertTo-Json -InputObject @($list.ToArray()) -Compress',
    '[System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding $false))',
    '',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, script);
  try {
    await runPs(['-NoProfile', '-NonInteractive', '-File', scriptPath, '-ValuesPath', valuesPath, '-OutPath', outPath], { timeout: 20000 });
    const quoted = JSON.parse(fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(quoted)) throw Error('quoter did not return an array');
    return quoted;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function parseVerbatimArgv(quotedArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-argv-'));
  const file = path.join(dir, 'argv.js');
  if (/\s/.test(file)) throw Error('argv.js path contains a space, so a verbatim command line would split it: ' + file);
  fs.writeFileSync(file, 'console.log(JSON.stringify(process.argv.slice(2)))\n');
  return nodeExe().then(exe => new Promise((resolve, reject) => {
    const child = spawn(exe, [file, ...quotedArgs], { windowsVerbatimArguments: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('argv.js timed out\n' + stderr.slice(-500))); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      if (code !== 0) reject(Error(`argv.js exited ${code}: ${stderr.slice(0, 500)}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch (error) { reject(Error('argv.js did not print JSON: ' + stdout.slice(0, 300) + ' ' + error.message)); }
      }
    });
  }));
}

win('5.2.8 ConvertTo-WindowsArgument remains correct after removing automatic approval', async () => {
  assert.equal(isConvertFunctionName('ConvertTo-WindowsArgument'), true);
  assert.equal(isConvertFunctionName('convertto-windowsargument'), true);
  assert.equal(isConvertFunctionName('CONVERTTO-WINDOWSARGUMENT'), true);
  assert.equal(isConvertFunctionName('converttowindowsargument'), false);
  const report = await launcherReport();
  const nested = parsedFixture(report, 'nested');
  const nestedFns = (nested.functions || []).filter(fn => isConvertFunctionName(fn.name));
  assert.equal(nestedFns.length, 1, 'fixture function name ConvertTo-WindowsArgument was not matched');
  assert.equal(String(nestedFns[0].name).toLowerCase(), 'convertto-windowsargument');
  const nestedHit = oneApproval(nested, 'nested');
  assert.ok(nestedFns[0].end <= nestedHit.start, 'fixture ConvertTo-WindowsArgument is not before the approval Start-Process');
  const nestedItems = resolvedArgumentItems(nestedHit, nested);
  assert.equal(isConvertCall(nestedItems[4]), true, 'fixture -File is not a ConvertTo-WindowsArgument call');
  assert.equal(isConvertCall(nestedItems[6]), true, 'fixture -DataRoot is not a ConvertTo-WindowsArgument call');
  const functions = (report.functions || []).filter(fn => isConvertFunctionName(fn.name));
  assert.equal(functions.length, 1, 'start-windows.ps1 must define exactly one ConvertTo-WindowsArgument function');
  const hits = approvalProcesses(report);
  assert.equal(hits.length, 0, 'launcher must not start browser approval');
  const fn = functions[0];
  assert.equal(typeof fn.text, 'string');
  const quoted = await quoteWithFunction(fn.text, QUOTE_VALUES);
  assert.equal(quoted.length, QUOTE_VALUES.length, 'quoter returned the wrong number of arguments');
  const parsed = await parseVerbatimArgv(quoted);
  assert.deepEqual(parsed, QUOTE_VALUES);
});

const APPROVE_ANALYZER = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:HUB_PARSE_TARGET
$bytes = [System.IO.File]::ReadAllBytes($target)
$bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)

function Test-HasProcessListCall($node) {
  if ($null -eq $node) { return $false }
  if ($node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Extent.Text -eq 'GetConsoleProcessList') { return $true }
  $hits = @($node.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -eq 'GetConsoleProcessList' }, $true))
  return $hits.Count -gt 0
}

function Get-ConditionExpr($node) {
  if ($node -is [System.Management.Automation.Language.PipelineAst]) {
    $elements = @($node.PipelineElements)
    if ($elements.Count -eq 1 -and $elements[0] -is [System.Management.Automation.Language.CommandExpressionAst]) { return $elements[0].Expression }
  }
  if ($node -is [System.Management.Automation.Language.CommandExpressionAst]) { return $node.Expression }
  return $node
}

function Test-ComparesProcessListToOne($condNode, $single) {
  $expr = Get-ConditionExpr $condNode
  if (-not ($expr -is [System.Management.Automation.Language.BinaryExpressionAst])) { return $false }
  $op = [string]$expr.Operator
  if ($op -ne 'Ieq' -and $op -ne 'Ceq') { return $false }
  $one = $false
  $call = $false
  foreach ($side in @($expr.Left, $expr.Right)) {
    if ($side -is [System.Management.Automation.Language.ConstantExpressionAst] -and [string]$side.Value -eq '1') { $one = $true }
    if (Test-HasProcessListCall $side) { $call = $true }
    if ($side -is [System.Management.Automation.Language.VariableExpressionAst]) {
      $key = $side.VariablePath.UserPath.ToLowerInvariant()
      if ($single.ContainsKey($key) -and (Test-HasProcessListCall $single[$key])) { $call = $true }
    }
  }
  return ($one -and $call)
}

function Test-IsHideCall($inv) {
  if (-not ($inv -is [System.Management.Automation.Language.InvokeMemberExpressionAst])) { return $false }
  if ($inv.Member.Extent.Text -ne 'ShowWindow') { return $false }
  $hasConsole = $false
  $hasZero = $false
  foreach ($arg in @($inv.Arguments)) {
    if ($arg -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $arg.Member.Extent.Text -eq 'GetConsoleWindow') { $hasConsole = $true }
    if ($arg -is [System.Management.Automation.Language.ConstantExpressionAst] -and [string]$arg.Value -eq '0') { $hasZero = $true }
  }
  return ($hasConsole -and $hasZero)
}

function Test-InsideGuardedIf($inv, $single) {
  $parent = $inv.Parent
  while ($null -ne $parent) {
    if ($parent -is [System.Management.Automation.Language.IfStatementAst]) {
      foreach ($clause in $parent.Clauses) {
        $body = $clause.Item2
        $inside = $inv.Extent.StartOffset -ge $body.Extent.StartOffset -and $inv.Extent.EndOffset -le $body.Extent.EndOffset
        if ($inside -and (Test-ComparesProcessListToOne $clause.Item1 $single)) { return $true }
      }
    }
    $parent = $parent.Parent
  }
  return $false
}

function Get-VisibilityProblems($ast) {
  # The console hiding lives in Hide-OwnConsole, which Show-ApprovalDialog calls BEFORE it creates any form.
  $problems = New-Object System.Collections.Generic.List[string]
  $dialogs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Show-ApprovalDialog' }, $true))
  $hiders = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Hide-OwnConsole' }, $true))
  if ($dialogs.Count -ne 1) { [void]$problems.Add('expected exactly one Show-ApprovalDialog, found ' + $dialogs.Count) }
  if ($hiders.Count -ne 1) { [void]$problems.Add('expected exactly one Hide-OwnConsole, found ' + $hiders.Count) }
  if ($problems.Count -gt 0) { return $problems }
  $dialog = $dialogs[0]
  $fn = $hiders[0]
  $hideCalls = @($dialog.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Hide-OwnConsole' }, $true))
  $forms = @($dialog.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'New-Object' -and $n.Extent.Text -like '*Windows.Forms.Form*' }, $true))
  if ($hideCalls.Count -lt 1) { [void]$problems.Add('Show-ApprovalDialog never calls Hide-OwnConsole') }
  elseif ($forms.Count -gt 0 -and $hideCalls[0].Extent.StartOffset -gt $forms[0].Extent.StartOffset) { [void]$problems.Add('Hide-OwnConsole is called after the first form is created') }
  # Add-Type compiles through csc.exe into %TEMP%: it fails for non-ANSI or read-only TEMP folders and leaves a hidden child without a window.
  $compiles = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' -and ($n.Extent.Text -match '-(MemberDefinition|TypeDefinition|Namespace|Language|SourceCode)') }, $true))
  if ($compiles.Count -gt 0) { [void]$problems.Add('Add-Type compiles code (csc + TEMP) in the approval script') }
  $declared = $false
  $strings = @($fn.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }, $true))
  foreach ($item in $strings) {
    $val = $item.Extent.Text
    if ($item -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $val = [string]$item.Value }
    if ($val -eq 'GetConsoleProcessList' -or ($val -like '*GetConsoleProcessList*' -and $val -like '*DllImport*')) { $declared = $true }
  }
  if (-not $declared) { [void]$problems.Add('GetConsoleProcessList P/Invoke is not declared inside Hide-OwnConsole') }
  $grouped = @{}
  $assigns = @($fn.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))
  foreach ($assign in $assigns) {
    if ([string]$assign.Operator -ne 'Equals') { continue }
    if (-not ($assign.Left -is [System.Management.Automation.Language.VariableExpressionAst])) { continue }
    $key = $assign.Left.VariablePath.UserPath.ToLowerInvariant()
    if (-not $grouped.ContainsKey($key)) { $grouped[$key] = New-Object System.Collections.Generic.List[object] }
    [void]$grouped[$key].Add($assign.Right)
  }
  $single = @{}
  foreach ($key in @($grouped.Keys)) { if ($grouped[$key].Count -eq 1) { $single[$key] = $grouped[$key][0] } }
  $calls = @($fn.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -eq 'GetConsoleProcessList' }, $true))
  $shows = @($fn.Body.FindAll({ param($n) (Test-IsHideCall $n) }, $true))
  if ($shows.Count -lt 1) { [void]$problems.Add('ShowWindow(GetConsoleWindow(), 0) is not called inside Hide-OwnConsole') }
  foreach ($show in $shows) {
    $earlier = @($calls | Where-Object { $_.Extent.StartOffset -lt $show.Extent.StartOffset })
    if ($earlier.Count -lt 1) { [void]$problems.Add('GetConsoleProcessList is not called before ShowWindow') }
    if (-not (Test-InsideGuardedIf $show $single)) { [void]$problems.Add('ShowWindow(GetConsoleWindow(), 0) is not inside an if that compares GetConsoleProcessList to 1') }
  }
  return $problems
}

function Get-ParsedProblems([string]$source, [bool]$isFile) {
  $tokens = $null
  $errors = $null
  if ($isFile) { $ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors) }
  else { $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) }
  $problems = New-Object System.Collections.Generic.List[string]
  if (@($errors).Count -gt 0) { [void]$problems.Add('PowerShell parse error') }
  foreach ($item in @(Get-VisibilityProblems $ast)) { [void]$problems.Add([string]$item) }
  return ,$problems
}

$good = @'
function Hide-OwnConsole {
  Add-Import 'GetConsoleProcessList' 'kernel32.dll' ([uint32]) ([Type[]]@([uint32[]], [uint32]))
  Add-Import 'GetConsoleWindow' 'kernel32.dll' ([IntPtr]) ([Type[]]@())
  Add-Import 'ShowWindow' 'user32.dll' ([bool]) ([Type[]]@([IntPtr], [int]))
  $native = $builder.CreateType()
  $buf = New-Object 'uint[]' 2
  $count = $native::GetConsoleProcessList($buf, 2)
  if ($count -eq 1) {
    [void]$native::ShowWindow($native::GetConsoleWindow(), 0)
  }
}
function Show-ApprovalDialog {
  Hide-OwnConsole
  $form = New-Object System.Windows.Forms.Form
}
'@
$direct = @'
function Hide-OwnConsole {
  Add-Import 'GetConsoleProcessList' 'kernel32.dll' ([uint32]) ([Type[]]@([uint32[]], [uint32]))
  Add-Import 'ShowWindow' 'user32.dll' ([bool]) ([Type[]]@([IntPtr], [int]))
  Add-Import 'GetConsoleWindow' 'kernel32.dll' ([IntPtr]) ([Type[]]@())
  $buf = New-Object 'uint[]' 2
  if ($native::GetConsoleProcessList($buf, 2) -eq 1) {
    [void]$native::ShowWindow($native::GetConsoleWindow(), 0)
  }
}
function Show-ApprovalDialog {
  Hide-OwnConsole
  $form = New-Object System.Windows.Forms.Form
}
'@
$bad = @'
function Hide-OwnConsole {
  Add-Import 'GetConsoleProcessList' 'kernel32.dll' ([uint32]) ([Type[]]@([uint32[]], [uint32]))
  Add-Import 'ShowWindow' 'user32.dll' ([bool]) ([Type[]]@([IntPtr], [int]))
  Add-Import 'GetConsoleWindow' 'kernel32.dll' ([IntPtr]) ([Type[]]@())
  [void]$native::ShowWindow($native::GetConsoleWindow(), 0)
}
function Show-ApprovalDialog {
  Hide-OwnConsole
  $form = New-Object System.Windows.Forms.Form
}
'@
$late = @'
function Hide-OwnConsole {
  Add-Import 'GetConsoleProcessList' 'kernel32.dll' ([uint32]) ([Type[]]@([uint32[]], [uint32]))
  $buf = New-Object 'uint[]' 2
  if ($native::GetConsoleProcessList($buf, 2) -eq 1) { [void]$native::ShowWindow($native::GetConsoleWindow(), 0) }
}
function Show-ApprovalDialog {
  $form = New-Object System.Windows.Forms.Form
  Hide-OwnConsole
}
'@
$compiling = @'
function Hide-OwnConsole {
  Add-Type -Namespace HubLogin -Name Native -MemberDefinition 'x'
  Add-Import 'GetConsoleProcessList' 'kernel32.dll' ([uint32]) ([Type[]]@([uint32[]], [uint32]))
  $buf = New-Object 'uint[]' 2
  if ($native::GetConsoleProcessList($buf, 2) -eq 1) { [void]$native::ShowWindow($native::GetConsoleWindow(), 0) }
}
function Show-ApprovalDialog {
  Hide-OwnConsole
  $form = New-Object System.Windows.Forms.Form
}
'@
$fileProblems = Get-ParsedProblems $target $true
if (-not $bom) { $fileProblems.Insert(0, 'file does not start with a UTF-8 BOM') }
$payload = @{
  bom = [bool]$bom
  problems = $fileProblems
  sampleProblems = $(Get-ParsedProblems $good $false)
  sampleDirectProblems = $(Get-ParsedProblems $direct $false)
  sampleBadProblems = $(Get-ParsedProblems $bad $false)
  sampleLateProblems = $(Get-ParsedProblems $late $false)
  sampleCompilingProblems = $(Get-ParsedProblems $compiling $false)
}
function ConvertTo-JsonText($value) {
  if ($null -eq $value) { return 'null' }
  if ($value -is [bool]) { if ($value) { return 'true' } else { return 'false' } }
  if ($value -is [byte] -or $value -is [int] -or $value -is [long] -or $value -is [double]) { return ([string]$value) }
  if ($value -is [string]) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $value.ToCharArray()) {
      $code = [int]$ch
      if ($ch -eq '"') { [void]$sb.Append('\"') }
      elseif ($ch -eq '\') { [void]$sb.Append('\\') }
      elseif ($code -eq 10) { [void]$sb.Append('\n') }
      elseif ($code -eq 13) { [void]$sb.Append('\r') }
      elseif ($code -eq 9) { [void]$sb.Append('\t') }
      elseif ($code -lt 32) { [void]$sb.Append('\u' + $code.ToString('x4')) }
      else { [void]$sb.Append($ch) }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
  }
  if ($value -is [System.Collections.IDictionary]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($key in @($value.Keys)) { [void]$parts.Add(((ConvertTo-JsonText ([string]$key)) + ':' + (ConvertTo-JsonText $value[$key]))) }
    return '{' + ($parts -join ',') + '}'
  }
  if ($value -is [System.Collections.IEnumerable]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $value) { [void]$parts.Add((ConvertTo-JsonText $item)) }
    return '[' + ($parts -join ',') + ']'
  }
  return (ConvertTo-JsonText ([string]$value))
}
[Console]::Out.WriteLine((ConvertTo-JsonText $payload))
`;

let approveReportPromise;
function approveStaticReport() {
  if (!approveReportPromise) approveReportPromise = (async () => {
    const file = path.join(os.tmpdir(), `hub-approve-ast-${process.pid}.ps1`);
    fs.writeFileSync(file, APPROVE_ANALYZER.replace(/^\uFEFF/, ''), { encoding: 'ascii' });
    try {
      const { stdout } = await runPs(['-NoProfile', '-NonInteractive', '-File', file], {
        env: { ...process.env, HUB_PARSE_TARGET: approveScript },
        timeout: 20000,
      });
      return JSON.parse(stdout);
    } finally {
      fs.rmSync(file, { force: true });
    }
  })();
  return approveReportPromise;
}

win('5.2.9 Show-ApprovalDialog hides the console only when GetConsoleProcessList returns 1', async () => {
  const report = await approveStaticReport();
  assert.deepEqual(report.sampleProblems, [], 'analyzer rejected the variable-guarded ShowWindow sample: ' + (report.sampleProblems || []).join('; '));
  assert.deepEqual(report.sampleDirectProblems, [], 'analyzer rejected the inline GetConsoleProcessList guard: ' + (report.sampleDirectProblems || []).join('; '));
  assert.ok((report.sampleBadProblems || []).length > 0, 'analyzer accepted a ShowWindow that is not guarded by GetConsoleProcessList');
  assert.ok((report.sampleLateProblems || []).length > 0, 'analyzer accepted Hide-OwnConsole being called after the first form');
  assert.ok((report.sampleCompilingProblems || []).length > 0, 'analyzer accepted an Add-Type compile in the approval script');
  assert.equal(report.bom, true, 'browser-login-approve.ps1 does not start with a UTF-8 BOM');
  assert.deepEqual(report.problems, [], 'Show-ApprovalDialog console guard: ' + (report.problems || []).join('; '));
});

win('5.2.10 a shared console stays visible when the approval script is started from that console', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-console-'));
  const port = await freePort();
  assert.ok(port >= 1024);
  const resultPath = path.join(root, 'result.json');
  const pidsPath = path.join(root, 'pids.txt');
  const parentPath = path.join(root, 'parent-console.ps1');
  const bootstrapPath = path.join(root, 'bootstrap-normal.ps1');
  const dialogDriver = writableDriver(root);
  for (const value of [parentPath, approveScript, dialogDriver, root, resultPath, pidsPath]) {
    assert.equal(value.includes('"'), false, 'path contains a quote: ' + value);
    assert.equal(value.endsWith('\\'), false, 'path ends with a backslash: ' + value);
  }
  const parent = [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$ApproveScript,',
    '  [Parameter(Mandatory=$true)][string]$Driver,',
    '  [Parameter(Mandatory=$true)][string]$DataRoot,',
    '  [Parameter(Mandatory=$true)][int]$Port,',
    '  [Parameter(Mandatory=$true)][string]$ResultPath,',
    '  [Parameter(Mandatory=$true)][string]$PidsPath',
    ')',
    "$ErrorActionPreference = 'Stop'",
    '[System.IO.File]::WriteAllText($PidsPath, "$PID $((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks)")',
    '$payload = @{ before = $false; dialog = $false; after = $false; childPid = 0; parentPid = [int]$PID; matched = 0; hwndZero = $false; error = \'\' }',
    'function Write-Payload {',
    '  $json = ConvertTo-Json -InputObject $payload -Compress',
    '  [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding $false))',
    '}',
    'try {',
    'Add-Type -Namespace HubConsoleVis -Name Native -MemberDefinition @"',
    '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();',
    '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);',
    '"@',
    '  function Test-OwnConsoleVisible {',
    '    $hwnd = [HubConsoleVis.Native]::GetConsoleWindow()',
    '    if ($hwnd -eq [IntPtr]::Zero) { return $false }',
    '    return [bool][HubConsoleVis.Native]::IsWindowVisible($hwnd)',
    '  }',
    '  $hwnd = [HubConsoleVis.Native]::GetConsoleWindow()',
    '  if ($hwnd -eq [IntPtr]::Zero) { $payload.hwndZero = $true }',
    '  $payload.before = (Test-OwnConsoleVisible)',
    '  if (-not $payload.before) { Write-Payload; exit 0 }',
    "  $title = 'Project Hub 本機登入確認'",
    "  $button = '取消'",
    "  $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '  $child = Start-Process -FilePath $ps -NoNewWindow -PassThru -ArgumentList @(',
    "    '-NoProfile','-ExecutionPolicy','RemoteSigned','-File',('\"' + $ApproveScript + '\"'),",
    "    '-DataRoot',('\"' + $DataRoot + '\"'),'-Port',\"$Port\")",
    '  [void]$child.Handle',
    '  $payload.childPid = [int]$child.Id',
    '  [System.IO.File]::WriteAllText($PidsPath, "$PID $((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks)`n$($child.Id) $($child.StartTime.ToUniversalTime().Ticks)")',
    '  Add-Type -AssemblyName UIAutomationClient',
    '  Add-Type -AssemblyName UIAutomationTypes',
    '  $rootElement = [System.Windows.Automation.AutomationElement]::RootElement',
    '  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $child.Id)',
    '  $deadline = (Get-Date).AddSeconds(15)',
    '  do {',
    '    $all = @($rootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))',
    '    $matched = @()',
    '    foreach ($window in $all) {',
    '      if ($window.Current.Name -ceq $title) {',
    '        $rect = $window.Current.BoundingRectangle',
    '        $matched += [pscustomobject]@{ offscreen = [bool]$window.Current.IsOffscreen; width = [double]$rect.Width; height = [double]$rect.Height }',
    '      }',
    '    }',
    '    $visible = @($matched | Where-Object { -not $_.offscreen -and $_.width -gt 0 -and $_.height -gt 0 })',
    '    $payload.matched = [int]$matched.Count',
    '    if ($visible.Count -eq 1 -and $matched.Count -eq 1) { $payload.dialog = $true; break }',
    '    Start-Sleep -Milliseconds 200',
    '  } while ((Get-Date) -lt $deadline)',
    '  $payload.after = (Test-OwnConsoleVisible)',
    '  Write-Payload',
    '  if ($payload.dialog) {',
    '    & $Driver -ProcessId $child.Id -Title $title -ButtonName $button -Text \'\'',
    '    [void]$child.WaitForExit(20000)',
    '  }',
    '} catch {',
    '  $payload.error = [string]$_.Exception.Message',
    '  Write-Payload',
    '  exit 1',
    '}',
    'exit 0',
    '',
  ].join('\r\n');
  fs.writeFileSync(parentPath, '\uFEFF' + parent, { encoding: 'utf8' });
  fs.writeFileSync(bootstrapPath, [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$ParentScript,',
    '  [Parameter(Mandatory=$true)][string]$ApproveScript,',
    '  [Parameter(Mandatory=$true)][string]$Driver,',
    '  [Parameter(Mandatory=$true)][string]$DataRoot,',
    '  [Parameter(Mandatory=$true)][int]$Port,',
    '  [Parameter(Mandatory=$true)][string]$ResultPath,',
    '  [Parameter(Mandatory=$true)][string]$PidsPath',
    ')',
    "$ErrorActionPreference = 'Stop'",
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '$p = Start-Process -FilePath $ps -WindowStyle Normal -PassThru -ArgumentList @(',
    "  '-NoProfile','-ExecutionPolicy','RemoteSigned','-File',('\"' + $ParentScript + '\"'),",
    "  '-ApproveScript',('\"' + $ApproveScript + '\"'),",
    "  '-Driver',('\"' + $Driver + '\"'),",
    "  '-DataRoot',('\"' + $DataRoot + '\"'),",
    "  '-Port',\"$Port\",",
    "  '-ResultPath',('\"' + $ResultPath + '\"'),",
    "  '-PidsPath',('\"' + $PidsPath + '\"'))",
    '[void]$p.Handle',
    'Write-Output $p.Id',
    '',
  ].join('\r\n'), { encoding: 'ascii' });
  const tracked = { parent: 0, child: 0 };
  t.after(() => {
    const recorded = fs.existsSync(pidsPath) ? fs.readFileSync(pidsPath, 'utf8') : '';
    for (const line of recorded.split(/\r?\n/)) { const m = /^(\d+) (\d{1,19})$/.exec(line.trim()); if (m) killPidWithTicks(Number(m[1]), m[2]); }
    killPid(tracked.parent);
    killPid(tracked.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const started = await runPs(['-NoProfile', '-NonInteractive', '-File', bootstrapPath, '-ParentScript', parentPath, '-ApproveScript', approveScript, '-Driver', dialogDriver, '-DataRoot', root, '-Port', String(port), '-ResultPath', resultPath, '-PidsPath', pidsPath], { timeout: 20000 });
  const parentPid = started.stdout.trim();
  assert.match(parentPid, /^\d+$/, 'Start-Process -WindowStyle Normal did not return a parent pid: ' + started.stdout);
  tracked.parent = Number(parentPid);rememberPid(tracked.parent);
  const deadline = Date.now() + 40000;
  let resultText = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath) && fs.statSync(resultPath).size > 0) {
      resultText = fs.readFileSync(resultPath, 'utf8');
      if (resultText.trim()) break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(resultText.trim(), 'parent console helper wrote no result; pids=' + (fs.existsSync(pidsPath) ? fs.readFileSync(pidsPath, 'utf8') : ''));
  let result = JSON.parse(resultText.replace(/^\uFEFF/, ''));
  if (Number.isInteger(result.childPid) && result.childPid > 0) {tracked.child = result.childPid;rememberPid(tracked.child);}
  if (result.before !== true) {
    const why = result.hwndZero ? 'GetConsoleWindow returned 0' : 'IsWindowVisible was false';
    t.skip(`parent console was not visible before launch (${why}); headless session, skipped instead of failing`);
    return;
  }
  const exitDeadline = Date.now() + 25000;
  while (Date.now() < exitDeadline) {
    try { process.kill(tracked.parent, 0); }
    catch { break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  try { process.kill(tracked.parent, 0); tracked.parentAlive = true; }
  catch { tracked.parentAlive = false; }
  result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
  if (Number.isInteger(result.childPid) && result.childPid > 0) {tracked.child = result.childPid;rememberPid(tracked.child);}
  assert.equal(tracked.parentAlive, false, 'parent console helper did not exit after closing the dialog');
  assert.equal(result.error || '', '', 'parent console helper failed: ' + (result.error || ''));
  assert.equal(result.dialog, true, 'approval dialog did not appear on the shared console: ' + JSON.stringify(result));
  assert.equal(result.after, true, 'parent console was hidden while the approval dialog was up: ' + JSON.stringify(result));
});
