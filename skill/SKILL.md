---
name: work
description: Use when working inside a `work` workspace (a folder under ~/Work/<space>/<workspace> with lanes, AGENTS.md mentioning `work`, or a .work.json file), or when asked to create a workspace, start a feature lane, stack lanes, restack, or open stacked PRs with the `work` CLI.
---

# work — workspaces with parallel, stacked lanes

`work` manages `~/Work/<space>/<workspace>/<repo>[@<lane>]`:

- **space**: a top-level folder (`tries` = ephemeral, `labs` = longer-lived, any other name)
- **workspace**: a folder in a space (`labs/IMG-1234-autofit`); `.work.json` inside holds its lanes
- **lane**: one feature = one branch (`<workspace>-<lane>`, lane `root` = `<workspace>`), one agent, not a folder; lanes stack on a parent lane or on trunk
- **worktree**: one repo of a lane as a git worktree in the workspace — folder `<repo>` (lane `root`) or `<repo>@<lane>`; all worktrees of a repo share one bare store in `~/Work/.repos`

## Rules

- Work only in your lane's folders, e.g. `cesdk-web@ui`; the others belong to other agents. Read the workspace's `AGENTS.md` first.
- Commit on the lane branch. Never `git checkout`/`switch` other branches inside a worktree.
- Call the binary directly: it never needs a TTY for these commands and prints paths on stdout.
  Destructive commands need `--yes`; they refuse dirty/unpushed work unless `--force`.

## Commands for agents

| Goal | Command |
|---|---|
| Where am I / state of all lanes | `work info --json` |
| Create a workspace | `work new --space labs --prefix IMG-1234 autofit` → prints its path |
| Find a workspace | `work path <query> [folder]` (folder = `<repo>[@<lane>]`; `--first` for the best fuzzy match), `work ls --json` |
| Add a repo to the current lane | `work add <owner/repo|url|path|store-name> [branch]` → prints the path of `<repo>[@<lane>]` |
| Start a stacked feature | `work lane <name> [repos…] --on <parent-lane|trunk>` → prints the new worktree paths |
| Restack after a parent changed | `work sync` (conflict: fix in the printed worktree, `git add`, `work sync --continue`; or `--abort`) |
| Push + open/update stacked PRs | `work submit [--draft]` (one PR per repo and lane, base = parent lane branch) |
| Move / promote | `work mv <workspace> labs[/<name>] [--prefix P]` |
| Remove a finished lane | `work rm ./<lane> --yes` (all its worktrees) or `work rm ./<repo>@<lane> --yes` (one; a folder of that name wins over a lane of that name); branches are kept |
| Workspace still has `<lane>/<repo>` folders | `work migrate [--force]` — writing commands refuse it until then |

A lane without explicit repos inherits the repos of its parent lane (with no repos it gets no folder). The current
lane comes from the cwd's folder suffix (`docs@ui` → lane `ui`, no suffix → lane `root`). A merged parent PR is
detected by `work sync`; its children are re-parented and rebased onto trunk without the parent's commits.
