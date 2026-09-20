#!/bin/bash
# Finding 4, other half: when NOTHING could be created, the lane record must be rolled back so the retry works.
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app); TWO=$(remote two)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work add "$TWO" >/dev/null 2>&1
STORE=$(find "$ROOT/.repos" -maxdepth 5 -type d -name app.git | head -1)
mv "$STORE" "$STORE.gone"                             # the FIRST repo of the new lane fails
echo "work lane x → $(CWD=$W work lane x 2>&1 | tail -1)"
AFTER=$(lanes_of "$W"); echo "model:        $AFTER"
rm -rf "$STORE"; mv "$STORE.gone" "$STORE"            # repair (the failed run left an empty store behind)
echo "retry       → $(CWD=$W work lane x 2>&1 | tail -1)"
echo "model:        $(lanes_of "$W")"
if echo "$AFTER" | grep -q '"x"'; then verdict "FINDING 4 (rollback) PRESENT: the empty lane x stayed behind"
else verdict "FINDING 4 (rollback) FIXED: nothing was created, no lane record left"; fi
