#!/bin/bash
# Run every repro/regression script against a checkout (default: this repo) and fail if any bug is still there.
# Usage: bun run repro   |   test/repro/run-all.sh [path-to-a-work-checkout]
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$(cd "$DIR/../.." && pwd)}
status=0
for script in "$DIR"/f*.sh "$DIR"/reg-*.sh; do
  name=$(basename "$script")
  out=$("$script" "$SRC" 2>&1)
  code=$?
  line=$(printf '%s\n' "$out" | grep "^VERDICT: " | tail -1)
  if [ -z "$line" ]; then
    printf '%-24s NO VERDICT (exit %s)\n' "$name" "$code"
    printf '%s\n' "$out"
    status=1
  elif [ "$code" != 0 ] || printf '%s\n' "$line" | grep -q PRESENT; then
    printf '%-24s %s\n' "$name" "${line#VERDICT: }"
    printf '%s\n' "$out"
    status=1
  else
    printf '%-24s %s\n' "$name" "${line#VERDICT: }"
  fi
done
exit $status
