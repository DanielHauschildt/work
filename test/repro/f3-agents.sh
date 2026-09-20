#!/bin/bash
# Finding 3: a lane folder's AGENTS.md / CLAUDE.md is deleted with the user's own text (GENERATED skips the rescue).
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work lane ui >/dev/null 2>&1
mkdir -p "$W/ui"; git -C "$W/app@ui" worktree move "$W/app@ui" "$W/ui/app" >/dev/null
printf '<!-- work:begin -->\ngen\n<!-- work:end -->\nMY LANE NOTES\n' > "$W/ui/AGENTS.md"
echo "@AGENTS.md" > "$W/ui/CLAUDE.md"
work migrate w >/dev/null 2>&1
echo "workspace: $(ls "$W" | tr '\n' ' ')"
FOUND=$(grep -rl "MY LANE NOTES" "$W" 2>/dev/null | head -1)
if [ -n "$FOUND" ]; then verdict "FINDING 3 FIXED (the text survives in ${FOUND#$W/})"
else verdict "FINDING 3 PRESENT (the user's lane AGENTS.md text is gone)"; fi
