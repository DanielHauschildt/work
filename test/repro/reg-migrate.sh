#!/bin/bash
# Regression: an old `<lane>/<repo>` layout is refused by writing commands and converted by `work migrate`.
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work lane ui >/dev/null 2>&1
mkdir -p "$W/ui"; git -C "$W/app@ui" worktree move "$W/app@ui" "$W/ui/app" >/dev/null
echo "legacy: $(ls "$W" | tr '\n' ' ')"
REFUSED=$(CWD=$W/app work add "$APP" --lane ui 2>&1 | tail -1); echo "add refused: $(echo "$REFUSED" | cut -c1-70)"
work migrate w 2>&1 | tail -1
echo "after: $(ls "$W" | tr '\n' ' ')"
if ! echo "$REFUSED" | grep -q "work migrate"; then verdict "MIGRATE REGRESSION PRESENT (the refusal does not name the command)"
elif [ ! -e "$W/app@ui" ] || [ -e "$W/ui" ]; then verdict "MIGRATE REGRESSION PRESENT (the layout was not converted)"
else verdict "MIGRATE REGRESSION FIXED (refused with the command to run, then converted)"; fi
