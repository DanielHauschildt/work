import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { WorkError } from "./errors.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  allowFail?: boolean;
  env?: Record<string, string>;
  /** Stream stderr (progress) to our stderr instead of capturing it. */
  progress?: boolean;
}

export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  const proc = Bun.spawnSync(cmd, {
    // never inherit our cwd: `work mv` may have just moved it away
    cwd: opts.cwd ?? "/",
    env: { ...process.env, ...opts.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: opts.progress ? "inherit" : "pipe",
  });
  const res = {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
  if (res.code !== 0 && !opts.allowFail) {
    const msg = res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
    throw new WorkError(`${cmd.slice(0, 3).join(" ")}…: ${msg}`);
  }
  return res;
}

/** `git -C <dir> …`, trimmed stdout. */
export function git(dir: string, args: string[], opts: Omit<RunOptions, "cwd"> = {}): string {
  return run(["git", "-C", dir, ...args], opts).stdout.trim();
}

export function gitOk(dir: string, args: string[]): boolean {
  return run(["git", "-C", dir, ...args], { allowFail: true }).code === 0;
}

export function gitTry(dir: string, args: string[]): string | undefined {
  const r = run(["git", "-C", dir, ...args], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** A folder is a repo dir when it has a `.git` file (linked worktree) or a `.git` directory (plain repo). */
export function isRepoDir(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function isLinkedWorktree(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/** Common git dir (store or main repo .git) of a linked worktree, read from its `.git` file — works even when the worktree was moved. */
export function commonDirOf(worktree: string): string | undefined {
  const r = gitTry(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r) return r;
  try {
    const m = readFileSync(join(worktree, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return undefined;
    const gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(worktree, m[1]!);
    return resolve(gitdir, "..", "..");
  } catch {
    return undefined;
  }
}

/** Worktrees (linked worktrees or plain repos) up to `depth` levels below dir, not descending into them. */
export function findWorktrees(dir: string, depth = 2): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(d, n);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      if (isRepoDir(p)) out.push(p);
      else if (level < depth) walk(p, level + 1);
    }
  };
  walk(dir, 1);
  return out.sort();
}

export interface WorktreeStatus {
  branch: string | undefined;
  dirty: boolean;
  /** Commits not on any remote-tracking ref. */
  unpushed: number;
  rebasing: boolean;
}

export function worktreeStatus(dir: string): WorktreeStatus {
  const branch = gitTry(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const dirty = (gitTry(dir, ["status", "--porcelain"]) ?? "") !== "";
  const unpushed = Number(gitTry(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]) ?? "0") || 0;
  return { branch, dirty, unpushed, rebasing: isRebasing(dir) };
}

export function isRebasing(dir: string): boolean {
  for (const p of ["rebase-merge", "rebase-apply"]) {
    const path = gitTry(dir, ["rev-parse", "--path-format=absolute", "--git-path", p]);
    if (path && existsSync(path)) return true;
  }
  return false;
}

export function revParse(dir: string, ref: string): string | undefined {
  return gitTry(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}
