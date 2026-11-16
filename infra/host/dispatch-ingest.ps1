# Starts the FantasyScout ingest from the home runner host, because GitHub runs scheduled
# workflows late or drops them (docs/runbook.md, "Publish SLA and the watchdog"). The GitHub cron
# stays as the fallback; a second ingest on the same day lands nothing new.
#
# Run by four Task Scheduler tasks (infra/host/README.md): "FantasyScout morning ingest"
# (-Source both) and the three report runs (-Source reports). Each run appends one line to
# dispatch-ingest.log beside this script; that log, not the task's last result, says how it went.
#
# The tasks start this under `conhost.exe --headless`, so no console window flashes over a
# fullscreen application (#985). Ending such a task ends conhost but not this script, so the
# script keeps its own deadline on the one call that can hang.
param([ValidateSet('both', 'reports')][string]$Source = 'both', [int]$TimeoutSeconds = 120)
$log = Join-Path $PSScriptRoot 'dispatch-ingest.log'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + 'Z'

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $gh
$psi.Arguments = "workflow run ingest.yml --repo rodelBeronilla/fantasyscout --ref main -f source=$Source"
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
try {
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()
  if ($p.WaitForExit($TimeoutSeconds * 1000)) {
    $p.WaitForExit()
    $out = ($stdout.Result + $stderr.Result).Trim()
    $status = if ($p.ExitCode -eq 0) { 'dispatched' } else { "FAILED (exit $($p.ExitCode))" }
  } else {
    $p.Kill()
    $out = ''
    $status = "FAILED (gh gave no answer in $TimeoutSeconds s)"
  }
} catch {
  $out = $_.Exception.Message
  $status = 'FAILED (gh did not start)'
}
Add-Content -Path $log -Value "$stamp $status source=$Source $out"
# keep the log short
$lines = Get-Content $log
if ($lines.Count -gt 400) { $lines | Select-Object -Last 300 | Set-Content $log }
