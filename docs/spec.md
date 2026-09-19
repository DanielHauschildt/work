# `work` — design spec

`work` replaces [`try`](https://github.com/tobi/try) (installed v1.2.0 at `/opt/homebrew/bin/try`) and extends it
from ephemeral dated folders to workspaces with parallel, stacked feature lanes across multiple repos.
Bun + TypeScript, compiled to a single binary (`bun build --compile`).

## Vocabulary

| Term | Meaning | Example |
|---|---|---|
| root | base folder, configurable (`work init <path>`, `--path`, `WORK_ROOT`, default `~/Work`) | `~/Work` |
| space | any non-hidden folder in root | `tries`, `labs`, `clients` |
| workspace | a folder in a space (try's "try") | `labs/IMG-1234-autofit` |
| lane | a feature inside a workspace: one branch, one agent | `labs/IMG-1234-autofit/ui` |
| worktree | one repo inside a lane, as a git worktree of its store | `labs/IMG-1234-autofit/ui/cesdk-web` |
| store | shared bare clone backing all worktrees of a repo | `~/Work/.repos/github.com/imgly/cesdk-web.git` |

Hidden folders (`.repos`, `.work`, `.archive`) are never spaces/workspaces.

## Layout & naming

```
<root>/
├── .repos/<host>/<owner>/<repo>.git   bare stores
├── .work/history.jsonl                visit history (recency, `work -`)
├── .work/locks/                       lock files
├── tries/
│   ├── .space.toml                    optional space config
│   ├── .archive/<workspace>/              archived workspaces
│   └── 2026-09-19-redis-bench/
│       ├── .work.json                 lanes, parents, bases, PRs (only once a repo was added)
│       ├── AGENTS.md, CLAUDE.md       generated (phase 2)
│       └── root/redis/                lane "root", worktree of redis, branch `redis-bench`
└── labs/IMG-1234-autofit/
    ├── root/cesdk-web/                branch IMG-1234-autofit        on origin/main
    ├── ui/cesdk-web/                  branch IMG-1234-autofit-ui     on root
    └── guide/docs/                    branch IMG-1234-autofit-guide  on root (docs not in root → on origin/main)
```

- Workspace name = `<prefix>-<name>`; prefix `auto` = today `YYYY-MM-DD`, `""` = none, else literal (`IMG-1234`).
  Whitespace in names → `-`.
- New space names are normalized the same way (trimmed, whitespace → `-`, case kept) in the picker (`+ new`,
  `space/rest`), `work space new`, `--space` and `mv` targets, then must match `[A-Za-z0-9][A-Za-z0-9._-]*`;
  an existing folder is used as typed.
- Branch = workspace name without a leading date prefix; lane `root` uses it as is, other lanes append `-<lane>`.
  (`-` not `/`: git can't hold `x` and `x/ui` at once.)
- Workspaces without `.work.json` are plain folders (all existing tries). A `.git` at a workspace root (legacy
  `try clone`) is left alone; the workspace is still listed and cd-able.
- Lanes are always folders; the first lane defaults to `root`.

## Shell integration

`work init [path] [--shortcut NAME[=SPACE]]...` prints a wrapper for the current shell (`$SHELL`, fish or
bash/zsh) plus completion wiring. Example `.zshrc` line:

```zsh
eval "$(work init ~/Work --shortcut tries --shortcut labs --shortcut try=tries)"
```

Wrapper protocol (differs from try on purpose): the wrapper creates a temp file, exports `WORK_EMIT=<file>` and
`WORK_SHELL=<zsh|bash|fish>`, runs the binary with `--path <root>`, then sources the file if non-empty. The binary
writes only shell commands that must run in the caller (`cd`) into that file; normal output goes to stdout, UI to
stderr. So `work ls --json | jq` works through the wrapper, and a direct binary call (agents) prints the target
path on stdout for cd-type commands instead of emitting a script.

`try` compat: `work exec [args]` prints the script to stdout (try's manual mode, same warning comment line).

Completion: `work __complete --cmd <name> -- <words...>` prints candidates (`value\tdescription`), one per line,
for the last (possibly empty) word. `init` registers it for `work` and every shortcut (zsh `compdef`, bash
`complete -F`, fish `complete -c`).

## Commands

```
work [--space S] [query]         picker (all spaces, or S); with --prefix/name creation goes to S (default tries)
work new [--space S] [--prefix P] <name>    create without picker (agents), prints path / emits cd
work - | back                    cd to previous workspace (history)
work . <name> | ./path [name]    new workspace; if the path is a git repo, a worktree of it in lane root
work clone <url> [name] | <url>  new workspace `<prefix>-<owner>-<repo>`; store + worktree in lane root
work path <query> [lane]         print absolute path of the unique best match (exit 1 if none/ambiguous)
work ls [--space S] [--json] [--stale]
work space [ls | new <name> [--prefix P] | set <name> --prefix P]
work info [workspace] [--json]   lanes, repos, branches, dirty/unpushed, parents, PRs
work add <repo|url|path> [branch] [--lane L]   add worktree to lane (default: current lane, else root)
work lane <name> [repos...] [--on PARENT]      create lane (phase 2)
work mv <workspace> <space>[/<name>] [--prefix P]  move/rename/promote; repairs worktrees; cd follows if inside
work archive [workspace] | unarchive <workspace>
work rm [workspace | workspace/lane | workspace/lane/repo] [--yes] [--force]
work sync [--continue | --abort]  restack lanes (phase 3)
work submit [--draft]             push + PRs per lane worktree (phase 3)
work init | exec | __complete | --help | --version
```

Global flags anywhere: `--path`, `--space`, `--prefix`, `--json`, `--yes`, `--no-colors`, `--no-expand-tokens`;
env `NO_COLOR`, `WORK_ROOT`, `WORK_WIDTH/HEIGHT` (also `TRY_WIDTH/HEIGHT`). `TRY_PATH` is ignored (it names a tries
folder, not a root). try's test flags `--and-type/--and-exit/--and-keys/--and-confirm`.

Resolution of `work [query]`: picker filtered by query (try semantics — it never auto-jumps). `path`/`new` are the
non-interactive forms. Non-TTY picker → error `work requires an interactive terminal` (exit 1), like try.

## Picker (port of try's TrySelector)

Port 1:1: token UI printer with double buffering on stderr, fuzzy scoring (date-prefix bonus, boundary,
proximity, density, length penalty, recency bonus), "Create new" row, keys ↑/↓/Ctrl-P/N, Enter, Backspace/Ctrl-H,
Ctrl-A/E/B/F/K/W, Ctrl-T create, Ctrl-D mark + Enter → type `YES`, Esc/Ctrl-C, SIGWINCH redraw, scroll indicator,
relative time + score column, `📁`/`🗑️` icons, date part dimmed.

Extensions: header is a space bar (`all  tries  labs  + new`, active one highlighted); Tab / Shift-Tab cycle
all → each space → `+ new` (name → choose date/no-date default → space created, picker switches to it); compact
footer that fits 80 columns. Start tab: `--space` (shortcuts), else the space the cwd is in, else all; with an empty
query the cursor starts on the workspace the cwd is in. Create rows: in a space tab two rows, the space's default
prefix first (Ctrl-T), the other variant (date ↔ no date) second; in all-scope one row per existing space with its
default prefix, the default space first (Ctrl-T), then the others alphabetically (the blank line before the create
rows is dropped while the list scrolls, so a full frame never exceeds the terminal height). Query `space/rest`
filters that space and creates there; an unknown space is created after asking its default prefix (written to
`.space.toml`). Rows show `space/` prefix in all-scope; badges (lane count, repo names, `*` dirty — dirty computed
asynchronously and redrawn, `stale` when older than the space's `cleanup_days`); Ctrl-R rename/move (prompt
`space/name`). Recency = last visit from history, else mtime.

Lane view (try ignores ←/→, so try parity holds): → on a workspace with lanes shows them (parents first) under a
breadcrumb `📁 work › space › workspace`: name, branch, `on <parent|main>`, repos, async `*` dirty; typing filters
them. Enter cds into the lane (history records the workspace). A valid new name (`^[A-Za-z0-9][A-Za-z0-9._-]*$`,
whitespace → `-`) adds `📂 New lane on <lane>: <name>` on the last highlighted lane; Enter / Ctrl-T returns it and the
CLI runs `createLane` (inherits the parent's repos) after the picker closed, then cds into it. Ctrl-D on a lane: YES
screen with `removalWarnings(lane path)`, then the CLI runs `removeLane`. ← returns to the list with the query
restored and the cursor on the workspace; Esc cancels the picker. → on a workspace without lanes shows
`no lanes — work add <repo>`.

## Repos

- Store creation: `git init --bare <store>`; `git remote add origin <url>`;
  `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`; `git fetch origin`;
  `git remote set-head origin --auto`. No local branches → any worktree can use any branch.
- Repo spec: URL (https, ssh, file, path ending `.git`) → store; `owner/repo` → `https://github.com/owner/repo.git`;
  bare name → unique store with that basename; path (`.`/`./x`/absolute) to a local repo → worktree from that repo.
- Worktree: local branch exists → `worktree add <path> <b>`; `origin/<b>` exists → `worktree add --track -b <b>
  <path> origin/<b>`; else `worktree add -b <b> <path> <base>` where base = parent lane's branch (if the parent
  lane has this repo, nearest ancestor) else `origin/HEAD`. Record base SHA in `.work.json`.
- Every store mutation (clone, fetch, worktree add/remove) holds `<root>/.work/locks/<store-hash>.lock`
  (O_EXCL create, JSON `{pid, t}`; stale when pid dead or >10 min; wait with backoff up to 60 s).
- mv/archive/unarchive: move folder, then `git worktree repair` inside each worktree.
- rm: per worktree check dirty (`status --porcelain`) and unpushed (`rev-list HEAD --not --remotes`); refuse
  without `--force` (picker shows warnings before YES); `git worktree remove --force`, `worktree prune`, then
  delete folder. Branches are kept.
- `post_add` (space config) runs `sh -c` in each new worktree; failure = warning.

## .space.toml

```toml
prefix = "auto"            # auto | "" | literal
template = "template"      # folder inside the space copied into new workspaces
post_add = "bun install"   # run in each new worktree
cleanup_days = 30          # flag workspaces not visited for N days (picker badge, `ls --stale`)
```

## .work.json (workspace)

```json
{ "version": 1,
  "lanes": {
    "root": { "parent": null, "branch": "IMG-1234-autofit",
              "repos": { "cesdk-web": { "source": "<store or local repo path>", "base": "<sha>", "pr": 12 } } },
    "ui":   { "parent": "root", "branch": "IMG-1234-autofit-ui", "repos": { … } } },
  "sync": null }
```

## Agents (phase 2)

Workspace and lane get `AGENTS.md` (generated block between `<!-- work:begin -->`/`<!-- work:end -->`, rest is kept)
and `CLAUDE.md` containing `@AGENTS.md` (created only if missing). Lane file: your lane, branch, parent, repos,
sibling lanes are off-limits, use `work sync` / `work submit`. A Claude Code skill lives in `skill/SKILL.md`.
`--json` on ls/info/path/new, `--yes` replaces typed YES, no prompts without a TTY.

## Stacks (phase 3)

- Tree: each lane has one parent (lane or trunk); per repo the effective parent is the nearest ancestor lane
  containing that repo, else `origin/HEAD`.
- `sync`: fetch every store once; lanes in topological order; per worktree: skip dirty (report); if a parent PR is
  MERGED (`gh pr view <n> --json state`), re-parent its children to its parent; `git rebase --onto <parentRef>
  <recorded base> <branch>` inside that worktree; record new base. Conflict → save progress in `.work.json.sync`,
  print the worktree path, exit 1; `--continue` resumes, `--abort` aborts the current rebase and clears state.
  Git's `--update-refs` is not used (it skips branches checked out in other worktrees).
- `submit`: topological; skip worktrees with no commits over their parent; `git push --force-with-lease -u origin
  <branch>`; `gh pr create --base <parent branch or trunk> --head <branch>` (or `gh pr edit --base` when the base
  changed); record PR numbers. `WORK_GH` overrides the gh binary (tests use a stub).

## Testing

`bun test`. Unit: naming, prefix, scoring, URI parsing, key parsing, quoting. Integration: real git in `mkdtemp`
roots with local bare repos as remotes (worktrees, mv repair, rm safety, sync with conflicts, squash-merge
re-parenting, submit via gh stub). Picker via injected keys (`--and-keys`, `--and-exit`). Parity: differential
tests running the installed `try` and `work` on identical scenarios (`docs/parity.md`). Nothing touches `~/Work`.
