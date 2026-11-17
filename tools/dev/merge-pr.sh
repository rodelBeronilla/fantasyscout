#!/usr/bin/env bash
# Merges a pull request once every check has passed, then resets `preprod` to `main` so the next
# preview starts clean. Which pull requests may be merged without the owner is the merge rule in
# .sdlc/state.md; this script does not decide that.
#
#   merge-pr.sh <pr>                  wait for the checks, squash-merge, reset preprod
#   merge-pr.sh <pr> --keep-preprod   the same, but leave preprod alone (a preview is being looked at)
set -uo pipefail

PR=${1:?usage: merge-pr.sh <pr> [--keep-preprod]}
KEEP=${2:-}
cd "$(dirname "$0")/../.." || exit 1

states() { gh pr checks "$PR" 2>/dev/null | cut -f2; }
sleep 60 # let the checks register
for _ in $(seq 1 80); do
  out=$(states)
  [ -n "$out" ] && ! grep -qE 'pending|queued' <<< "$out" && break
  sleep 30
done
gh pr checks "$PR" | cut -f1,2 | tr '\t' ' '

out=$(states)
if [ -z "$out" ] || grep -qvE '^(pass|skipping)$' <<< "$out"; then
  gh pr view "$PR" --json state,mergeable -q '"\(.state) \(.mergeable)"'
  echo "NOT MERGED: a check did not pass" >&2
  exit 1
fi

gh pr merge "$PR" --squash --admin --delete-branch 2>&1 | tail -1
[ "$(gh pr view "$PR" --json state -q .state)" = MERGED ] || { echo "NOT MERGED" >&2; exit 1; }
echo "MERGED"
if [ "$KEEP" != --keep-preprod ]; then
  git fetch -q origin main preprod
  git push -q --force-with-lease=preprod:origin/preprod origin origin/main:preprod && echo "preprod reset to main"
fi
