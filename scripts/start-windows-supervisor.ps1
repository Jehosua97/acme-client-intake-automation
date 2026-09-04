[CmdletBinding()]
param(
  [int]$HealthIntervalSeconds = 15,
  [int]$RestartDelaySeconds = 10,
  [string]$NodePath = "",
  [string]$NpmPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $repositoryRoot ".data"
$logDirectory = Join-Path $dataDirectory "logs"
$supervisorLog = Join-Path $logDirectory "supervisor.log"
$mutex = [System.Threading.Mutex]::new($false, "Local\ACMEClientIntakeBotSupervisor")
$ownsMutex = $false
$healthPort = 3188
$whatsAppSessionRoot = [System.IO.Path]::GetFullPath((Join-Path $dataDirectory "whatsapp-session"))

$environmentPath = Join-Path $repositoryRoot ".env"
if (Test-Path -LiteralPath $environmentPath) {
  $portLine = Get-Content -LiteralPath $environmentPath | Where-Object { $_ -match "^\s*PORT\s*=" } | Select-Object -First 1
  if ($portLine -and $portLine -match "^\s*PORT\s*=\s*(\d+)\s*$") {
    $healthPort = [int]$matches[1]
  }
}
$healthUri = "http://127.0.0.1:$healthPort/api/system/status"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-SupervisorLog {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message
  Add-Content -LiteralPath $supervisorLog -Value $line -Encoding UTF8
}

function Get-DescendantProcessIds {
  param([int]$RootProcessId)
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $descendants = [System.Collections.Generic.List[int]]::new()
  $pending.Enqueue($RootProcessId)
  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    foreach ($process in $processes) {
      if ([int]$process.ParentProcessId -eq $parentId -and -not $descendants.Contains([int]$process.ProcessId)) {
        $childId = [int]$process.ProcessId
        $descendants.Add($childId)
        $pending.Enqueue($childId)
      }
    }
  }
  return @($descendants)
}

function Stop-BotProcessTree {
  param([int]$RootProcessId)
  $descendants = @(Get-DescendantProcessIds -RootProcessId $RootProcessId)
  [array]::Reverse($descendants)
  foreach ($processId in $descendants) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
  Write-SupervisorLog "Stopped Node PID $RootProcessId and $($descendants.Count) descendant process(es)."
}

function Stop-StaleWhatsAppBrowsers {
  param([string]$SessionRoot)
  $resolvedRepository = [System.IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\') + '\'
  $resolvedSession = [System.IO.Path]::GetFullPath($SessionRoot)
  if (-not $resolvedSession.StartsWith($resolvedRepository, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to inspect browser processes outside the repository: $resolvedSession"
  }
  $matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @("chrome.exe", "msedge.exe") `
      -and $_.CommandLine `
      -and $_.CommandLine.IndexOf($resolvedSession, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($matches.Count -eq 0) { return }
  foreach ($process in ($matches | Sort-Object ProcessId -Descending)) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  Write-SupervisorLog "Removed $($matches.Count) stale WhatsApp browser process(es) for the local session."
  Start-Sleep -Seconds 2
}

try {
  try {
    $ownsMutex = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }

  if (-not $ownsMutex) {
    Write-SupervisorLog "Another supervisor instance is already active; this instance will exit."
    exit 0
  }

  Set-Location -LiteralPath $repositoryRoot
  if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
  if (-not $NpmPath) { $NpmPath = (Get-Command npm.cmd -ErrorAction Stop).Source }
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable not found: $NodePath" }
  if (-not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) { throw "npm executable not found: $NpmPath" }
  $buildLog = Join-Path $logDirectory "build.log"
  $buildErrorLog = Join-Path $logDirectory "build-error.log"

  Write-SupervisorLog "Building the production application before startup."
  $buildProcess = Start-Process `
    -FilePath $NpmPath `
    -ArgumentList @("run", "build") `
    -WorkingDirectory $repositoryRoot `
    -RedirectStandardOutput $buildLog `
    -RedirectStandardError $buildErrorLog `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($buildProcess.ExitCode -ne 0) {
    throw "Production build failed with exit code $($buildProcess.ExitCode). See $buildLog and $buildErrorLog"
  }

  $restartAttempts = 0
  while ($true) {
    Stop-StaleWhatsAppBrowsers -SessionRoot $whatsAppSessionRoot
    $startedAt = Get-Date
    $runSuffix = $startedAt.ToString("yyyy-MM-dd-HHmmss")
    $stdoutLog = Join-Path $logDirectory "bot-$runSuffix.log"
    $stderrLog = Join-Path $logDirectory "bot-$runSuffix-error.log"
    $consecutiveFailures = 0

    Write-SupervisorLog "Starting Node production process."
    $botProcess = Start-Process `
      -FilePath $NodePath `
      -ArgumentList @("dist/src/server.js") `
      -WorkingDirectory $repositoryRoot `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -WindowStyle Hidden `
      -PassThru

    while (-not $botProcess.HasExited) {
      Start-Sleep -Seconds $HealthIntervalSeconds
      if ($botProcess.HasExited) { break }

      try {
        $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 10
        $whatsAppState = [string]$health.whatsapp.state
        $startupAge = ((Get-Date) - $startedAt).TotalSeconds
        $unhealthyWhatsApp = $whatsAppState -in @("ERROR", "DISCONNECTED") `
          -or ($startupAge -ge 300 -and $whatsAppState -in @("STARTING", "AUTHENTICATED"))

        if ($unhealthyWhatsApp) {
          $consecutiveFailures++
          Write-SupervisorLog "Health check reported WhatsApp state $whatsAppState ($consecutiveFailures/3)."
        } else {
          $consecutiveFailures = 0
          if ($whatsAppState -eq "READY") { $restartAttempts = 0 }
        }
      } catch {
        $consecutiveFailures++
        Write-SupervisorLog "HTTP health check failed ($consecutiveFailures/3): $($_.Exception.Message)"
      }

      if ($consecutiveFailures -ge 3 -and -not $botProcess.HasExited) {
        Write-SupervisorLog "The application is unhealthy; terminating PID $($botProcess.Id) so it can recover."
        Stop-BotProcessTree -RootProcessId $botProcess.Id
        Stop-StaleWhatsAppBrowsers -SessionRoot $whatsAppSessionRoot
        break
      }
    }

    $botProcess.WaitForExit()
    $exitCode = try {
      $botProcess.Refresh()
      $botProcess.ExitCode
    } catch {
      "unknown"
    }
    $restartAttempts++
    $nextDelay = [Math]::Min([Math]::Max($RestartDelaySeconds, $RestartDelaySeconds * [Math]::Pow(2, [Math]::Min($restartAttempts - 1, 5))), 300)
    Write-SupervisorLog "Node process exited with code $exitCode. Restart attempt $restartAttempts in $nextDelay seconds."
    Start-Sleep -Seconds $nextDelay
  }
} catch {
  Write-SupervisorLog "Supervisor stopped because of an error: $($_.Exception.Message)"
  throw
} finally {
  if ($ownsMutex) {
    try { $mutex.ReleaseMutex() } catch { }
  }
  $mutex.Dispose()
}
