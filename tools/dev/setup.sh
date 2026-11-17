#!/usr/bin/env bash
# Sets up what a working session on this repository needs, in one command:
#   bash tools/dev/setup.sh && source .tools/env.sh
# Everything goes inside the repository (the ignored .tools/ folder) or in each tool's own default
# place, never in a temporary folder that the machine may clean mid-session. Safe to run again.
#
#   uv          pinned, in .tools/uv (skipped when that version is already on PATH)
#   Python      the locked environment, every extra and group (.venv/)
#   npm         web/ and worker/, from their lockfiles
#   Playwright  the Chromium the end-to-end tests use, in Playwright's default folder
#   merge-pr    tools/dev/merge-pr.sh, on PATH once env.sh is sourced
set -euo pipefail

UV_VERSION=0.13.9
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
TOOLS="$ROOT/.tools"
mkdir -p "$TOOLS"
step() { printf '\n== %s\n' "$1"; }

step "Node"
command -v node >/dev/null || { echo "Node is not on PATH: install the version web/package.json asks for (engines.node)." >&2; exit 1; }
node -e '
  const want = require("./web/package.json").engines.node.replace(/^[^0-9]*/, "").split(".").map(Number);
  const have = process.versions.node.split(".").map(Number);
  const older = want.some((w, i) => have.slice(0, i).every((h, j) => h === want[j]) && have[i] < w);
  if (older) { console.error(`Node ${process.versions.node} is older than ${want.join(".")}`); process.exit(1); }
  console.log(`Node ${process.versions.node}`);
'

step "uv $UV_VERSION"
if [ "$(uv --version 2>/dev/null | cut -d' ' -f2)" = "$UV_VERSION" ]; then
  echo "already on PATH: $(command -v uv)"
  UV_BIN=""
else
  # the first Python that runs and is 3.12 or later (on Windows, python3 may be the Store's stand-in)
  PY=""
  for c in python3 python py; do
    if "$c" -c 'import sys; sys.exit(sys.version_info < (3, 12))' >/dev/null 2>&1; then PY=$c; break; fi
  done
  [ -n "$PY" ] || { echo "Python 3.12 or later is needed to install uv." >&2; exit 1; }
  [ -d "$TOOLS/uv" ] || "$PY" -m venv "$TOOLS/uv"
  UV_BIN="$TOOLS/uv/bin"; [ -d "$UV_BIN" ] || UV_BIN="$TOOLS/uv/Scripts"
  "$UV_BIN/python" -m pip install --quiet --disable-pip-version-check "uv==$UV_VERSION"
  "$UV_BIN/uv" --version
fi

# what a shell needs: the pinned uv and the merge helper
{
  echo "# written by tools/dev/setup.sh"
  echo "export PATH=\"${UV_BIN:+$UV_BIN:}$ROOT/tools/dev:\$PATH\""
} > "$TOOLS/env.sh"
# shellcheck source=/dev/null
source "$TOOLS/env.sh"

step "Python environment"
uv sync --all-extras --all-groups --frozen

step "npm packages"
(cd web && npm ci --no-audit --no-fund --loglevel=error)
(cd worker && npm ci --no-audit --no-fund --loglevel=error)

step "Playwright browser"
(cd web && npx playwright install chromium)

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    echo
    echo "Windows: the Worker's tests run on workerd, which needs the Microsoft Visual C++ redistributable;"
    echo "without it, run them in CI." ;;
esac
printf '\nDone. In each new shell: source .tools/env.sh\n'
