#!/bin/bash
# Finding 6: Ctrl-D in the worktree view removes the highlighted worktree; the lane goes only with the last one.
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app); TWO=$(remote two)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work add "$TWO" >/dev/null 2>&1
CWD=$W/app work lane ui >/dev/null 2>&1
echo "before: $(ls "$W" | tr '\n' ' ')  model: $(lanes_of "$W")"
CWD=$W work --and-keys $'\x1b[C' 2>&1 | grep -o "\^D Remove[a-z ]*" | head -1
# rows: app, two, app@ui, two@ui — the third one is the first worktree of lane ui
CWD=$W work --and-keys $'\x1b[C\x1b[B\x1b[B\x04YES\r' >/dev/null 2>&1
AFTER1=$(lanes_of "$W"); echo "after 1st Ctrl-D: $(ls "$W" | tr '\n' ' ')  model: $AFTER1"
CWD=$W work --and-keys $'\x1b[C\x1b[B\x1b[B\x04YES\r' >/dev/null 2>&1   # now the last worktree of lane ui
AFTER2=$(lanes_of "$W"); echo "after 2nd Ctrl-D: $(ls "$W" | tr '\n' ' ')  model: $AFTER2"
if [ -e "$W/app@ui" ] || ! echo "$AFTER1" | grep -q '"ui"'; then
  verdict "FINDING 6 PRESENT (the first Ctrl-D did not remove exactly one worktree: $AFTER1)"
elif [ -e "$W/two@ui" ] || echo "$AFTER2" | grep -q '"ui"'; then
  verdict "FINDING 6 PRESENT (the lane did not go with its last worktree: $AFTER2)"
else verdict "FINDING 6 FIXED (one worktree per Ctrl-D; the lane goes with its last one)"; fi
