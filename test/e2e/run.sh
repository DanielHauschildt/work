#!/bin/sh
# Real interactive zsh and bash sessions (expect) against the compiled binary: completion, picker, cd, mv, back,
# + new space. Not part of `bun test`; run `bun run e2e` (builds dist/work first). Needs expect, zsh and bash.
set -u
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN="$REPO/dist/work"
[ -x "$BIN" ] || { echo "missing $BIN; run bun run build" >&2; exit 1; }
command -v expect >/dev/null || { echo "expect not found" >&2; exit 1; }

S=$(mktemp -d /tmp/work-e2e.XXXXXX)
export S
trap 'rm -rf "$S"' EXIT
unset WORK_EMIT WORK_ROOT WORK_SHELL WORK_QUIET NO_COLOR

init="eval \"\$('$BIN' init '$S/Work' --shortcut tries --shortcut labs --shortcut try=tries)\""
mkdir -p "$S/zdot"
cat >"$S/zdot/.zshrc" <<EOF
PS1='%~ %# '
autoload -Uz compinit && compinit -i -d '$S/zdot/.zcompdump'
$init
EOF
cat >"$S/bashrc" <<EOF
PS1='\w \$ '
$init
EOF

status=0
for driver in drive.exp drive-bash.exp; do
  rm -rf "$S/Work" "$S/seed-app"
  mkdir -p "$S/Work/tries/2026-09-01-redis-server" "$S/Work/tries/2026-09-02-kafka" "$S/Work/labs/IMG-1-autofit"
  # a local repo for the lane step; fresh per run, since its worktrees go with $S/Work
  git init -q "$S/seed-app"
  : >"$S/seed-app/README.md"
  git -C "$S/seed-app" add README.md
  git -C "$S/seed-app" -c user.email=e2e@example.com -c user.name=e2e commit -q -m init
  echo "== $driver"
  expect "$REPO/test/e2e/$driver" | tee "$S/out.txt"
  want=$(grep -c 'send_user "OK' "$REPO/test/e2e/$driver")
  got=$(grep -c '^OK' "$S/out.txt")
  if [ "$got" -ne "$want" ] || grep -q '^FAIL' "$S/out.txt"; then
    echo "!! $driver: $got/$want OK" >&2
    status=1
  fi
done
exit $status
