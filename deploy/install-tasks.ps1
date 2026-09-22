# Registers Financial Monitoring to start with the computer and back itself up nightly.
#
# Run this once, in an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\install-tasks.ps1
#
# The tasks run as SYSTEM, so the service comes up after a reboot without anyone signing in
# and without a stored password. Remove them again with -Remove.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$caddy = (Get-Command caddy -ErrorAction SilentlyContinue).Source

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this in an Administrator PowerShell.'
}

$names = @('FinancialMonitoring', 'FinancialMonitoringProxy', 'FinancialMonitoringBackup')
foreach ($name in $names) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Removed existing task: $name"
    }
}
if ($Remove) { Write-Host 'All tasks removed.'; return }

if (-not $node) { throw 'Node.js was not found on the PATH.' }
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$restart = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

# The service itself.
Register-ScheduledTask -TaskName 'FinancialMonitoring' -Principal $principal -Settings $restart `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$root\deploy\start-service.cmd`"" -WorkingDirectory $root) `
    -Description 'Financial Monitoring - Black Stone Mineral Resources Inc' | Out-Null
Write-Host 'Registered: FinancialMonitoring (starts with the computer)'

# The HTTPS front door for the office network.
if ($caddy) {
    Register-ScheduledTask -TaskName 'FinancialMonitoringProxy' -Principal $principal -Settings $restart `
        -Trigger (New-ScheduledTaskTrigger -AtStartup) `
        -Action (New-ScheduledTaskAction -Execute $caddy -Argument "run --config `"$root\deploy\Caddyfile`"" -WorkingDirectory "$root\deploy") `
        -Description 'HTTPS front door for Financial Monitoring' | Out-Null
    Write-Host 'Registered: FinancialMonitoringProxy (Caddy, starts with the computer)'
} else {
    Write-Warning 'Caddy is not installed, so the office-network front door was not registered. Install it, then run this script again.'
}

# A verified backup every hour. Nightly would leave a whole day's approvals at risk; hourly
# costs a fraction of a second and caps the loss at an hour.
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 1)
Register-ScheduledTask -TaskName 'FinancialMonitoringBackup' -Principal $principal `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable) `
    -Trigger $hourly `
    -Action (New-ScheduledTaskAction -Execute $node -Argument 'scripts\backup.mjs' -WorkingDirectory $root) `
    -Description 'Hourly verified backup of the Financial Monitoring database' | Out-Null
Write-Host 'Registered: FinancialMonitoringBackup (every hour)'

Write-Host ''
Write-Host 'Done. Start them now without rebooting:'
Write-Host '  Start-ScheduledTask -TaskName FinancialMonitoring'
if ($caddy) { Write-Host '  Start-ScheduledTask -TaskName FinancialMonitoringProxy' }
Write-Host ''
Write-Host 'Allow the office network in:'
Write-Host '  New-NetFirewallRule -DisplayName "Financial Monitoring HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private'
