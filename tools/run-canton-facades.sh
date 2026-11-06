#!/usr/bin/env bash
# tools/run-canton-facades.sh — the resumable canton facade pipeline. Runs every step in order, each one skipping the
# work already done, so the script can be re-run after any crash (it resumes the long photomesh step). Everything it and
# the tools print is appended to tools/data/cache/canton_facades.log, and the last line of that log is DONE or
# FAILED: <step>. Phase A runs it in the foreground on one commune (--area 6640); Phase B launches it detached on the
# whole canton (no --area), via nohup, and a human commits data/geneva-canton-facades.json when the log says DONE.
#   usage: bash tools/run-canton-facades.sh [--area 6640]
set -u
cd "$(dirname "$0")/.."

AREA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --area) AREA=(--area "$2"); shift 2 ;;
    *) echo "usage: $0 [--area <BFS>]" >&2; exit 2 ;;
  esac
done

LOG=tools/data/cache/canton_facades.log
mkdir -p tools/data/cache
mark() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

step() {
  local name="$1"; shift
  mark "STEP $name"
  if ! "$@" >> "$LOG" 2>&1; then
    mark "FAILED: $name"
    exit 1
  fi
}

# macOS's bash 3.2 treats an empty array as unbound under `set -u`, so the whole-canton run (no --area) must guard
# every expansion of AREA: `${AREA[@]+"${AREA[@]}"}` is nothing when it is empty, the two words otherwise.
mark "pipeline start (area: ${AREA[*]:-the whole canton})"
step footprints  node tools/fetch-canton-footprints.mjs ${AREA[@]+"${AREA[@]}"}
step batches     node tools/build-geneva-canton-facades.mjs --batches ${AREA[@]+"${AREA[@]}"}
step gwr         bash -c '[ -f tools/data/cache/gwr/gebaeude_batiment_edificio.csv ] || npm run data:gwr'
step facades0    node tools/build-geneva-canton-facades.mjs --facades ${AREA[@]+"${AREA[@]}"}
step samples     node tools/sample-photomesh-facades.mjs --canton ${AREA[@]+"${AREA[@]}"}
step facades     node tools/build-geneva-canton-facades.mjs --facades ${AREA[@]+"${AREA[@]}"}
step test        npm test
mark "pipeline done"
echo "DONE" >> "$LOG"
