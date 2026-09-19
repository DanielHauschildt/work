# work

Workspaces with parallel, stacked feature lanes across repos. A superset of
[`try`](https://github.com/tobi/try): same picker, same keys, same dated folders — plus spaces, lanes,
shared bare repo stores, stacked PRs, shell completion and an agent-friendly CLI.

```
~/Work/
├── .repos/github.com/imgly/cesdk-web.git     one bare store per repo
├── tries/2026-09-19-redis-bench/             ephemeral (try's folders)
└── labs/IMG-1234-autofit/                    workspace (entry)
    ├── AGENTS.md, CLAUDE.md                  generated context for agents
    ├── root/cesdk-web/                       lane root  · branch IMG-1234-autofit     · on origin/main
    ├── ui/cesdk-web/                         lane ui    · branch IMG-1234-autofit-ui  · on root
    └── guide/docs/                           lane guide · branch IMG-1234-autofit-guide · on root
```

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
work clone https://github.com/tobi/try.git        # tries/2026-09-19-tobi-try/root/try
work . experiment             # new entry with a worktree of the current repo
work -                        # previous entry

work add imgly/cesdk-web      # checkout in the current lane (default: root), shared store in .repos
work lane ui --on root        # stacked lane with the same repos, branch <entry>-ui
work lane guide docs          # lane with other repos (on the current lane, or --on trunk)
work sync                     # restack every lane onto its parent (conflict → fix → work sync --continue)
work submit --draft           # push lanes, open one PR per repo+lane with base = parent lane's branch

work mv labs --prefix IMG-99  # promote the current entry from tries to labs, worktrees repaired
work archive / unarchive      # <space>/.archive/<entry>
work rm ./ui --yes            # remove a lane (refuses dirty/unpushed work without --force)
work info --json | work ls --json | work path <query> [lane]
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
↑↓ Enter  ^T New  ^D Delete  ^R Move  Tab Space  Esc
```

- **Tab / Shift-Tab** switch between all spaces, each space, and `+ new` (type a name, Enter → new space).
- Two create rows: the space's default prefix first (Ctrl-T takes it), the other variant (date ↔ no date) below.
- Type `space/name` to filter or create in another space; an unknown space is created — you're asked once
  whether its entries get a date prefix (stored in `<space>/.space.toml`).
- try's keys: ↑↓ Ctrl-P/N, Enter, Ctrl-T new, Ctrl-D mark + Enter + `YES` delete, Ctrl-A/E/B/F/K/W/H editing, Esc;
  plus Ctrl-R move to `space/name`.

Spaces from the command line: `work space` (list), `work space new clients --prefix none`,
`work space set labs --prefix IMG`.

## Space config — `<space>/.space.toml`

```toml
prefix = "auto"            # auto (date) | "" | literal, e.g. "IMG"
template = "template"      # folder copied into new entries
post_add = "bun install"   # run in each new checkout
cleanup_days = 30          # mark entries not visited for 30 days as stale (picker badge, `work ls --stale`)
```

## Agents

Every entry and lane gets an `AGENTS.md` (generated block, your own text is kept) and a `CLAUDE.md` that
imports it. `skill/SKILL.md` is a Claude Code skill for the CLI (copy to `~/.claude/skills/work/`).
All non-picker commands work without a TTY, take `--json`, and use `--yes` instead of typed confirmation.

## Differences to try

See [docs/parity.md](docs/parity.md). In short: the root is `~/Work` with spaces instead of one tries folder,
`clone`/`.` create checkouts in lane `root` on a named branch (try: detached worktree / plain clone at the entry
root), recency comes from a visit log instead of `touch`, deletion is git-aware, and the shell wrapper sources a
temp file so normal stdout (e.g. `work ls --json | jq`) works through it.

## Develop

```sh
bun test          # unit, git integration, CLI end-to-end, differential parity vs. installed try
bun run typecheck
```

Spec: [docs/spec.md](docs/spec.md).
