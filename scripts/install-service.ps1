<#
.SYNOPSIS
  Registers the UI Documentation Engine to start automatically, via a
  Windows Scheduled Task -- no extra software installed to do it.

.DESCRIPTION
  Wraps the built-in Task Scheduler rather than a dedicated Windows-service
  tool (nssm, node-windows, ...): none of those were already a dependency of
  this project, and Task Scheduler needs nothing beyond what every Windows
  machine already has, which keeps "no dependency to install" true for the
  server host as well as for the people using it from a browser.

  Two trigger modes:

    -AtLogon (default)   Starts when the current user logs in. No elevation
                          required. The server only runs while that user's
                          session exists -- fine for "runs on my desk while
                          I'm signed in", not for a machine nobody logs into.

    -AtStartup            Starts at boot, before any login, running as
                          SYSTEM. Genuinely unattended. Requires this script
                          to be run *as Administrator* -- registering a
                          SYSTEM-principal task is a privileged operation, not
                          a limitation added here.

  Either way the task launches scripts/run-server.ps1, which is what
  actually keeps the server up across a crash; this script only arranges
  for that wrapper to start on its own.

.PARAMETER Port
  Port to listen on. Default 5173.

.PARAMETER AtStartup
  Register a boot-time, SYSTEM-level task instead of the default per-user
  logon task. Requires an elevated (Run as Administrator) PowerShell.

.EXAMPLE
  .\install-service.ps1
  Starts the server whenever you log in to this machine.

.EXAMPLE
  .\install-service.ps1 -AtStartup
  (Run as Administrator) Starts the server at boot, for every user, with
  nobody needing to log in.
#>
param(
  [int]$Port = 5173,
  [switch]$AtStartup
)

$ErrorActionPreference = 'Stop'
$TaskName = 'UIDocumentationEngine'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunnerScript = Join-Path $PSScriptRoot 'run-server.ps1'

$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($AtStartup -and -not $isElevated) {
  Write-Error "-AtStartup registers a SYSTEM-level task, which needs an elevated PowerShell. Right-click PowerShell -> 'Run as Administrator' and re-run this script, or drop -AtStartup to install a per-login task instead (no elevation needed)."
  exit 1
}

# Windows Firewall must explicitly permit inbound TCP on the port -- checked
# against a real deployment: this machine had an active Block rule for
# node.exe on the Public profile (left by an earlier "Block access" click on
# Windows' own connect-time prompt) and no Allow rule of any kind, so without
# this a request from any other machine is refused with nothing in this
# project's own logs to explain why.
#
# New-NetFirewallRule requires elevation; only attempted here when already
# elevated (either -AtStartup, or a plain run from an elevated prompt) so a
# non-admin run of the default per-login mode does not fail outright over it
# -- it just leaves this one step for a person to do separately (the error
# below says so). Scoped to the Private profile only, so the port stays
# blocked on an untrusted network (coffee-shop Wi-Fi, a phone hotspot) even
# though it is reachable on this machine's actual corporate LAN.
if ($isElevated) {
  $fwRuleName = "UI Documentation Engine (port $Port)"
  $existing = Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule '$fwRuleName' already exists -- not recreating."
  } else {
    Write-Host "Adding firewall rule to allow inbound TCP/$Port on Private networks..."
    New-NetFirewallRule -DisplayName $fwRuleName -Direction Inbound -Protocol TCP `
      -LocalPort $Port -Action Allow -Profile Private -ErrorAction Stop | Out-Null
    Write-Host "OK"
  }
} else {
  Write-Host "Skipping the firewall rule (not running elevated) -- if other machines on the network cannot reach this server, run this script from an elevated PowerShell, or add the rule by hand:"
  Write-Host "  New-NetFirewallRule -DisplayName 'UI Documentation Engine (port $Port)' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private"
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "A task named '$TaskName' already exists -- removing it first so this run replaces it cleanly, rather than leaving two tasks racing for the same port."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerScript`" -Port $Port" `
  -WorkingDirectory $ProjectRoot

if ($AtStartup) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $mode = 'at boot, as SYSTEM -- runs with nobody logged in'
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $mode = "at logon, as $env:USERNAME -- runs only while that user is signed in"
}

# Belt-and-suspenders alongside run-server.ps1's own restart loop: if
# PowerShell itself (not just the server it launched) dies unexpectedly,
# Task Scheduler brings the whole thing back rather than leaving it down
# until someone notices.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0) # no time limit -- this runs indefinitely

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "UI Documentation Engine web server (port $Port) -- see scripts/run-server.ps1" `
  | Out-Null

Write-Host "Registered scheduled task '$TaskName' ($mode)."
Write-Host "Starting it now..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "Task state: $state"
Write-Host ""
Write-Host "Logs: $ProjectRoot\logs\server-<date>.log"
Write-Host "To stop:      Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "To uninstall: .\scripts\uninstall-service.ps1"
