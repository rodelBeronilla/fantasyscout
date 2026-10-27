#!/usr/bin/env bash
# Open or update a data-incident issue when an ingest job fails; close it when the next run passes.
# Inputs (env): TITLE, OUTCOME (success|failure|cancelled|skipped), GH_TOKEN, and land.log in the cwd.
set -euo pipefail

run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
existing=$(gh issue list --label data-incident --state open --search "\"${TITLE}\" in:title" --json number,title \
  --jq --arg t "$TITLE" '[.[] | select(.title == $t)][0].number // empty')
summary=$(tail -n 25 land.log 2>/dev/null || echo "(no log)")

if [ "$OUTCOME" = "success" ]; then
  if [ -n "$existing" ]; then
    gh issue close "$existing" --comment "$(printf 'Recovered: [run %s](%s) passed.\n\n```\n%s\n```' "$GITHUB_RUN_ID" "$run_url" "$summary")"
    echo "closed incident #$existing"
  fi
  exit 0
fi

body=$(printf 'Outcome: **%s**. [Run %s](%s)\n\n```\n%s\n```\n\nSee docs/runbook.md ("Rerun a day").' "$OUTCOME" "$GITHUB_RUN_ID" "$run_url" "$summary")
if [ -n "$existing" ]; then
  gh issue comment "$existing" --body "$body"
  echo "updated incident #$existing"
else
  gh issue create --title "$TITLE" --label "data-incident,P1-high,area:ingest" --body "$body"
  echo "opened incident"
fi
