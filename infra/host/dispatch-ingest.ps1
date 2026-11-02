# Starts the FantasyScout ingest from the home runner host, because GitHub runs scheduled
# workflows late or drops them (docs/runbook.md, "Publish SLA and the watchdog"). The GitHub cron
# stays as the fallback; a second ingest on the same day lands nothing new.
#
# Run by two Task Scheduler tasks (infra/host/README.md): "FantasyScout morning ingest"
# (-Source both) and "FantasyScout evening reports" (-Source reports). Each run appends one line to
# dispatch-ingest.log beside this script.
param([ValidateSet('both', 'reports')][string]$Source = 'both')
$log = Join-Path $PSScriptRoot 'dispatch-ingest.log'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + 'Z'
$out = & $gh workflow run ingest.yml --repo rodelBeronilla/fantasyscout --ref main -f "source=$Source" 2>&1 | Out-String
$status = if ($LASTEXITCODE -eq 0) { 'dispatched' } else { "FAILED (exit $LASTEXITCODE)" }
Add-Content -Path $log -Value "$stamp $status source=$Source $($out.Trim())"
# keep the log short
$lines = Get-Content $log
if ($lines.Count -gt 400) { $lines | Select-Object -Last 300 | Set-Content $log }
