<#
.SYNOPSIS
  Removes the Scheduled Task registered by install-service.ps1, and
  optionally stops the currently running server.

.DESCRIPTION
  Only unregisters the task; it does not touch auth/.storage/, output/, or
  logs/ -- signed-in sessions and generated documents are exactly the kind
  of thing a person expects to survive uninstalling the auto-start, not
  something a cleanup script should guess is safe to delete.
#>
param(
  [switch]$StopRunning
)

$ErrorActionPreference = 'Stop'
$TaskName = 'UIDocumentationEngine'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "No task named '$TaskName' is registered -- nothing to do."
  exit 0
}

if ($task.State -eq 'Running') {
  if ($StopRunning) {
    Write-Host "Stopping running task..."
    Stop-ScheduledTask -TaskName $TaskName
  } else {
    Write-Host "Task is currently running. Re-run with -StopRunning to stop it as part of removal, or it will keep running (as an ordinary process, no longer auto-restarting) until stopped by hand."
  }
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'."
