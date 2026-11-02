#!/usr/bin/env bash
# Execute every notebook in this folder into _build/, four at a time (#446).
#
#   bash notebooks/run.sh [timeout seconds per cell, default 600]
#
# CI runs it against the sample and the publish against the staged build (FS_NOTEBOOK_SOURCE says
# which). Kernels started at the same moment can race for a local port ("Address already in use",
# then "Kernel died before replying to kernel_info"), so a notebook whose run fails is tried again,
# twice, after a short pause, with a warning that names it (#591). A notebook that fails all three
# times fails the run.
set -euo pipefail
cd "$(dirname "$0")"
timeout="${1:-600}"
mkdir -p _build

run_one() {
  local notebook=$1 timeout=$2 attempt
  for attempt in 1 2 3; do
    if uv run jupyter nbconvert --to html --execute --output-dir _build \
      --ExecutePreprocessor.timeout="$timeout" "$notebook"; then
      return 0
    fi
    echo "::warning::$notebook failed on attempt $attempt of 3"
    sleep $((attempt * 5))
  done
  return 1
}
export -f run_one

printf '%s\0' *.ipynb | xargs -0 -I{} -P 4 bash -c 'run_one "$1" "$2"' _ {} "$timeout"
