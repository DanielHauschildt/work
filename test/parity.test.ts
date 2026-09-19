/**
 * Differential parity tests: the installed `try` and `work` run the same scenario on identical folder trees;
 * effects (created/deleted folders, cd target, exit code, messages) must match. See docs/parity.md.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GIT_ENV, g, makeRemote, type Sandbox, sandbox } from "./helpers.ts";

const TRY = "/opt/homebrew/bin/try";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const HAVE_TRY = existsSync(TRY);
const d = HAVE_TRY ? describe : describe.skip;

let sb: Sandbox;
let tryDir: string; // try's --path
let workRoot: string; // work's --path; space "tries" == tryDir equivalent

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), ...GIT_ENV, TRY_WIDTH: "100", TRY_HEIGHT: "30", ...extra };
  delete e.WORK_EMIT;
  delete e.WORK_TODAY;
  delete e.NO_COLOR;
  return e;
}

function runTry(args: string[], cwd = sb.dir, extra: Record<string, string> = {}): Out {
  const p = Bun.spawnSync(["ruby", TRY, ...args, "--path", tryDir], { cwd, env: env(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

function runWork(args: string[], cwd = sb.dir, extra: Record<string, string> = {}): Out {
  const p = Bun.spawnSync(["bun", CLI, ...args, "--path", workRoot, "--space", "tries"], {
    cwd,
    env: env({ WORK_QUIET: "1", ...extra }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** Execute try's emitted script (it only prints it); returns the final cd target. */
