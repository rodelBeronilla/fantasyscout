#!/usr/bin/env bash
# The narrower Databricks token for the ingest (docs/runbook.md, "A narrower token for the ingest"),
# done end to end from the owner's machine: find the service principal, grant it the landing volume
# and nothing else, mint it a 90-day token, and put that token straight into the GitHub Actions
# environment secret DATABRICKS_INGEST_TOKEN. The token is never printed or written to disk.
#
#   bash infra/databricks/ingest-token.sh
#
# Asks for the workspace URL and the owner's own personal access token (typed hidden). Needs curl,
# python and gh signed in as the repository owner. Run it again to rotate the token.
set -euo pipefail

REPO="${INGEST_TOKEN_REPO:-rodelBeronilla/fantasyscout}"
PRINCIPAL="${INGEST_PRINCIPAL:-fantasyscout-ingest}"
LIFETIME="${INGEST_TOKEN_LIFETIME:-7776000}" # 90 days
GH_ENV="${INGEST_TOKEN_ENV:-lakehouse}"

read -rp "Workspace URL (https://....cloud.databricks.com): " HOST
HOST="${HOST%/}"
read -rsp "Your Databricks personal access token (hidden): " PAT
echo
api() { curl -sS -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" "$@"; }
json() { python -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# 1. The service principal, by display name -> application id (Unity Catalog names it by the id).
app=$(api "$HOST/api/2.0/preview/scim/v2/ServicePrincipals?filter=displayName%20eq%20%22$PRINCIPAL%22" \
  | json '(d.get("Resources") or [{}])[0].get("applicationId","")')
[ -n "$app" ] || { echo "no service principal named $PRINCIPAL in this workspace"; exit 1; }
echo "service principal $PRINCIPAL: application id $app"

# 2. The grants, through the SQL warehouse (idempotent; a repeat grant is a no-op).
warehouse=$(api "$HOST/api/2.0/sql/warehouses" | json 'sorted(d["warehouses"], key=lambda w: w.get("creation_time", 0))[0]["id"]')
sql() {
  local body
  body=$(api -X POST "$HOST/api/2.0/sql/statements" -d "{\"warehouse_id\":\"$warehouse\",\"catalog\":\"fantasyscout\",\"statement\":$(printf '%s' "$1" | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),\"wait_timeout\":\"50s\"}")
  local state
  state=$(printf '%s' "$body" | json 'd.get("status",{}).get("state","")')
  if [ "$state" != "SUCCEEDED" ]; then
    echo "statement failed ($state): $(printf '%s' "$body" | json 'd.get("status",{}).get("error",{}).get("message", d)[:300]')"
    exit 1
  fi
  printf '%s' "$body"
}
sql "GRANT USE CATALOG ON CATALOG fantasyscout TO \`$app\`" >/dev/null
sql "GRANT USE SCHEMA ON SCHEMA fantasyscout.raw TO \`$app\`" >/dev/null
sql "GRANT READ VOLUME, WRITE VOLUME ON VOLUME fantasyscout.raw.landing TO \`$app\`" >/dev/null
echo "grants on the landing volume: $(sql "SHOW GRANTS \`$app\` ON VOLUME fantasyscout.raw.landing" | json '", ".join(r[1] for r in d.get("result",{}).get("data_array",[]))')"

# 3. A token on behalf of the principal; its value goes to GitHub and nowhere else.
token=$(api -X POST "$HOST/api/2.0/token-management/on-behalf-of/tokens" \
  -d "{\"application_id\":\"$app\",\"lifetime_seconds\":$LIFETIME,\"comment\":\"fantasyscout ingest and backfill\"}" \
  | json 'd.get("token_value","") or ("ERROR " + json.dumps(d)[:300])')
case "$token" in ERROR*) echo "token request failed: ${token#ERROR }"; exit 1 ;; esac
printf '%s' "$token" | gh secret set DATABRICKS_INGEST_TOKEN --env "$GH_ENV" --repo "$REPO"
unset token PAT
echo "DATABRICKS_INGEST_TOKEN set in the $GH_ENV environment; it expires in $((LIFETIME / 86400)) days"

# 4. Prove it: an ingest run whose Land step uses the new token.
gh workflow run ingest.yml --repo "$REPO" -f league=both
echo "Ingest started; watch its Land step: gh run watch --repo $REPO"
