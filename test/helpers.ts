import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
Object.assign(process.env, GIT_ENV, { WORK_QUIET: "1" });

export function sh(cmd: string[], cwd?: string, env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...GIT_ENV, ...env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} (${cwd}): ${p.stderr.toString()}${p.stdout.toString()}`);
  return p.stdout.toString().trim();
}

export function g(cwd: string, ...args: string[]): string {
  return sh(["git", "-c", "init.defaultBranch=main", ...args], cwd);
}

export interface Sandbox {
  dir: string;
  root: string;
  remotes: string;
  cleanup: () => void;
}

export function sandbox(): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "work-test-")));
  const root = join(dir, "Work");
  const remotes = join(dir, "remotes");
  mkdirSync(root, { recursive: true });
  mkdirSync(remotes, { recursive: true });
  return { dir, root, remotes, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Bare "remote" with one commit on main (plus optional extra branches). */
export function makeRemote(sb: Sandbox, name: string, files: Record<string, string> = { "README.md": `# ${name}\n` }): string {
  const bare = join(sb.remotes, `${name}.git`);
  g(sb.remotes, "init", "--bare", "--quiet", bare);
  const seed = join(sb.dir, `seed-${name}`);
  g(sb.dir, "clone", "--quiet", bare, seed);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(seed, f), c);
  g(seed, "add", ".");
  g(seed, "commit", "--quiet", "-m", "init");
  g(seed, "push", "--quiet", "origin", "HEAD:main");
  g(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return bare;
}

/** Commit a file change inside a checkout. */
export function commit(checkout: string, file: string, content: string, msg = `edit ${file}`): string {
  writeFileSync(join(checkout, file), content);
  g(checkout, "add", file);
  g(checkout, "commit", "--quiet", "-m", msg);
  return g(checkout, "rev-parse", "HEAD");
}

/** Push a new commit to the remote's main from a scratch clone (simulates upstream progress). */
export function advanceRemote(sb: Sandbox, bare: string, file: string, content: string): void {
  const tmp = mkdtempSync(join(sb.dir, "adv-"));
  g(sb.dir, "clone", "--quiet", bare, tmp);
  commit(tmp, file, content, `upstream ${file}`);
  g(tmp, "push", "--quiet", "origin", "HEAD:main");
}