function evalTry(out: Out, cwd = sb.dir): string | undefined {
  if (out.code !== 0) return undefined;
  const p = Bun.spawnSync(["bash", "-c", `${out.stdout}\npwd -P`], { cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim().split("\n").pop();
}

function workCd(out: Out): string | undefined {
  const m = out.stdout.match(/^cd '(.*)'$/m);
  return m?.[1];
}

function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")).sort() : [];
}

/** Same folders with the same mtimes in both trees. */
function seed(names: [string, number][]): void {
  for (const [n, hoursAgo] of names) {
    for (const base of [tryDir, join(workRoot, "tries")]) {
      const p = join(base, n);
      mkdirSync(p, { recursive: true });
      const t = new Date(Date.now() - hoursAgo * 3600_000);
      utimesSync(p, t, t);
    }
  }
}

function expectSameEffect(keys: string, extraArgs: string[] = []): { tryCd?: string; workCd?: string } {
  const t = runTry(["exec", ...extraArgs, "--and-keys", keys]);
  const w = runWork(["exec", ...extraArgs, "--and-keys", keys]);
  const isDelete = t.stdout.includes("rm -rf");
  const tryCd = evalTry(t);
  expect(w.code).toBe(t.code);
  expect(listing(join(workRoot, "tries"))).toEqual(listing(tryDir));
  const wc = workCd(w);
  // Deliberate difference (docs/parity.md #14): try's delete script ends in its tries folder because the
  // "return to pwd" step runs in a subshell; work leaves the cwd alone.
  if (isDelete) expect(wc).toBeUndefined();
  else if (t.code === 0 && tryCd) expect(wc && basename(wc)).toBe(basename(tryCd));
  if (t.code !== 0) {
    expect(t.stdout).toContain("Cancelled.");
    expect(w.stdout).toContain("Cancelled.");
  }
  return { tryCd, workCd: wc };
}

beforeEach(() => {
  sb = sandbox();
  tryDir = join(sb.dir, "try-tries");
  workRoot = join(sb.dir, "WorkRoot");
  mkdirSync(tryDir, { recursive: true });
  mkdirSync(join(workRoot, "tries"), { recursive: true });
});
afterEach(() => sb.cleanup());

const ENTRIES: [string, number][] = [
  ["2026-09-01-redis-server", 400],
  ["2026-09-02-redis-client", 30],
  ["2026-08-11-kafka-lab", 2],
  ["2026-07-30-v", 900],
  ["2026-07-31-vbo-viz", 800],
  ["notes", 5],
  ["connection-pool", 50],
];

d("picker parity (try vs work)", () => {
  const cases: [string, string][] = [
    ["select top item", "ENTER"],
    ["navigate down twice", "DOWN,DOWN,ENTER"],
    ["ctrl-n / ctrl-p", "CTRL-N,CTRL-N,CTRL-P,ENTER"],
    ["up past the top", "UP,UP,ENTER"],
    ["fuzzy rds", "TYPE=rds,ENTER"],
    ["fuzzy connpool", "TYPE=connpool,ENTER"],
    ["query v prefers shorter", "TYPE=v,ENTER"],
    ["query 2026", "TYPE=2026,DOWN,ENTER"],
    ["create via Create-new row", "TYPE=brand-new,ENTER"],
    ["create via ctrl-t", "TYPE=redis,CTRL-T"],
    ["spaces become dashes", "TYPE=two words,CTRL-T"],
    ["backspace", "TYPE=kafkax,BACKSPACE,ENTER"],
    ["ctrl-a insert at start", "TYPE=zzz,CTRL-A,TYPE=q,CTRL-T"],
    ["ctrl-b / ctrl-f", "TYPE=abc,CTRL-B,CTRL-B,TYPE=x,CTRL-F,TYPE=y,CTRL-T"],
    ["ctrl-e", "TYPE=abc,CTRL-A,CTRL-E,TYPE=d,CTRL-T"],
    ["ctrl-k", "TYPE=abcdef,CTRL-A,CTRL-F,CTRL-F,CTRL-K,CTRL-T"],
    ["ctrl-w", "TYPE=foo-bar,CTRL-W,TYPE=baz,CTRL-T"],
    ["ctrl-h", "TYPE=kafkaz,CTRL-H,ENTER"],
    ["no match then create row", "TYPE=qqqqqq,ENTER"],
    ["esc cancels", "ESC"],
    ["delete one with YES", "DOWN,CTRL-D,ENTER,TYPE=YES,ENTER"],
    ["delete two with YES", "CTRL-D,DOWN,CTRL-D,ENTER,TYPE=YES,ENTER"],
    ["delete with wrong confirmation", "CTRL-D,ENTER,TYPE=no,ENTER"],
    ["delete mode esc", "CTRL-D,ESC,ENTER"],
    ["ctrl-d toggle off", "CTRL-D,CTRL-D,ENTER"],
  ];
  for (const [name, keys] of cases) {
    test(name, () => {
      seed(ENTRIES);
      expectSameEffect(keys);
    });
  }

  test("initial query argument filters like try", () => {
    seed(ENTRIES);
    const t = runTry(["exec", "redis", "--and-keys", "ENTER"]);
    const w = runWork(["exec", "redis", "--and-keys", "ENTER"]);
    expect(basename(workCd(w)!)).toBe(basename(evalTry(t)!));
  });

  test("ctrl-t with empty query prompts for a name", () => {
    seed(ENTRIES);
    const t = runTry(["exec", "--and-keys", "CTRL-T"], sb.dir);
    const w = runWork(["exec", "--and-keys", "CTRL-T"], sb.dir);
    expect(w.code).toBe(t.code);
  });
});

d("render parity", () => {
  test("--and-exit screen matches try except title and footer additions", () => {
    seed(ENTRIES);
    const t = runTry(["exec", "--and-exit"]);
    const w = runWork(["exec", "--and-exit"]);
    const norm = (s: string) =>
      s
        .replace(/📁 (Try|Work) Selector( · \w+)?/, "📁 SELECTOR")
        .replace(/  Tab: Scope  Ctrl-R: Move/, "")
        // scores drift by milliseconds between the two runs
        .replace(/(\d+[mhdw] ago|just now), \d+\.\d/g, "$1, S");
    expect(norm(w.stderr)).toBe(norm(t.stderr));
    expect(w.code).toBe(t.code);
  });

  test("--and-type prefills the search like try", () => {
    seed(ENTRIES);
    const t = runTry(["exec", "--and-type", "redis", "--and-exit"]);
    const w = runWork(["exec", "--and-type", "redis", "--and-exit"]);
    const strip = (s: string) => s.split("\n").filter((l) => /redis|Search/.test(l)).map((l) => l.replace(/, \d+\.\d/, "")).join("\n");
    expect(strip(w.stderr)).toBe(strip(t.stderr));
  });
});

d("command parity", () => {
  test("binary without arguments: help and exit 2", () => {
    const t = Bun.spawnSync(["ruby", TRY], { env: env(), stdout: "pipe" });
    const w = Bun.spawnSync(["bun", CLI], { env: env(), stdout: "pipe" });
    expect(t.exitCode).toBe(2);
    expect(w.exitCode).toBe(2);
  });

  test("--help / --version exit 0", () => {
    expect(runTry(["--help"]).code).toBe(0);
    expect(runWork(["--help"]).code).toBe(0);
    expect(runTry(["--version"]).code).toBe(0);
    expect(runWork(["--version"]).code).toBe(0);
  });

  test("picker without a terminal: Cancelled, exit 1", () => {
    const t = runTry(["exec"]);
    const w = runWork(["exec"]);
    expect(t.code).toBe(1);
    expect(w.code).toBe(1);
    expect(t.stdout).toContain("Cancelled.");
    expect(w.stdout).toContain("Cancelled.");
    // try's message is wiped by its own screen clear; work prints it after restoring the terminal
    expect(w.stderr).toContain("requires an interactive terminal");
  });

  test("clone naming: DATE-user-repo, custom name verbatim", () => {
    makeRemote(sb, "try");
    const gitconfig = join(sb.dir, "gitconfig");
    writeFileSync(gitconfig, `[url "${sb.remotes}/"]\n\tinsteadOf = https://github.com/tobi/\n`);
    const extra = { GIT_CONFIG_GLOBAL: gitconfig };
    const cases = [["clone", "https://github.com/tobi/try.git"], ["https://github.com/tobi/try.git"], ["clone", "https://github.com/tobi/try.git", "my-fork"]];
    for (const [i, args] of cases.entries()) {
      tryDir = join(sb.dir, `try-${i}`);
      workRoot = join(sb.dir, `work-${i}`);
      mkdirSync(tryDir, { recursive: true });
      mkdirSync(join(workRoot, "tries"), { recursive: true });
      const t = runTry(["exec", ...args], sb.dir, extra);
      evalTry(t);
      const w = runWork(["exec", ...args], sb.dir, extra);
      expect(w.code).toBe(0);
      expect(listing(join(workRoot, "tries"))).toEqual(listing(tryDir));
    }
  }, 60_000);

  test("unparseable git URI is an error in both", () => {
    const t = runTry(["exec", "clone", "https://github.com"]);
    const w = runWork(["exec", "clone", "https://github.com"]);
    expect(t.code).not.toBe(0);
    expect(w.code).not.toBe(0);
  });

  test("`.` needs a name; `. name` and versioning match; non-repo folders just mkdir", () => {
    makeRemote(sb, "app");
    const repo = join(sb.dir, "seed-app");
    const t0 = runTry(["exec", "."], repo);
    const w0 = runWork(["exec", "."], repo);
    expect(t0.code).toBe(1);
    expect(w0.code).toBe(1);
    expect(w0.stderr).toContain("requires a name argument");
    for (const args of [[".", "exp"], [".", "exp"], [".", "v1"], [".", "v1"], ["./", "other name"], ["worktree", "dir", "wt"]]) {
      evalTry(runTry(["exec", ...args], repo), repo);
      runWork(["exec", ...args], repo);
      expect(listing(join(workRoot, "tries"))).toEqual(listing(tryDir));
    }
    const plain = join(sb.dir, "plain-folder");
    mkdirSync(plain);
    evalTry(runTry(["exec", "./"], plain), plain);
    runWork(["exec", "./"], plain);
    expect(listing(join(workRoot, "tries"))).toEqual(listing(tryDir));
    // work puts the worktree in lane root on a named branch (try: detached at the entry root)
    const today = listing(tryDir).find((n) => n.endsWith("-exp"))!;
    expect(g(join(workRoot, "tries", today, "root", "seed-app"), "branch", "--show-current")).toBe("exp");
  }, 60_000);
});
