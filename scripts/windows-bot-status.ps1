[CmdletBinding()]
param(
  [string]$TaskName = "ACME Client Intake Bot"
)

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$healthPort = 3188
$environmentPath = Join-Path $repositoryRoot ".env"
if (Test-Path -LiteralPath $environmentPath) {
  $portLine = Get-Content -LiteralPath $environmentPath | Where-Object { $_ -match "^\s*PORT\s*=" } | Select-Object -First 1
  if ($portLine -and $portLine -match "^\s*PORT\s*=\s*(\d+)\s*$") {
    $healthPort = [int]$matches[1]
  }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Output "Scheduled task '$TaskName' is not installed."
  exit 1
}

$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
$health = $null
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$healthPort/api/system/status" -Method Get -TimeoutSec 10
} catch { }

[pscustomobject]@{
  TaskName = $task.TaskName
  TaskState = $task.State
  LastRunTime = $taskInfo.LastRunTime
  LastTaskResult = $taskInfo.LastTaskResult
  WhatsAppState = $health.whatsapp.state
  DriveConnected = $health.googleDrive.connected
  PanelResponding = $null -ne $health
} | Format-List
