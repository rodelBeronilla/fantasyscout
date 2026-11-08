# Host-side ingest dispatch

GitHub starts scheduled workflows late on busy hours and sometimes not at all: in the first week of
November 2026 the morning cron fired three to seven hours late, and on 2026-11-02 the morning ingest
and the midday watchdog never ran. The home runner host is always on, so it starts both ingest runs
itself, and the crons in `.github/workflows/ingest.yml` stay as the fallback. The landing is
idempotent per day: when the late cron run arrives it lands nothing new (its build republishes the
same data; the evening one refreshes the injury reports closer to tip-off).

| Task | Local time (Eastern) | Runs | GitHub fallback |
| --- | --- | --- | --- |
| FantasyScout morning ingest | 04:30 | `ingest.yml`, source `both` | `27 9 * * *` UTC |
| FantasyScout evening reports | 17:15 | `ingest.yml`, source `reports` | `41 22 * * *` UTC |
| FantasyScout late reports 1 | 18:45 | `ingest.yml`, source `reports` | `47 23 * * *` UTC |
| FantasyScout late reports 2 | 21:15 | `ingest.yml`, source `reports` | `17 2 * * *` UTC |

The two late runs land the injury report and the lineups again about half an hour before the 7 pm
and 10 pm Eastern tip-offs, when confirmed lineups and late scratches come out, so the Today card's
start and sit reads them (#816). Each is a reports-only run and its light build.

The times are the host's local time on purpose: the games and the 5 pm injury filing follow
Eastern time, so the runs keep their place in the day across the clock change, where a UTC cron
moves by an hour.

## Install (Windows host)

The tasks run as the signed-in user, whose `gh` must be signed in (`gh auth status`) with a token
that can start workflows on this repository (`workflow` scope, or a fine-grained token with
Actions: write).

1. Copy `dispatch-ingest.ps1` to a folder outside the checkout, so a branch switch cannot move it,
   e.g. `C:\Users\<you>\fantasyscout-host\`.
2. In PowerShell:

```powershell
$script = 'C:\Users\<you>\fantasyscout-host\dispatch-ingest.ps1'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
foreach ($t in @(@{ Name = 'FantasyScout morning ingest'; At = '04:30'; Source = 'both' },
                 @{ Name = 'FantasyScout evening reports'; At = '17:15'; Source = 'reports' },
                 @{ Name = 'FantasyScout late reports 1'; At = '18:45'; Source = 'reports' },
                 @{ Name = 'FantasyScout late reports 2'; At = '21:15'; Source = 'reports' })) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Source $($t.Source)"
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger (New-ScheduledTaskTrigger -Daily -At $t.At) -Settings $settings -Principal $principal -Force
}
```

`-StartWhenAvailable` runs a missed start as soon as the host is back, so a reboot over 04:30 still
dispatches the morning run.

## Check

- `Get-ScheduledTask -TaskName 'FantasyScout*' | Get-ScheduledTaskInfo` shows the last and next run
  and the last result (0 is success).
- `dispatch-ingest.log` beside the script has one line per run: `dispatched` with the run's URL, or
  `FAILED` with gh's message (usually an expired sign-in: `gh auth login` again).
- The Actions tab lists the run with the event `workflow_dispatch` a few minutes after the task time.

## Remove

```powershell
Unregister-ScheduledTask -TaskName 'FantasyScout morning ingest','FantasyScout evening reports','FantasyScout late reports 1','FantasyScout late reports 2' -Confirm:$false
```

## Linux host

The same runs from cron, with `gh` signed in as the cron user (`TZ` keeps them on Eastern time):

```cron
CRON_TZ=America/New_York
30 4 * * *   gh workflow run ingest.yml --repo rodelBeronilla/fantasyscout -f source=both >> /var/log/fantasyscout-ingest.log 2>&1
15 17 * * *  gh workflow run ingest.yml --repo rodelBeronilla/fantasyscout -f source=reports >> /var/log/fantasyscout-ingest.log 2>&1
45 18 * * *  gh workflow run ingest.yml --repo rodelBeronilla/fantasyscout -f source=reports >> /var/log/fantasyscout-ingest.log 2>&1
15 21 * * *  gh workflow run ingest.yml --repo rodelBeronilla/fantasyscout -f source=reports >> /var/log/fantasyscout-ingest.log 2>&1
```
