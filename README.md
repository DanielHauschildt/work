# work

Workspaces with parallel, stacked feature lanes across repos. A superset of
[`try`](https://github.com/tobi/try): same picker, same keys, same dated folders — plus spaces, lanes,
shared bare repo stores, stacked PRs, shell completion and an agent-friendly CLI.

```
~/Work/
├── .repos/github.com/imgly/cesdk-web.git     one bare store per repo
├── tries/2026-09-19-redis-bench/             ephemeral (try's folders)
└── labs/IMG-1234-autofit/                    workspace with lanes
    ├── AGENTS.md, CLAUDE.md                  generated context for agents
    ├── cesdk-web/                            lane root  · branch IMG-1234-autofit
    ├── docs/                                 lane root  · branch IMG-1234-autofit
    ├── cesdk-web@ui/                         lane ui    · branch IMG-1234-autofit-ui   · on root
    └── docs@guide/                           lane guide · branch IMG-1234-autofit-guide · on root
```

A lane is a concept, not a folder: one branch, its worktrees and a stack parent. Each worktree sits directly in the
workspace as `<repo>` (lane `root`) or `<repo>@<lane>`.

## Install

```sh
bun install && bun run install-local          # builds dist/work, copies it to ~/.local/bin/work
```

`~/.zshrc` / `~/.bashrc` (replaces `eval "$(try init …)"`):

```sh
eval "$(work init ~/Work --shortcut tries --shortcut labs --shortcut try=tries)"
```

fish: `work init ~/Work --shortcut tries | source`.

## Use

```sh
tries                         # try's picker, scoped to ~/Work/tries (Tab: other spaces)
tries redis                   # picker filtered by "redis"; Enter on "Create new" makes 2026-09-19-redis
work                          # picker across all spaces
labs autofit --prefix IMG-1234   # picker in labs; creating makes IMG-1234-autofit
work new --space labs --prefix IMG-1234 autofit   # create without the picker (prints the path)
work clone https://github.com/tobi/try.git        # tries/2026-09-19-tobi-try/try
work . experiment             # new workspace with a worktree of the current repo
work -                        # previous workspace

work add imgly/cesdk-web      # worktree cesdk-web/ in the current lane (default: root), store in .repos
work lane ui --on root        # stacked lane with the same repos: cesdk-web@ui/, branch <workspace>-ui
work lane guide docs          # lane with other repos: docs@guide/ (on the current lane, or --on trunk)
work sync                     # restack every lane onto its parent (conflict → fix → work sync --continue)
work submit --draft           # push lanes, open one PR per repo+lane with base = parent lane's branch

work mv labs --prefix IMG-99  # promote the current workspace from tries to labs, worktrees repaired
work archive / unarchive      # <space>/.archive/<workspace>
work rm ./ui --yes            # remove a lane = all its worktrees (refuses dirty/unpushed without --force)
work rm ./cesdk-web@ui --yes  # remove a single worktree (a folder of that name wins over a lane of that name)
work migrate                  # old <lane>/<repo> folders → <repo>[@<lane>] (--all for every workspace)
work info --json | work ls --json | work path <query> [folder]
```

### Picker

```text
📁 work   all  [tries]  labs  clients  + new
──────────────────────────────────────────────────────────
Search: autofit▌
──────────────────────────────────────────────────────────
→ 📁 2026-09-12-autofit-spike                3d ago, 4.1

  📂 New tries/2026-09-19-autofit
  📂 New tries/autofit                           no date
──────────────────────────────────────────────────────────
↑↓ Enter  → Lanes  ^T New  ^D Delete  ^R Move  Tab Space  Esc
```

- Starts on the space you're in (cursor on the current workspace); outside the root on all spaces. A shortcut
  or `--space` picks the tab instead.
- **Tab / Shift-Tab** switch between all spaces, each space, and `+ new` (type a name, Enter → new space).
- In a space: two create rows, the space's default prefix first (Ctrl-T takes it), the other variant (date ↔ no
  date) below. In all spaces: one create row per space with its default prefix — your default space first
  (Ctrl-T), then the others alphabetically.
- Type `space/name` to filter or create in another space; an unknown space is created — you're asked once
  whether its workspaces get a date prefix (stored in `<space>/.space.toml`).
- try's keys: ↑↓ Ctrl-P/N, Enter, Ctrl-T new, Ctrl-D mark + Enter + `YES` delete, Ctrl-A/E/B/F/K/W/H editing, Esc;
  plus Ctrl-R move to `space/name`.

**→ on a workspace** shows its worktrees grouped by lane (← goes back to the list):

```text
📁 work › labs › IMG-1234-autofit
──────────────────────────────────────────────────────────
Search: ▌
──────────────────────────────────────────────────────────
→ 📁 cesdk-web     IMG-1234-autofit        on main
  📁 docs          IMG-1234-autofit        on main
  📁 cesdk-web@ui  IMG-1234-autofit-ui     on root  *
  📁 docs@guide    IMG-1234-autofit-guide  on root
──────────────────────────────────────────────────────────
↑↓ Enter cd  ← Back  ^T New lane  ^D Remove  Esc
```

Enter cds into the worktree. Type a name to get `📂 New lane on <lane>: <name>` — the new lane stacks on the lane of
the row you highlighted last and gets its repos (like `work lane`); Enter or Ctrl-T creates it. Ctrl-D removes the
whole lane of the highlighted row after `YES` (dirty or unpushed worktrees are listed first). `*` marks worktrees
with uncommitted changes; a lane without worktrees is one row showing its name, its branch and `no worktrees`.

Spaces from the command line: `work space` (list), `work space new clients --prefix none`,
`work space set labs --prefix IMG`.

## Space config — `<space>/.space.toml`

```toml
prefix = "auto"            # auto (date) | "" | literal, e.g. "IMG"
template = "template"      # folder copied into new workspaces
post_add = "bun install"   # run in each new worktree
cleanup_days = 30          # mark workspaces not visited for 30 days as stale (picker badge, `work ls --stale`)
```

## Agents

Every workspace gets an `AGENTS.md` (generated block, your own text is kept) and a `CLAUDE.md` that imports it —
at workspace level only, so nothing generated shows up as an untracked file inside one of your repos. The table
lists lane, branch, stacked-on and folders, and the rules tell each agent to work only in its own lane's folders.
`skill/SKILL.md` is a Claude Code skill for the CLI (copy to `~/.claude/skills/work/`).
All non-picker commands work without a TTY, take `--json`, and use `--yes` instead of typed confirmation.

## Differences to try

See [docs/parity.md](docs/parity.md). In short: the root is `~/Work` with spaces instead of one tries folder,
`clone`/`.` create a worktree in lane `root` (folder `<repo>/`) on a named branch (try: detached worktree / plain
clone at the workspace root), recency comes from a visit log instead of `touch`, deletion is git-aware, and the
shell wrapper sources a temp file so normal stdout (e.g. `work ls --json | jq`) works through it.

## Develop

```sh
bun test          # unit, git integration, CLI end-to-end, differential parity vs. installed try
bun run typecheck
bun run e2e       # real zsh + bash sessions via expect (test/e2e), compiled binary
```

Spec: [docs/spec.md](docs/spec.md).
