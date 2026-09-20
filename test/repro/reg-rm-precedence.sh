#!/bin/bash
# Regression: `work rm ./<name>` removes the worktree folder of that name first, the lane of that name after.
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app); UI=$(remote ui)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work add "$UI" >/dev/null 2>&1      # folder <w>/ui
CWD=$W/app work lane ui >/dev/null 2>&1        # lane ui → app@ui, ui@ui
echo "before: $(ls "$W" | tr '\n' ' ')"
CWD=$W work rm ./ui --yes >/dev/null 2>&1; echo "after rm ./ui (folder): $(ls "$W" | tr '\n' ' ')"
if [ -e "$W/ui" ] || [ ! -e "$W/app@ui" ]; then verdict "RM PRECEDENCE PRESENT (the folder was not what went first)"; fi
CWD=$W work rm ./ui --yes >/dev/null 2>&1; echo "after rm ./ui (lane):   $(ls "$W" | tr '\n' ' ')  lanes: $(lanes_of "$W")"
if [ -e "$W/app@ui" ] || lanes_of "$W" | grep -q '"ui"'; then verdict "RM PRECEDENCE PRESENT (the lane did not go second)"; fi
verdict "RM PRECEDENCE FIXED (the folder first, then the lane of that name)"
