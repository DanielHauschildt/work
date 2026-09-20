#!/bin/bash
# Finding 2: `work migrate` must hold the workspace lock across its moves AND the model write, so a concurrent
# writer cannot slip in between and have its .work.json change overwritten.
# Setup: migrate is made slow by holding the store lock of the second repo for a few seconds; a `work rm` of the
# first repo runs in that window. Correct behaviour: rm waits for migrate, then its removal survives.
. "$(dirname "$0")/common.sh" "$@"
APP=$(remote app); TWO=$(remote two)
work clone "$APP" w >/dev/null 2>&1
W=$ROOT/tries/w
CWD=$W/app work add "$TWO" >/dev/null 2>&1
mkdir -p "$W/root"                                    # put both worktrees back into the old layout
git -C "$W/app" worktree move "$W/app" "$W/root/app" >/dev/null
git -C "$W/two" worktree move "$W/two" "$W/root/two" >/dev/null
STORE=$(git -C "$W/root/two" rev-parse --git-common-dir)
KEY=$(bun -e 'const {createHash}=require("crypto");console.log(createHash("sha1").update(process.argv[1]).digest("hex").slice(0,16))' "$STORE")
mkdir -p "$ROOT/.work/locks"
sleep 30 & LOCKER=$!
echo "{\"pid\":$LOCKER,\"t\":$(date +%s000)}" > "$ROOT/.work/locks/$KEY.lock"   # migrate blocks on the 2nd move
( work migrate w >$SB/migrate.log 2>&1; echo "exit=$?" >>$SB/migrate.log ) & MIG=$!
( sleep 6; rm -f "$ROOT/.work/locks/$KEY.lock"; kill $LOCKER 2>/dev/null ) &   # let migrate finish mid-run
sleep 2
work rm w/root/app --yes --force >$SB/rm.log 2>&1; RM=$?     # runs while migrate is working
wait $MIG 2>/dev/null
echo "migrate: $(tail -1 $SB/migrate.log)   rm exit=$RM: $(tail -1 $SB/rm.log)"
echo "model:   $(lanes_of "$W")"
echo "folders: $(ls "$W" | tr '\n' ' ')"
MODEL_HAS_APP=$(lanes_of "$W" | grep -c '"app"')
if [ -e "$W/app" ] || [ -e "$W/root/app" ]; then DISK_HAS_APP=1; else DISK_HAS_APP=0; fi
if [ "$MODEL_HAS_APP" = "$DISK_HAS_APP" ]; then
  verdict "FINDING 2 FIXED (.work.json and the folders agree: app in model=$MODEL_HAS_APP, on disk=$DISK_HAS_APP)"
else verdict "FINDING 2 PRESENT (model says app=$MODEL_HAS_APP, disk says $DISK_HAS_APP → a write was lost)"; fi
