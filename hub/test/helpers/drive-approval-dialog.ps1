# Test helper: drives the native approval window like a user would (paste the code, press the button).
# WinForms controls hosted by PowerShell are exposed to UI Automation only as generic panes, so UI Automation
# is used to find the window and the native handles, and standard Win32 messages type and click.
# Names are arguments so this file stays ASCII.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$ButtonName,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
    [int]$WaitSeconds = 25
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace HubTest -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
'@
$WM_SETTEXT = 0x000C
$BM_CLICK = 0x00F5
$root = [System.Windows.Automation.AutomationElement]::RootElement
$byProcess = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
$window = $null
$edit = $null
$button = $null
$deadline = (Get-Date).AddSeconds($WaitSeconds)
# The window can exist a moment before its child controls do, so wait for the controls too.
while ((-not $edit -or -not $button) -and (Get-Date) -lt $deadline) {
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $byProcess)
    if ($window) {
        foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            if (-not $edit -and $element.Current.ClassName -like 'WindowsForms10.EDIT*') { $edit = $element }
            if (-not $button -and $element.Current.Name -ceq $ButtonName -and $element.Current.ClassName -like 'WindowsForms10.BUTTON*') { $button = $element }
        }
    }
    if (-not $edit -or -not $button) { Start-Sleep -Milliseconds 200 }
}
if (-not $window) { [Console]::Out.WriteLine('NO_WINDOW'); exit 2 }
if ($window.Current.Name -cne $Title) { [Console]::Out.WriteLine('WRONG_TITLE'); exit 3 }
if (-not $edit) { [Console]::Out.WriteLine('NO_EDIT'); exit 4 }
if (-not $button) { [Console]::Out.WriteLine('NO_BUTTON'); exit 5 }
[void][HubTest.Win32]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, $WM_SETTEXT, [IntPtr]::Zero, $Text)
# PostMessage: the click handler can run for seconds (it talks to the Hub); do not block this helper on it.
if (-not [HubTest.Win32]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)) { [Console]::Out.WriteLine('CLICK_FAILED'); exit 6 }
[Console]::Out.WriteLine('INVOKED')
