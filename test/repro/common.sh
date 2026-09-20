# Shared setup for the repro scripts: a throwaway sandbox and a `work` runner.
# Sourced, not run: `. "$(dirname "$0")/common.sh" "$@"`.
# The optional argument is the checkout to test; it defaults to this repo.
set -u
WORK_SRC=${WORK_SRC:-${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}}
[ -f "$WORK_SRC/src/cli.ts" ] || { echo "not a work checkout: $WORK_SRC" >&2; exit 2; }
export GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@e
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 WORK_QUIET=
unset WORK_EMIT WORK_ROOT WORK_SHELL 2>/dev/null || true
SB=$(mktemp -d /tmp/work-repro.XXXXXX)
ROOT=$SB/Work; REMOTES=$SB/remotes; mkdir -p "$ROOT" "$REMOTES"
KEEP=${KEEP_SANDBOX:-0}
trap '[ "$KEEP" = 1 ] || rm -rf "$SB"' EXIT

# fixture <cmd...> — a setup step that must not fail silently (exit 2 = broken fixture, not a finding)
fixture() { "$@" || { echo "!! fixture step failed: $*" >&2; exit 2; }; }

# work <args...>  — runs in $CWD (default $SB)
work() { (cd "${CWD:-$SB}" && bun "$WORK_SRC/src/cli.ts" --path "$ROOT" "$@"); }

# remote <name> [subdir] — bare repo with one commit, optionally containing <subdir>/
remote() {
  local n=$1 sub=${2:-}
  fixture git init -q --bare -b main "$REMOTES/$n.git"
  fixture git clone -q "$REMOTES/$n.git" "$SB/seed-$n" 2>/dev/null
  if [ -n "$sub" ]; then mkdir -p "$SB/seed-$n/$sub"; echo x > "$SB/seed-$n/$sub/f.txt"; else echo x > "$SB/seed-$n/f.txt"; fi
  fixture git -C "$SB/seed-$n" add .
  fixture git -C "$SB/seed-$n" commit -qm init
  fixture git -C "$SB/seed-$n" push -q origin HEAD:main
  fixture git -C "$REMOTES/$n.git" symbolic-ref HEAD refs/heads/main
  echo "$REMOTES/$n.git"
}

# lanes_of <workspace> — repos per lane from .work.json
lanes_of() { bun -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(Object.fromEntries(Object.entries(m.lanes).map(([k,v])=>[k,Object.keys(v.repos)]))))' "$1/.work.json"; }

# verdict "<TEXT>" — ends the script; PRESENT means the bug is there (exit 1, sandbox kept for inspection)
verdict() {
  local status=0
  case $1 in *PRESENT*) status=1; KEEP=1 ;; esac
  echo
  echo "VERDICT: $1"
  [ "$KEEP" = 1 ] && echo "sandbox: $SB"
  exit $status
}
