#!/bin/bash
# Finding 5: when a git command fails, the message must name the command with its paths, not "git worktree add …".
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
STORE=$(find "$ROOT/.repos" -maxdepth 5 -type d -name app.git | head -1)
rm -rf "$STORE/objects"                               # any git command in the store now fails
ERR=$(CWD=$W work lane y 2>&1 | tr '\n' ' ')
echo "error: $ERR"
# the realpath may differ (/tmp vs /private/tmp), the command tail does not: the truncated form had no "fetch"
if echo "$ERR" | grep -q "app.git fetch"; then verdict "FINDING 5 FIXED (the failing command and its paths are in the message)"
else verdict "FINDING 5 PRESENT (the message does not say which command and path failed)"; fi
