import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commit, g, GIT_ENV, makeRemote, type Sandbox, sandbox } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const TODAY = "2026-09-19";
let sb: Sandbox;

interface Res {
  code: number;
  stdout: string;
  stderr: string;
  emitted?: string;
}

function work(args: string[], opts: { cwd?: string; wrapper?: boolean; env?: Record<string, string>; stdin?: string } = {}): Res {
  const emitFile = join(sb.dir, `emit-${Math.random().toString(36).slice(2)}`);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...GIT_ENV, WORK_TODAY: TODAY, WORK_QUIET: "", ...opts.env };
  if (opts.wrapper) {
    env.WORK_EMIT = emitFile;
    env.WORK_SHELL = "sh";
    writeFileSync(emitFile, "");
  } else delete env.WORK_EMIT;
  const p = Bun.spawnSync(["bun", CLI, "--path", sb.root, ...args], {
    cwd: opts.cwd ?? sb.dir,
    env,
    stdin: opts.stdin ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode ?? -1,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
    emitted: opts.wrapper && existsSync(emitFile) ? readFileSync(emitFile, "utf8") : undefined,
  };
}

beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("basics", () => {
  test("no args without the wrapper prints help and exits 2 (like try)", () => {
    const r = work([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("work v");
  });

  test("--help anywhere, --version", () => {
    expect(work(["ls", "--help"]).code).toBe(0);
    expect(work(["-v"]).stdout.trim()).toMatch(/^work \d/);
  });

  test("new: direct call prints the path, wrapper gets a cd script, exec prints try-style script", () => {
    const direct = work(["new", "--space", "labs", "--prefix", "IMG-1", "autofit"]);
    expect(direct.code).toBe(0);
    expect(direct.stdout.trim()).toBe(join(sb.root, "labs", "IMG-1-autofit"));
    const wrapped = work(["new", "redis bench"], { wrapper: true });
    expect(wrapped.emitted).toBe(`cd '${join(sb.root, "tries", `${TODAY}-redis-bench`)}'\n`);
    const exec = work(["exec", "new", "--prefix", "none", "plain"]);
    expect(exec.stdout).toBe(`# if you can read this, you didn't launch work from an alias. run work --help.\ncd '${join(sb.root, "tries", "plain")}'\n`);
    const json = JSON.parse(work(["new", "--json", "x"]).stdout);
    expect(json).toMatchObject({ space: "tries", name: `${TODAY}-x`, created: true });
  });

  test("space config: prefix and template", () => {
    mkdirSync(join(sb.root, "labs", "tpl"), { recursive: true });
    writeFileSync(join(sb.root, "labs", "tpl", "notes.md"), "# notes\n");
    writeFileSync(join(sb.root, "labs", ".space.toml"), 'prefix = ""\ntemplate = "tpl"\n');
    const r = work(["new", "--space", "labs", "thing"]);
    expect(r.stdout.trim()).toBe(join(sb.root, "labs", "thing"));
    expect(readFileSync(join(sb.root, "labs", "thing", "notes.md"), "utf8")).toBe("# notes\n");
  });

  test("path resolution: exact, substring, ambiguous, --first, lane", () => {
    for (const n of ["2026-09-01-redis-a", "2026-09-02-redis-b", "2026-09-03-kafka"]) mkdirSync(join(sb.root, "tries", n), { recursive: true });
    expect(work(["path", "kafka"]).stdout.trim()).toBe(join(sb.root, "tries", "2026-09-03-kafka"));
    const amb = work(["path", "redis"]);
    expect(amb.code).toBe(1);
    expect(amb.stderr).toContain("ambiguous");
    expect(work(["path", "redis", "--first"]).code).toBe(0);
    expect(work(["path", "tries/2026-09-01-redis-a"]).stdout.trim()).toBe(join(sb.root, "tries", "2026-09-01-redis-a"));
    expect(work(["path", "nope"]).code).toBe(1);
  });

  test("ls --json lists entries across spaces", () => {
    work(["new", "a"]);
    work(["new", "--space", "labs", "b"]);
    const list = JSON.parse(work(["ls", "--json"]).stdout) as { space: string; name: string }[];
    expect(list.map((e) => `${e.space}/${e.name}`).sort()).toEqual([`labs/${TODAY}-b`, `tries/${TODAY}-a`]);
  });

  test("back goes to the previous entry", () => {
    const a = work(["new", "a"]).stdout.trim();
    const b = work(["new", "b"]).stdout.trim();
    expect(work(["back"], { cwd: b }).stdout.trim()).toBe(a);
    expect(work(["-"], { cwd: a }).stdout.trim()).toBe(b);
  });
});

describe("repos", () => {
  test("clone URL (and URL shorthand) → entry named like try, checkout in root lane", () => {
    const app = makeRemote(sb, "app");
    const r = work(["clone", app], { wrapper: true });
    expect(r.code).toBe(0);
    const entry = join(sb.root, "tries", `${TODAY}-remotes-app`);
    expect(r.emitted).toBe(`cd '${join(entry, "root", "app")}'\n`);
    expect(g(join(entry, "root", "app"), "branch", "--show-current")).toBe("remotes-app");
    const r2 = work([app, "custom"]);
    expect(r2.stdout.trim()).toBe(join(sb.root, "tries", "custom", "root", "app"));
  });

  test("`.` requires a name; creates a worktree of the current repo on a named branch", () => {
    const app = makeRemote(sb, "app");
    const repo = join(sb.dir, "seed-app");
    const bare = work(["."], { cwd: repo });
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("'work .' requires a name argument");
    const r = work([".", "exp"], { cwd: repo });
    const checkout = join(sb.root, "tries", `${TODAY}-exp`, "root", "seed-app");
    expect(r.stdout.trim()).toBe(checkout);
    expect(g(checkout, "branch", "--show-current")).toBe("exp");
    // second time: versioned name like try
    expect(work([".", "exp"], { cwd: repo }).stdout.trim()).toBe(join(sb.root, "tries", `${TODAY}-exp-2`, "root", "seed-app"));
    // outside a repo: just a folder
    expect(work(["worktree", sb.remotes, "plain"]).stdout.trim()).toBe(join(sb.root, "tries", `${TODAY}-plain`));
    void app;
  });

  test("add + lane inside an entry, info --json", () => {
    const app = makeRemote(sb, "app");
    const entry = work(["new", "--space", "labs", "--prefix", "IMG-9", "feat"]).stdout.trim();
    const checkout = work(["add", app], { cwd: entry }).stdout.trim();
    expect(checkout).toBe(join(entry, "root", "app"));
    commit(checkout, "x.txt", "x");
    const lane = work(["lane", "ui"], { cwd: checkout, wrapper: true });
    expect(lane.code).toBe(0);
    expect(lane.emitted).toBe(`cd '${join(entry, "ui")}'\n`);
    const infoJson = JSON.parse(work(["info", "--json"], { cwd: join(entry, "ui") }).stdout);
    expect(infoJson.lanes.map((l: { name: string; parent: string | null; branch: string }) => [l.name, l.parent, l.branch])).toEqual([
      ["root", null, "IMG-9-feat"],
      ["ui", "root", "IMG-9-feat-ui"],
    ]);
    expect(infoJson.lanes[1].repos[0]).toMatchObject({ repo: "app", ahead: 0, behind: 0, dirty: false });
    // lane on trunk explicitly
    work(["lane", "docs", "--on", "trunk", "app"], { cwd: entry });
    const again = JSON.parse(work(["info", "--json"], { cwd: entry }).stdout);
    expect(again.lanes.find((l: { name: string }) => l.name === "docs").parent).toBeNull();
    expect(readFileSync(join(entry, "ui", "AGENTS.md"), "utf8")).toContain("Branch: `IMG-9-feat-ui`");
  });

  test("mv promotes an entry, repairs worktrees and follows the cwd", () => {
    const app = makeRemote(sb, "app");
    const checkout = work(["clone", app, "exp"]).stdout.trim();
    const r = work(["mv", "labs", "--prefix", "IMG-7"], { cwd: checkout, wrapper: true });
    expect(r.code).toBe(0);
    const moved = join(sb.root, "labs", "IMG-7-exp", "root", "app");
    expect(r.emitted).toBe(`cd '${moved}'\n`);
    expect(g(moved, "status", "--porcelain")).toBe("");
    const store = join(sb.root, ".repos", "local", "remotes", "app.git");
    expect(g(store, "worktree", "list")).toContain(moved);
    expect(existsSync(join(sb.root, "tries", "exp"))).toBe(false);
  });

  test("archive / unarchive keep worktrees working", () => {
    const app = makeRemote(sb, "app");
    const checkout = work(["clone", app, "old"]).stdout.trim();
    expect(work(["archive", "old"]).code).toBe(0);
    const archived = join(sb.root, "tries", ".archive", "old", "root", "app");
    expect(g(archived, "status", "--porcelain")).toBe("");
    expect(JSON.parse(work(["ls", "--json"]).stdout)).toEqual([]);
    expect(JSON.parse(work(["ls", "--json", "--archived"]).stdout)[0].name).toBe("old");
    expect(work(["unarchive", "old"]).stdout.trim()).toBe(join(sb.root, "tries", "old"));
    expect(g(checkout, "status", "--porcelain")).toBe("");
  });

  test("rm refuses dirty work, needs --yes without a TTY, prunes worktrees", () => {
    const app = makeRemote(sb, "app");
    const checkout = work(["clone", app, "gone"]).stdout.trim();
    writeFileSync(join(checkout, "wip.txt"), "wip");
    const refused = work(["rm", "gone"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("uncommitted changes");
    const noYes = work(["rm", "gone", "--force"]);
    expect(noYes.stderr).toContain("pass --yes");
    expect(work(["rm", "gone", "--force", "--yes"]).code).toBe(0);
    expect(existsSync(join(sb.root, "tries", "gone"))).toBe(false);
    const store = join(sb.root, ".repos", "local", "remotes", "app.git");
    expect(g(store, "worktree", "list")).not.toContain("gone");
  });

  test("rm ./lane from inside the entry", () => {
    const app = makeRemote(sb, "app");
    const entry = work(["new", "e"]).stdout.trim();
    work(["add", app], { cwd: entry });
    work(["lane", "ui"], { cwd: join(entry, "root") });
    expect(work(["rm", "./ui", "--yes"], { cwd: entry }).code).toBe(0);
    expect(existsSync(join(entry, "ui"))).toBe(false);
    expect(JSON.parse(work(["info", "--json"], { cwd: entry }).stdout).lanes.map((l: { name: string }) => l.name)).toEqual(["root"]);
  });
});

describe("shell integration", () => {
  for (const shell of ["zsh", "bash"]) {
    test(`${shell}: shortcut creates and cds, back returns, completion answers`, () => {
      const init = work(["init", sb.root, "--shortcut", "tries", "--shortcut", "labs"]).stdout;
      const rc = join(sb.dir, `init.${shell}`);
      writeFileSync(rc, init);
      const script = `
        . ${rc}
        tries new alpha >/dev/null 2>&1; echo "PWD1=$PWD"
        labs new beta >/dev/null 2>&1; echo "PWD2=$PWD"
        work - >/dev/null 2>&1; echo "PWD3=$PWD"
        work ls --json | grep -c '"name"'
      `;
      const p = Bun.spawnSync([shell, "-c", script], {
        cwd: sb.dir,
        env: { ...(process.env as Record<string, string>), ...GIT_ENV, WORK_TODAY: TODAY, HOME: sb.dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const outText = p.stdout.toString();
      expect(outText).toContain(`PWD1=${join(sb.root, "tries", `${TODAY}-alpha`)}`);
      expect(outText).toContain(`PWD2=${join(sb.root, "labs", `${TODAY}-beta`)}`);
      expect(outText).toContain(`PWD3=${join(sb.root, "tries", `${TODAY}-alpha`)}`);
      expect(outText.trim().split("\n").pop()).toBe("2");
    });
  }

  test("__complete: subcommands, spaces, entries of a shortcut space, flags", () => {
    mkdirSync(join(sb.root, "tries", "2026-09-01-redis"), { recursive: true });
    mkdirSync(join(sb.root, "labs", "IMG-1-x"), { recursive: true });
    const c = (cmd: string, space: string, ...words: string[]) =>
      work(["__complete", "--shell", "bash", "--cmd", cmd, "--space", space, "--", ...words]).stdout.trim().split("\n");
    expect(c("work", "", "")).toEqual(expect.arrayContaining(["labs/", "tries/", "add", "lane", "sync"]));
    expect(c("tries", "tries", "red")).toEqual(["2026-09-01-redis"]);
    expect(c("work", "", "labs/")).toEqual(["labs/IMG-1-x"]);
    expect(c("work", "", "--space", "")).toEqual(["labs", "tries"]);
    expect(c("work", "", "mv", "IMG", "")).toEqual(expect.arrayContaining(["labs/", "tries/"]));
    expect(c("work", "", "add", "./")).toEqual([":files"]);
  });
});
