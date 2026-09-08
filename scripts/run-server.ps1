<#
.SYNOPSIS
  Runs the UI Documentation Engine server and keeps it running.

.DESCRIPTION
  Intended as the entry point for unattended hosting (a Scheduled Task —
  see install-service.ps1), not for interactive use, where `npm run serve`
  directly is simpler.

  A plain `npm run serve` exits the moment the Node process dies for any
  reason (an uncaught exception in a capture run, the machine's network
  stack hiccupping) and, run unattended, nothing brings it back until a
  person notices. This wraps it in a restart loop, and gives it somewhere
  to write output: an unattended process has no terminal for `npm run serve`
  to print to, so its own log lines would otherwise vanish.

.PARAMETER Port
  Port to listen on. Default 5173, matching the project default.

.NOTES
  Ctrl+C (or a Scheduled Task stop) exits the loop rather than restarting —
  ServerExited below only fires on the *child* process ending, not this
  script.
#>
param(
  [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# One file per calendar day rather than one growing file, so a log from a
# problem three weeks ago is still there without ever needing a size-based
# rotation and its own cleanup logic.
function Get-LogPath {
  Join-Path $LogDir "server-$(Get-Date -Format 'yyyy-MM-dd').log"
}

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [runner] $Message"
  Add-Content -Path (Get-LogPath) -Value $line -Encoding utf8
}

Write-Log "run-server starting (port $Port, project root $ProjectRoot)"

# Old daily logs are not deleted automatically -- a shared server accumulates
# them slowly (a few KB/day of runner lines; the app's own per-run traces
# already live under output/, not here) and pruning silently loses whatever
# a person might come back looking for after an incident. Delete old files
# under logs/ by hand if disk space ever becomes a concern.

Set-Location $ProjectRoot

$restartCount = 0
while ($true) {
  $startedAt = Get-Date
  Write-Log "launching npm run serve -- -p $Port (attempt $($restartCount + 1))"

  # npm's own stdout/stderr redirected straight to the daily log file, both
  # streams into the same file in the order they were written -- the app's
  # own log lines already carry a timestamp (see src/util/logger.ts), and
  # error output split into a separate file would read out of sequence with
  # them. `Start-Process -RedirectStandardOutput/-RedirectStandardError`
  # cannot target the same file (it errors outright), so this shells out to
  # cmd.exe, whose `>>path 2>&1` merges both before either reaches disk.
  $logPath = Get-LogPath
  $proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c', "npm run serve -- -p $Port >>`"$logPath`" 2>&1") `
    -WorkingDirectory $ProjectRoot `
    -NoNewWindow -PassThru -Wait

  $exitCode = $proc.ExitCode
  $ranFor = (Get-Date) - $startedAt
  Write-Log "server exited (code $exitCode) after $([int]$ranFor.TotalSeconds)s"

  # A crash within seconds of starting (bad config, port permanently taken
  # by something else) restarting in a tight loop would spin the CPU and
  # flood the log; a real crash after the server was actually up restarts
  # right away, since that is the whole point of this wrapper.
  if ($ranFor.TotalSeconds -lt 10) {
    $restartCount++
    $backoff = [Math]::Min(60, [Math]::Pow(2, [Math]::Min($restartCount, 6)))
    Write-Log "exited quickly -- backing off $backoff s before retrying"
    Start-Sleep -Seconds $backoff
  } else {
    $restartCount = 0
  }
}
