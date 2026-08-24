[CmdletBinding()]
param(
  [string]$TaskName = "ACME Client Intake Bot"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$supervisorPath = Join-Path $PSScriptRoot "start-windows-supervisor.ps1"
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = [System.Security.Principal.WindowsPrincipal]::new($currentIdentity)
$isAdministrator = $currentPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$userId = $currentIdentity.Name

if (-not (Test-Path -LiteralPath $supervisorPath -PathType Leaf)) {
  throw "Supervisor script not found: $supervisorPath"
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# A stopped scheduled task can leave its child Node process alive. Remove only
# a production server listening on this project's configured local port.
$healthPort = 3188
$environmentPath = Join-Path $repositoryRoot ".env"
if (Test-Path -LiteralPath $environmentPath) {
  $portLine = Get-Content -LiteralPath $environmentPath | Where-Object { $_ -match "^\s*PORT\s*=" } | Select-Object -First 1
  if ($portLine -and $portLine -match "^\s*PORT\s*=\s*(\d+)\s*$") { $healthPort = [int]$matches[1] }
}
Get-NetTCPConnection -LocalPort $healthPort -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)"
  if ($candidate.ExecutablePath -eq $nodePath -and $candidate.CommandLine -like '*dist/src/server.js*') {
    Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop
  } else {
    throw "Port $healthPort is occupied by an unmanaged process (PID $($_.OwningProcess)); installation stopped safely."
  }
}

$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorPath`" -NodePath `"$nodePath`" -NpmPath `"$npmPath`""
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $repositoryRoot
if ($isAdministrator) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $startupDescription = "at Windows startup, before sign-in"
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $startupDescription = "at Windows sign-in (run this installer as Administrator for pre-login startup)"
}
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Runs and supervises the local MultiServicios WhatsApp bot invisibly $startupDescription." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Scheduled task '$TaskName' was installed invisibly $startupDescription and started."
