# try → work parity matrix

Reference: installed `/opt/homebrew/bin/try` (Cellar 1.0.0, code `VERSION = "1.2.0"`). Every row must be covered by a
test in `test/parity.test.ts` (differential against the installed try where the behaviour is meant to be identical).

| # | try feature | work equivalent | Kind |
|---|---|---|---|
| 1 | `try init [path]` → bash/zsh function; fish variant when `$SHELL` contains fish | `work init [path]` (+ shortcuts, completion) | changed protocol (emit file) |
| 2 | `try` / `try [query]` → selector over `<path>` | `tries [query]` (shortcut) / `work --space tries [query]` | identical |
| 3 | query: whitespace → `-` | same | identical |
| 4 | listing: non-hidden directories only | same | identical |
| 5 | scoring: date bonus, fuzzy, boundary, proximity, density, length penalty, recency | same formula | identical |
| 6 | empty query: all sorted by score; with query: only score > 0 | same | identical |
| 7 | render: header, search line with cursor, separators, rows, meta `time, score`, scroll indicator, footer help | same (+ scope in header when not a single space) | identical layout |
| 8 | date part dimmed, match highlighting | same | identical |
| 9 | "Create new: DATE-query" row only when query non-empty | same (prefix from `--prefix`/space config) | identical |
| 10 | keys ↑ ↓ Ctrl-P Ctrl-N, Enter, Backspace/Ctrl-H, Ctrl-A/E/B/F/K/W, printable `[A-Za-z0-9-_. ]` | same | identical |
| 11 | Ctrl-T create immediately; empty query → prompt "Enter new try name" | same | identical |
| 12 | Ctrl-D toggle mark, delete mode footer, Enter → confirm screen, type `YES` | same (+ git warnings) | identical flow |
| 13 | delete safety: realpath must be inside base | same | identical |
| 14 | delete script: `cd base && rm -rf … && (cd pwd || cd $HOME)` — the restore runs in a subshell, so you end up in the tries folder | binary deletes (git-aware); cwd is kept, or moves to the space folder if it was inside a deleted workspace | deliberate difference |
| 15 | Esc / Ctrl-C: leave delete mode, else cancel → `Cancelled.` exit 1 | same | identical |
| 16 | select → `touch` + `cd` | history record + `cd` | changed (no touch) |
| 17 | create → `mkdir -p` + `cd` | same | identical |
| 18 | `try clone <url> [name]`, `try <url> [name]` → dir `DATE-user-repo` (custom name: no date) | `work clone …` → same dir name, store + `root/<repo>` worktree | changed layout |
| 19 | URL detection `^(https?://|git@)`, contains github.com/gitlab.com, ends `.git` | same | identical |
| 20 | URL parsing github/gitlab/other https/ssh, `.git` stripped | same (+ file paths) | identical |
| 21 | `try . <name>` (bare `.` requires a name), `try ./path [name]` → dated dir, worktree of that repo | same, worktree in `root/<repo>` on a named branch | changed (named branch, lane) |
| 22 | `try worktree dir|<path> [name]` | `work worktree …` | changed like 21 |
| 23 | worktree name versioning: `name` → `name2`/`-2` when today's dir exists | same | identical |
| 24 | non-git dir with `.` → just mkdir + cd | same | identical |
| 25 | `try exec [args]`, `exec cd|clone|worktree` → script on stdout with warning comment | `work exec …` | identical |
| 26 | `--path` anywhere (last wins), `TRY_PATH` env, default `~/src/tries` | `--path`, `WORK_ROOT`, default `~/Work` (root, not a tries folder — so `TRY_PATH` is not read) | changed |
| 27 | `--help`/`-h` anywhere, `--version`/`-v` | same | identical |
| 28 | no args to the binary → help, exit 2 | same | identical |
| 29 | `--no-colors`, `--no-expand-tokens`, `NO_COLOR` | same | identical |
| 30 | `TRY_WIDTH`/`TRY_HEIGHT` | same (+ `WORK_WIDTH/HEIGHT`) | identical |
| 31 | test flags `--and-type`, `--and-exit`, `--and-keys` (token + raw mode), `--and-confirm` | same | identical |
| 32 | non-TTY → `Cancelled.`, exit 1 (its error text is wiped by its own screen clear) | same, plus a visible `Error: work requires an interactive terminal` | improved |
| 33 | SIGWINCH redraw | same | identical |
| 34 | shell quoting `'…'"'"'…'` | same | identical |

## Verified

- `test/parity.test.ts`: differential runs of the installed `try` vs `work` (25 picker key scripts, render and
  `--and-type` screens, help/version/exit codes, non-TTY, clone naming incl. URL shorthand and custom names,
  `.` / `./` / `worktree dir` incl. name versioning and non-repo folders).
- `test/tui/try-parity.test.ts`: screen comparisons against try at several terminal sizes (search line, list
  area, dialogs, frame count; the space-bar header, footer and create-row wording differ on purpose).
- `test/e2e` (`bun run e2e`): real interactive zsh and bash sessions (expect, compiled binary): completion of shortcut
  workspaces, picker select, Ctrl-T create, all-space picker, `try` shortcut, `mv` promotion following the cwd,
  `work -`, creating a space from the `+ new` tab.

Quirks of try kept on purpose: `--and-keys TYPE=` upper-cases the typed text; blank lines vanish in forced-colour
non-TTY output.

Checked against a copy of the real `~/Work/tries` (compiled binary): legacy workspaces (plain repo at the workspace root, or
nested plain repos) are listed, resolved and rendered like try. Picker delete shows git warnings (uncommitted,
local-only commits) on the `YES` screen and then deletes, as in try; `work rm` on the command line refuses such
workspaces unless `--force`.
