#!/usr/bin/env bash
# tools/run-canton-layers.sh — the canton-wide ground-tile build (Phase B), then the tile checks.
# Phase A ran the builder in the foreground on one commune (--area 6640); Phase B launches this script detached on the
# whole canton, via nohup. The builder is resumable (it skips the tiles whose layers are written) and logs its own
# progress and ETA to tools/data/cache/canton_layers.log, so it can simply be re-run after a crash: the build step is
# attempted up to three times, each pass rebuilding only the tiles that failed before. Everything this script prints is
# appended to that same log, and its last line is DONE or FAILED: <step>. A human commits data/canton/ when it says DONE.
#   usage: bash tools/run-canton-layers.sh [--canton]
set -u
cd "$(dirname "$0")/.."

while [ $# -gt 0 ]; do
  case "$1" in
    --canton) shift ;;
    *) echo "usage: $0 [--canton]" >&2; exit 2 ;;
  esac
done

LOG=tools/data/cache/canton_layers.log
STDERR=tools/data/cache/canton_layers.stderr.log
mkdir -p tools/data/cache
mark() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

mark "pipeline start (the whole canton)"
# the builder logs its progress (and its children's output) to $LOG and exits non-zero when a tile exhausted its retries;
# a pass simply resumes, so retrying rebuilds only the missing tiles (a defective source, a dropped request)
for pass in 1 2 3; do
  mark "STEP build (pass $pass)"
  # only the builder's own uncaught errors are worth a separate file, since this script's stdout goes to $LOG too
  if node tools/build-canton-layers.mjs --canton >/dev/null 2>> "$STDERR"; then
    break
  fi
  if [ "$pass" -eq 3 ]; then
    mark "FAILED: build"
    exit 1
  fi
  mark "build pass $pass left tiles unbuilt; retrying (the run resumes)"
  sleep 30
done
mark "STEP test"
if ! npm test >> "$LOG" 2>&1; then
  mark "FAILED: test"
  exit 1
fi
mark "pipeline done"
echo "DONE" >> "$LOG"
