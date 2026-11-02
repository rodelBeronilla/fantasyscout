#!/usr/bin/env bash
# Is each home runner registered, online and healthy? Run from the host by cron (see README.md,
# "Monitor"); exit 0 when both are, 1 otherwise, and open or update a data-incident issue so the
# gap is seen before a stats job queues for a day. Needs gh signed in to a fine-grained token with
# Administration: read and Issues: write on this repository.
#
#   */30 * * * *  /path/to/fantasyscout/infra/runner/check.sh >> /var/log/fantasyscout-runner.log 2>&1
set -uo pipefail

REPO="${RUNNER_REPO:-rodelBeronilla/fantasyscout}"
COMPOSE="${RUNNER_COMPOSE:-$(dirname "$0")/compose.yml}"
TITLE="Home runner offline: stats jobs will queue"

problems=""
# What GitHub sees: each runner registered to the repository and its status.
if ! runners=$(gh api "repos/$REPO/actions/runners" --jq '.runners[] | "\(.name) \(.status) busy=\(.busy)"' 2>&1); then
  problems="GitHub API: $runners"
else
  echo "$(date -u +%FT%TZ) $runners" | tr '\n' ';'; echo
  online=$(printf '%s\n' "$runners" | grep -c ' online ' || true)
  [ "$online" -ge 2 ] || problems="only $online of 2 runners online (${runners//$'\n'/; })"
fi
# What the host sees: both containers up and passing their healthcheck.
for name in fantasyscout-runner fantasyscout-runner-2; do
  state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null || echo "missing")
  case "$state" in
    "running healthy") ;;
    *) problems="${problems:+$problems; }$name is $state" ;;
  esac
done

if [ -z "$problems" ]; then
  outcome=success; body="Recovered: both home runners online and healthy."
else
  outcome=failure; body="$problems. See infra/runner/README.md, \"Runner shows offline\"."
  echo "$(date -u +%FT%TZ) $problems"
fi

# Open, update or close the incident, like .github/scripts/incident.py does for a job.
existing=$(gh issue list --repo "$REPO" --label data-incident --state open --search "\"$TITLE\" in:title" --json number,title --jq ".[] | select(.title == \"$TITLE\") | .number" 2>/dev/null | head -1)
if [ "$outcome" = "success" ]; then
  if [ -n "$existing" ]; then
    gh issue comment "$existing" --repo "$REPO" --body "$body" >/dev/null && gh issue close "$existing" --repo "$REPO" >/dev/null
    echo "closed incident #$existing"
  fi
  exit 0
fi
if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$REPO" --body "$body" >/dev/null && echo "updated incident #$existing"
else
  gh issue create --repo "$REPO" --title "$TITLE" --body "$body" --label data-incident,P1-high,area:ops >/dev/null && echo "opened incident"
fi
exit 1
