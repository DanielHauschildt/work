import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commit, g, GIT_ENV, makeRemote, type Sandbox, sandbox, sh } from "./helpers.ts";

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

  test("ls --json lists workspaces across spaces", () => {
    work(["new", "a"]);
    work(["new", "--space", "labs", "b"]);
    const list = JSON.parse(work(["ls", "--json"]).stdout) as { space: string; name: string }[];
    expect(list.map((e) => `${e.space}/${e.name}`).sort()).toEqual([`labs/${TODAY}-b`, `tries/${TODAY}-a`]);
  });

  test("back goes to the previous workspace", () => {
    const a = work(["new", "a"]).stdout.trim();
    const b = work(["new", "b"]).stdout.trim();
    expect(work(["back"], { cwd: b }).stdout.trim()).toBe(a);
    expect(work(["-"], { cwd: a }).stdout.trim()).toBe(b);
  });
});

describe("repos", () => {
  test("clone URL (and URL shorthand) → workspace named like try, worktree in root lane", () => {
    const app = makeRemote(sb, "app");
    const r = work(["clone", app], { wrapper: true });
    expect(r.code).toBe(0);
    const workspace = join(sb.root, "tries", `${TODAY}-remotes-app`);
    expect(r.emitted).toBe(`cd '${join(workspace, "app")}'\n`);
    expect(g(join(workspace, "app"), "branch", "--show-current")).toBe("remotes-app");
    const r2 = work([app, "custom"]);
    expect(r2.stdout.trim()).toBe(join(sb.root, "tries", "custom", "app"));
  });

  test("`.` requires a name; creates a worktree of the current repo on a named branch", () => {
    const app = makeRemote(sb, "app");
    const repo = join(sb.dir, "seed-app");
    const bare = work(["."], { cwd: repo });
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("'work .' requires a name argument");
    const r = work([".", "exp"], { cwd: repo });
    const worktree = join(sb.root, "tries", `${TODAY}-exp`, "seed-app");
    expect(r.stdout.trim()).toBe(worktree);
    expect(g(worktree, "branch", "--show-current")).toBe("exp");
    // second time: versioned name like try
    expect(work([".", "exp"], { cwd: repo }).stdout.trim()).toBe(join(sb.root, "tries", `${TODAY}-exp-2`, "seed-app"));
    // outside a repo: just a folder
    expect(work(["./remotes", "plain"]).stdout.trim()).toBe(join(sb.root, "tries", `${TODAY}-plain`));
    // try's `worktree` command is gone ("worktree" is a repo folder of a lane)
    for (const args of [["worktree", "dir", "x"], ["exec", "worktree", "dir"]]) {
      const removed = work(args, { cwd: repo });
      expect(removed.code).toBe(1);
      expect(removed.stderr).toContain("`work worktree` was removed; use `work . <name>` or `work ./path [name]`");
    }
    expect(existsSync(join(sb.root, "tries", `${TODAY}-x`))).toBe(false);
    void app;
  });

  test("add + lane inside a workspace, info --json", () => {
    const app = makeRemote(sb, "app");
    const workspace = work(["new", "--space", "labs", "--prefix", "IMG-9", "feat"]).stdout.trim();
    const worktree = work(["add", app], { cwd: workspace }).stdout.trim();
    expect(worktree).toBe(join(workspace, "app"));
    commit(worktree, "x.txt", "x");
    const lane = work(["lane", "ui"], { cwd: worktree, wrapper: true });
    expect(lane.code).toBe(0);
    expect(lane.emitted).toBe(`cd '${join(workspace, "app@ui")}'\n`);
    const infoJson = JSON.parse(work(["info", "--json"], { cwd: join(workspace, "app@ui") }).stdout);
    expect(infoJson.lanes.map((l: { name: string; parent: string | null; branch: string }) => [l.name, l.parent, l.branch])).toEqual([
      ["root", null, "IMG-9-feat"],
      ["ui", "root", "IMG-9-feat-ui"],
    ]);
    expect(infoJson.lanes[1].repos[0]).toMatchObject({ repo: "app", folder: "app@ui", ahead: 0, behind: 0, dirty: false });
    // lane on trunk explicitly; the new lane's worktrees are printed and cd'd into
    const docs = work(["lane", "docs", "--on", "trunk", "app"], { cwd: workspace });
    expect(docs.stdout.trim()).toBe(join(workspace, "app@docs"));
    const again = JSON.parse(work(["info", "--json"], { cwd: workspace }).stdout);
    expect(again.lanes.find((l: { name: string }) => l.name === "docs").parent).toBeNull();
    // one AGENTS.md for the whole workspace; worktrees stay clean
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain("| `ui` | `IMG-9-feat-ui` | root | `app@ui/` |");
    expect(existsSync(join(workspace, "app@ui", "AGENTS.md"))).toBe(false);
    expect(g(join(workspace, "app@ui"), "status", "--porcelain")).toBe("");
  });

  test("mv promotes a workspace, repairs worktrees and follows the cwd", () => {
    const app = makeRemote(sb, "app");
    const worktree = work(["clone", app, "exp"]).stdout.trim();
    const r = work(["mv", "labs", "--prefix", "IMG-7"], { cwd: worktree, wrapper: true });
    expect(r.code).toBe(0);
    const moved = join(sb.root, "labs", "IMG-7-exp", "app");
    expect(r.emitted).toBe(`cd '${moved}'\n`);
    expect(g(moved, "status", "--porcelain")).toBe("");
    const store = join(sb.root, ".repos", "local", "remotes", "app.git");
    expect(g(store, "worktree", "list")).toContain(moved);
    expect(existsSync(join(sb.root, "tries", "exp"))).toBe(false);
  });

  test("archive / unarchive keep worktrees working", () => {
    const app = makeRemote(sb, "app");
    const worktree = work(["clone", app, "old"]).stdout.trim();
    expect(work(["archive", "old"]).code).toBe(0);
    const archived = join(sb.root, "tries", ".archive", "old", "app");
    expect(g(archived, "status", "--porcelain")).toBe("");
    expect(JSON.parse(work(["ls", "--json"]).stdout)).toEqual([]);
    expect(JSON.parse(work(["ls", "--json", "--archived"]).stdout)[0].name).toBe("old");
    expect(work(["unarchive", "old"]).stdout.trim()).toBe(join(sb.root, "tries", "old"));
    expect(g(worktree, "status", "--porcelain")).toBe("");
  });

  test("rm refuses dirty work, needs --yes without a TTY, prunes worktrees", () => {
    const app = makeRemote(sb, "app");
    const worktree = work(["clone", app, "gone"]).stdout.trim();
    writeFileSync(join(worktree, "wip.txt"), "wip");
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

  test("rm ./lane and rm ./<repo>@<lane> from inside the workspace", () => {
    const app = makeRemote(sb, "app");
    const docs = makeRemote(sb, "docs");
    const workspace = work(["new", "e"]).stdout.trim();
    work(["add", app], { cwd: workspace });
    work(["add", docs], { cwd: workspace });
    // the lane of the cwd comes from its @suffix
    work(["lane", "ui"], { cwd: join(workspace, "app") });
    expect(work(["lane", "polish"], { cwd: join(workspace, "app@ui") }).code).toBe(0);
    expect(existsSync(join(workspace, "docs@polish"))).toBe(true);
    // one worktree of a lane
    expect(work(["rm", "./docs@polish", "--yes"], { cwd: workspace }).code).toBe(0);
    expect(existsSync(join(workspace, "docs@polish"))).toBe(false);
    expect(existsSync(join(workspace, "app@polish"))).toBe(true);
    // the whole lane
    expect(work(["rm", "./ui", "--yes"], { cwd: workspace }).code).toBe(0);
    expect(existsSync(join(workspace, "app@ui"))).toBe(false);
    expect(existsSync(join(workspace, "docs@ui"))).toBe(false);
    const lanes = JSON.parse(work(["info", "--json"], { cwd: workspace }).stdout).lanes;
    expect(lanes.map((l: { name: string; parent: string | null }) => [l.name, l.parent])).toEqual([
      ["root", null],
      ["polish", "root"], // re-parented when its parent lane went
    ]);
  });

  test("path and info name worktree folders", () => {
    const app = makeRemote(sb, "app");
    const workspace = work(["new", "--space", "labs", "--prefix", "IMG-3", "flat"]).stdout.trim();
    work(["add", app], { cwd: workspace });
    work(["lane", "ui"], { cwd: workspace });
    expect(work(["path", "flat", "app@ui"]).stdout.trim()).toBe(join(workspace, "app@ui"));
    expect(work(["path", "flat", "ui"]).stdout.trim()).toBe(join(workspace, "app@ui")); // bare lane: unique worktree
    expect(work(["path", "flat", "nope"]).code).toBe(1);
    const info = work(["info", "flat"]).stdout;
    expect(info).toContain("  ui  IMG-3-flat-ui  on root");
    expect(info).toContain("    app@ui/  IMG-3-flat-ui");
  });
});

describe("migrate", () => {
  test("old lane folders are refused, migrate moves them and the cwd follows", () => {
    const app = makeRemote(sb, "app");
    const worktree = work(["clone", app, "exp"]).stdout.trim();
    const ws = join(sb.root, "tries", "exp");
    // put the worktree back into the layout work used before: <workspace>/<lane>/<repo>
    const old = join(ws, "root", "app");
    mkdirSync(join(ws, "root"));
    sh(["git", "-C", worktree, "worktree", "move", worktree, old]);

    const refused = work(["add", app], { cwd: old });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("still uses lane folders (root) — run `work migrate` first");

    const migrated = work(["migrate"], { cwd: old, wrapper: true });
    expect(migrated.code).toBe(0);
    expect(migrated.stderr).toContain("tries/exp: app");
    expect(migrated.emitted).toBe(`cd '${worktree}'\n`); // the cwd follows into the moved worktree
    expect(existsSync(join(ws, "root"))).toBe(false);
    expect(g(worktree, "branch", "--show-current")).toBe("exp");

    expect(work(["migrate", "--all"]).stderr).toContain("Nothing to migrate.");
    expect(work(["lane", "ui"], { cwd: worktree }).code).toBe(0);
    expect(existsSync(join(ws, "app@ui"))).toBe(true);
  });
});

describe("spaces", () => {
  test("space new / set / ls", () => {
    expect(work(["space", "new", "clients", "--prefix", "none"]).code).toBe(0);
    expect(readFileSync(join(sb.root, "clients", ".space.toml"), "utf8")).toBe('prefix = ""\n');
    expect(work(["space", "new", "clients"]).stderr).toContain("already exists");
    expect(work(["space", "new", ".hidden"]).code).toBe(1);
    work(["space", "new", "labs"]);
    expect(existsSync(join(sb.root, "labs", ".space.toml"))).toBe(false);
    writeFileSync(join(sb.root, "labs", ".space.toml"), 'template = "tpl"\n');
    expect(work(["space", "set", "labs", "--prefix", "IMG"]).code).toBe(0);
    expect(readFileSync(join(sb.root, "labs", ".space.toml"), "utf8")).toBe('template = "tpl"\nprefix = "IMG"\n');
    const list = JSON.parse(work(["space", "--json"]).stdout) as { space: string; prefix: string }[];
    expect(list.map((r) => [r.space, r.prefix])).toEqual([
      ["clients", ""],
      ["labs", "IMG"],
    ]);
    expect(work(["space", "set", "nope", "--prefix", "x"]).code).toBe(1);
    expect(work(["new", "--space", "clients", "acme"]).stdout.trim()).toBe(join(sb.root, "clients", "acme"));
  });

  test("picker: second create row makes an undated workspace", () => {
    mkdirSync(join(sb.root, "tries"), { recursive: true });
    const r = work(["exec", "--space", "tries", "--and-keys", "TYPE=idea,DOWN,ENTER"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.root, "tries", "IDEA"))).toBe(true); // try's TYPE= token upper-cases
    const r2 = work(["exec", "--space", "tries", "--and-keys", "TYPE=other,CTRL-T"]);
    expect(r2.code).toBe(0);
    expect(existsSync(join(sb.root, "tries", `${TODAY}-OTHER`))).toBe(true);
  });

  test("picker: space/name creates in a new space and asks its default prefix", () => {
    mkdirSync(join(sb.root, "tries"), { recursive: true });
    // first create row (dated), then choose "no date" as the space default
    const r = work(["exec", "--and-keys", "TYPE=clients/acme,ENTER,DOWN,ENTER"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.root, "CLIENTS", `${TODAY}-ACME`))).toBe(true);
    expect(readFileSync(join(sb.root, "CLIENTS", ".space.toml"), "utf8")).toBe('prefix = ""\n');
  });

  test("picker: + new tab creates a space and stays open in it", () => {
    mkdirSync(join(sb.root, "tries"), { recursive: true });
    // scopes: all, tries, + new → two Tabs; name; Enter; keep "date"; then create a workspace there
    const r = work(["exec", "--and-keys", "TAB,TAB,TYPE=labs,ENTER,ENTER,TYPE=x,CTRL-T"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(sb.root, "LABS", ".space.toml"), "utf8")).toBe('prefix = "auto"\n');
    expect(existsSync(join(sb.root, "LABS", `${TODAY}-X`))).toBe(true);
  });

  test("space names: whitespace → dashes (trimmed, case kept) for space new/set, --space and mv", () => {
    const created = work(["space", "new", "  My   space ", "--json"]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({ space: "My-space", path: join(sb.root, "My-space") });
    expect(work(["space", "set", "My space", "--prefix", "none"]).code).toBe(0);
    expect(readFileSync(join(sb.root, "My-space", ".space.toml"), "utf8")).toBe('prefix = ""\n');
    expect(work(["new", "--space", "My space", "a"]).stdout.trim()).toBe(join(sb.root, "My-space", "a"));
    expect(work(["new", "--space", "other space", "b"]).stdout.trim()).toBe(join(sb.root, "other-space", `${TODAY}-b`));
    expect(work(["mv", "My-space/a", "third space"]).code).toBe(0);
    expect(existsSync(join(sb.root, "third-space", "a"))).toBe(true);
    // an existing folder with a space in its name is used as typed
    mkdirSync(join(sb.root, "Old Stuff"));
    expect(work(["new", "--space", "Old Stuff", "c"]).stdout.trim()).toBe(join(sb.root, "Old Stuff", `${TODAY}-c`));
  });

  test("space names match existing spaces ignoring case; the folder's own name is used", () => {
    work(["space", "new", "labs"]);
    mkdirSync(join(sb.root, "Old Stuff"));
    mkdirSync(join(sb.root, "tries", "w"), { recursive: true });
    const spaces = () => readdirSync(sb.root).filter((n) => !n.startsWith("."));
    expect(work(["new", "--space", "LABS", "x"]).stdout.trim()).toBe(join(sb.root, "labs", `${TODAY}-x`));
    expect(work(["new", "--space", " Labs ", "--json", "y"]).stdout).toContain(`"space":"labs"`);
    expect(work(["new", "--space", "old stuff", "z"]).stdout.trim()).toBe(join(sb.root, "Old Stuff", `${TODAY}-z`));
    const set = work(["space", "set", "Labs", "--prefix", "none"]);
    expect(set.code).toBe(0);
    expect(set.stderr).toContain("labs: prefix none");
    expect(readFileSync(join(sb.root, "labs", ".space.toml"), "utf8")).toBe('prefix = ""\n');
    const mv = work(["mv", "tries/w", "Labs/moved", "--json"]);
    expect(JSON.parse(mv.stdout).path).toBe(join(sb.root, "labs", "moved"));
    const dup = work(["space", "new", "Labs"]);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("space labs already exists");
    expect(spaces().sort()).toEqual(["Old Stuff", "labs", "tries"]);
  });

  test("space names still invalid after normalizing say why", () => {
    mkdirSync(join(sb.root, "tries", "w"), { recursive: true });
    const cases: [string[], string][] = [
      [["space", "new", "a!b"], "a!b"],
      [["space", "new", "_x y"], "_x-y"],
      [["new", "--space", "a!b", "x"], "a!b"],
      [["mv", "tries/w", "a!b"], "a!b"],
    ];
    for (const [args, name] of cases) {
      const r = work(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Invalid space name "${name}": use letters, digits, . _ - (not starting with . or -)`);
    }
    expect(existsSync(join(sb.root, "a!b"))).toBe(false);
    expect(existsSync(join(sb.root, "tries", "w"))).toBe(true);
  });

  test("picker: whitespace in a new space name (+ new tab and space/ query)", () => {
    mkdirSync(join(sb.root, "tries"), { recursive: true });
    // try's TYPE= token upper-cases: "my space" → "MY SPACE" → MY-SPACE
    const tab = work(["exec", "--and-keys", "TAB,TAB,TYPE=my space,ENTER,ENTER,TYPE=x,CTRL-T"]);
    expect(tab.code).toBe(0);
    expect(existsSync(join(sb.root, "MY-SPACE", `${TODAY}-X`))).toBe(true);
    const query = work(["exec", "--and-keys", "TYPE=new space/acme,ENTER,ENTER"]);
    expect(query.code).toBe(0);
    expect(existsSync(join(sb.root, "NEW-SPACE", `${TODAY}-ACME`))).toBe(true);
  });
});

describe("picker: start tab and lanes", () => {
  const RIGHT = "\x1b[C";
  const DOWN = "\x1b[B";
  const CTRL_D = "\x04";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI
  const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const header = (r: Res) => plain(r.stderr).split("\n")[0];

  test("start tab follows the cwd's space, the current workspace is preselected, --space wins", () => {
    for (const d of ["tries/a", "labs/b", "labs/c/deep"]) mkdirSync(join(sb.root, d), { recursive: true });
    const inside = work(["--and-exit"], { cwd: join(sb.root, "labs", "c", "deep") });
    expect(header(inside)).toContain("[labs]");
    expect(plain(inside.stderr)).toMatch(/\n→ 📁 c +/);
    expect(header(work(["--and-exit"], { cwd: join(sb.root, "labs") }))).toContain("[labs]");
    expect(header(work(["--and-exit"]))).toContain("[all]");
    expect(header(work(["--space", "tries", "--and-exit"], { cwd: join(sb.root, "labs", "c") }))).toContain("[tries]");
    // creation targets the cwd's space
    const created = work(["--and-keys", "x\r"], { cwd: join(sb.root, "labs", "b"), wrapper: true });
    expect(created.code).toBe(0);
    expect(created.emitted).toBe(`cd '${join(sb.root, "labs", `${TODAY}-x`)}'\n`);
  });

  test("→ on a workspace without lanes shows a hint", () => {
    mkdirSync(join(sb.root, "tries", "plain"), { recursive: true });
    const r = work(["--and-keys", RIGHT], { cwd: join(sb.root, "tries", "plain") });
    expect(plain(r.stderr)).toContain("\nno lanes — work add <repo>\n");
  });

  test("→ worktrees: Enter cds into one, a new lane is created after the picker, Ctrl-D + YES removes its lane", () => {
    const app = makeRemote(sb, "app");
    const worktree = work(["clone", app, "exp"]).stdout.trim();
    const ws = join(sb.root, "tries", "exp");
    expect(worktree).toBe(join(ws, "app"));

    const cd = work(["--and-keys", `${RIGHT}\r`], { cwd: ws, wrapper: true });
    expect(cd.code).toBe(0);
    expect(cd.emitted).toBe(`cd '${join(ws, "app")}'\n`);
    // history records the workspace, not the worktree
    const last = readFileSync(join(sb.root, ".work", "history.jsonl"), "utf8").trim().split("\n").at(-1)!;
    expect(JSON.parse(last).p).toBe("tries/exp");

    // typed in the worktree view: new lane "ui" on the highlighted row's lane (root), with root's repos
    const lane = work(["--and-keys", `${RIGHT}ui\r`], { cwd: worktree, wrapper: true });
    expect(lane.code).toBe(0);
    expect(lane.emitted).toBe(`cd '${join(ws, "app@ui")}'\n`);
    expect(g(join(ws, "app@ui"), "branch", "--show-current")).toBe("exp-ui");
    const model = () => JSON.parse(readFileSync(join(ws, ".work.json"), "utf8"));
    expect(model().lanes.ui.parent).toBe("root");

    // the view lists one row per worktree, lanes parents first
    const view = work(["--and-keys", RIGHT], { cwd: ws });
    const lines = plain(view.stderr).split("\n");
    expect(lines).toContain("📁 work › tries › exp");
    expect(lines).toContain("→ 📁 app     exp     on main");
    expect(lines).toContain("  📁 app@ui  exp-ui  on root");

    const keep = work(["--and-keys", `${RIGHT}${DOWN}${CTRL_D}NO\r`], { cwd: join(ws, "app@ui") });
    expect(keep.code).toBe(1);
    expect(plain(keep.stderr)).toContain("Remove cancelled");
    expect(existsSync(join(ws, "app@ui"))).toBe(true);

    const rm = work(["--and-keys", `${RIGHT}${DOWN}${CTRL_D}YES\r`], { cwd: join(ws, "app@ui"), wrapper: true });
    expect(rm.code).toBe(0);
    expect(existsSync(join(ws, "app@ui"))).toBe(false);
    expect(model().lanes.ui).toBeUndefined();
    expect(rm.emitted).toBe(`cd '${ws}'\n`);
    expect(g(join(ws, "app"), "worktree", "list")).not.toContain("app@ui");
  });

  test("creating a lane that fails reports the error like other commands", () => {
    const app = makeRemote(sb, "app");
    work(["clone", app, "exp"]);
    const ws = join(sb.root, "tries", "exp");
    mkdirSync(join(ws, "app@stray"));
    writeFileSync(join(ws, "app@stray", "file.txt"), "in the way");
    const r = work(["--and-keys", `${RIGHT}stray\r`], { cwd: ws });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("app@stray");
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

  test("__complete: subcommands, spaces, workspaces of a shortcut space, flags", () => {
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
