#!/bin/bash
# Finding 4: when `work lane` fails on the second repo, the lane record stays and blocks the retry.
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app); TWO=$(remote two)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work add "$TWO" >/dev/null 2>&1
STORE=$(find "$ROOT/.repos" -maxdepth 5 -type d -name two.git | head -1)
mv "$STORE" "$STORE.gone"                    # break the 2nd repo's store so its worktree add fails
FIRST=$(CWD=$W work lane x 2>&1 | tail -1); echo "work lane x  → $FIRST"
echo "model: $(lanes_of "$W")"
AGAIN=$(CWD=$W work lane x 2>&1 | tail -1); echo "retry        → $AGAIN"
# per the lead's decision the partial lane is kept on purpose, so judge the message, not the exit code:
# both the first failure and the retry must name how to complete or drop the lane
if echo "$FIRST$AGAIN" | grep -q "work add" && echo "$AGAIN" | grep -q "work rm ./x"; then
  verdict "FINDING 4 FIXED (lane kept on purpose; both messages name the way out)"
else verdict "FINDING 4 PRESENT (the retry does not say how to complete or drop the lane)"; fi
