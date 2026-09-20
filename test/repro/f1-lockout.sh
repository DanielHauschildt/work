#!/bin/bash
# Finding 1: a repo named like a lane, whose tree holds a folder named like another repo of that lane,
# makes legacyLanes() see a legacy layout that migrate does not → every writing command is refused forever.
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app); UI=$(remote ui app)       # repo "ui" contains a top-level app/ directory
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work add "$UI" >/dev/null 2>&1    # folder <w>/ui
CWD=$W/app work lane ui >/dev/null 2>&1      # lane "ui" → app@ui, ui@ui
echo "folders: $(ls "$W" | tr '\n' ' ')"
ADD=$(CWD=$W/app work add "$APP" --lane ui 2>&1 | tail -1); echo "work add   → $ADD"
MIG=$(work migrate w --force 2>&1 | tail -1); echo "work migrate --force → $MIG"
if echo "$ADD" | grep -q "still uses lane folders" && echo "$MIG" | grep -q "Nothing to migrate"; then
  verdict "FINDING 1 PRESENT (writing commands refuse, migrate has nothing to do)"
else verdict "FINDING 1 FIXED"; fi
