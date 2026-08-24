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

  Write-SupervisorLog "Building the production application before startup."
  & $NpmPath run build *>> $buildLog
  if ($LASTEXITCODE -ne 0) {
    throw "Production build failed with exit code $LASTEXITCODE. See $buildLog"
  }

  while ($true) {
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
        }
      } catch {
        $consecutiveFailures++
        Write-SupervisorLog "HTTP health check failed ($consecutiveFailures/3): $($_.Exception.Message)"
      }

      if ($consecutiveFailures -ge 3 -and -not $botProcess.HasExited) {
        Write-SupervisorLog "The application is unhealthy; terminating PID $($botProcess.Id) so it can recover."
        Stop-Process -Id $botProcess.Id -Force -ErrorAction SilentlyContinue
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
    Write-SupervisorLog "Node process exited with code $exitCode. Restarting in $RestartDelaySeconds seconds."
    Start-Sleep -Seconds $RestartDelaySeconds
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
