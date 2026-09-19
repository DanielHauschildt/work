---
name: work
description: Use when working inside a `work` workspace (a folder under ~/Work/<space>/<entry> with lanes, AGENTS.md mentioning `work`, or a .work.json file), or when asked to create a workspace, start a feature lane, stack lanes, restack, or open stacked PRs with the `work` CLI.
---

# work — workspaces with parallel, stacked lanes

`work` manages `~/Work/<space>/<entry>/<lane>/<repo>`:

- **space**: a top-level folder (`tries` = ephemeral, `labs` = longer-lived, any other name)
- **entry**: a workspace (`labs/IMG-1234-autofit`), `.work.json` inside holds its lanes
- **lane**: one feature = one branch (`<entry>-<lane>`, lane `root` = `<entry>`), one agent; lanes stack on a parent lane or on trunk
- **checkout**: a git worktree of a repo inside a lane; all checkouts of a repo share one bare store in `~/Work/.repos`

## Rules

- Stay inside your lane folder. Other lanes belong to other agents. Read the `AGENTS.md` of your lane first.
- Commit on the lane branch. Never `git checkout`/`switch` other branches inside a checkout.
- Call the binary directly: it never needs a TTY for these commands and prints paths on stdout.
  Destructive commands need `--yes`; they refuse dirty/unpushed work unless `--force`.

## Commands for agents

| Goal | Command |
|---|---|
| Where am I / state of all lanes | `work info --json` |
| Create a workspace | `work new --space labs --prefix IMG-1234 autofit` → prints its path |
| Find a workspace | `work path <query> [lane]` (`--first` for the best fuzzy match), `work ls --json` |
| Add a repo to the current lane | `work add <owner/repo|url|path|store-name> [branch]` → prints the checkout path |
| Start a stacked feature | `work lane <name> [repos…] --on <parent-lane|trunk>` → prints the lane path |
| Restack after a parent changed | `work sync` (conflict: fix in the printed checkout, `git add`, `work sync --continue`; or `--abort`) |
| Push + open/update stacked PRs | `work submit [--draft]` (one PR per repo and lane, base = parent lane branch) |
| Move / promote | `work mv <entry> labs[/<name>] [--prefix P]` |
| Remove a finished lane | `work rm ./<lane> --yes` (branches are kept) |

A lane without explicit repos inherits the repos of its parent lane. A merged parent PR is detected by
`work sync`; its children are re-parented and rebased onto trunk without the parent's commits.
