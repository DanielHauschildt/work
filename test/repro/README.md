# test/repro

End-to-end checks for bugs found in review, written by the reviewer before the fix. Each one builds a sandbox,
drives the real CLI (`bun <checkout>/src/cli.ts --path <sandbox>/Work`) and ends with one line:

```
VERDICT: … FIXED    exit 0, sandbox deleted
VERDICT: … PRESENT  exit 1, sandbox kept and printed
```

Run them all with `bun run repro`, or one at a time:

```sh
test/repro/run-all.sh                # this checkout
test/repro/f1-lockout.sh /path/to/another/work   # any other checkout, e.g. to see a bug that is still there
KEEP_SANDBOX=1 test/repro/f6-ctrld.sh            # keep the sandbox even when it passes
```

They are not part of `bun test`: each one runs several `work` commands with real git repos, which takes seconds.
Nothing outside the sandbox (`/tmp/work-repro.*`) is touched — never `~/Work` and never a checkout.

| Script | Asserts |
|---|---|
| `f1-lockout.sh` | A repo named like a lane, holding a folder named like another repo of that lane, is not taken for the old `<lane>/<repo>` layout — otherwise `add`/`lane`/`rm`/`sync`/`submit` refuse the workspace while `migrate` has nothing to do. |
| `f2-lostupdate.sh` | `work migrate` holds the workspace lock across its moves and the model write, so a `work rm` running at the same time cannot have its `.work.json` change overwritten. |
| `f3-agents.sh` | Text a user added to a lane folder's `AGENTS.md` survives `work migrate`. |
| `f3b-agents-force.sh` | With `--force` the edited `AGENTS.md` is rescued as `<lane>-AGENTS.md` while purely generated files go with the folder. |
| `f4-lane-rollback.sh` | When only some worktrees of a new lane could be created, the lane is kept and both the failure and the retry say how to complete or drop it. |
| `f4b-rollback.sh` | When none could be created, the lane record is rolled back, so the retry works. |
| `f5-error.sh` | A failing git command names the worktree it failed on. |
| `f6-ctrld.sh` | Ctrl-D in the picker's worktree view removes the highlighted worktree, and the lane only with its last one. |
| `reg-rm-precedence.sh` | `work rm ./<name>` removes the worktree folder of that name first, the lane of that name after. |
| `reg-migrate.sh` | An old `<lane>/<repo>` layout is refused with the command to run, and `work migrate` converts it. |

`common.sh` is sourced by all of them: sandbox, `work` runner, `remote` (bare repo with one commit), `lanes_of`
(repos per lane from `.work.json`), `fixture` (a setup step that fails loudly with exit 2, so a broken fixture is
never read as a finding) and `verdict`. It also neutralizes the git environment (`GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, fixed author), so a developer's global config — signing, hooks,
a `user.name` prompt — cannot reach these runs.
