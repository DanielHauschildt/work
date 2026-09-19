import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitDashDash, takeFlag, takeOption, takeOptions } from "../src/args.ts";
import { Emitter, q, qFish } from "../src/emit.ts";
import { History } from "../src/history.ts";
import { initScript, parseShortcuts } from "../src/init.ts";
import { withLock } from "../src/lock.ts";
import {
  cloneDirName,
  isGitUri,
  laneBranch,
  parseGitUri,
  prefixText,
  sanitizeRef,
  stripDate,
  versionedBase,
} from "../src/naming.ts";
import { Root } from "../src/root.ts";
import { type Sandbox, sandbox, sh } from "./helpers.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  process.env.WORK_TODAY = "2026-09-19";
});
afterEach(() => {
  delete process.env.WORK_TODAY;
  sb.cleanup();
});

describe("naming", () => {
  test("prefix settings", () => {
    expect(prefixText(undefined)).toBe("2026-09-19-");
    expect(prefixText("auto")).toBe("2026-09-19-");
    expect(prefixText("")).toBe("");
    expect(prefixText("none")).toBe("");
    expect(prefixText("IMG-1234")).toBe("IMG-1234-");
  });

  test("branch names drop the date and suffix non-root lanes", () => {
    expect(laneBranch("2026-09-19-redis-bench", "root")).toBe("redis-bench");
    expect(laneBranch("IMG-1234-autofit", "root")).toBe("IMG-1234-autofit");
    expect(laneBranch("IMG-1234-autofit", "ui")).toBe("IMG-1234-autofit-ui");
    expect(stripDate("2026-09-19-x")).toBe("x");
    expect(sanitizeRef("a b~c^d:e?f*g[h\\i..j.lock")).toBe("a-b-c-d-e-f-g-h-i.j");
  });

  test("try URL detection and parsing", () => {
    for (const u of ["https://github.com/tobi/try.git", "git@github.com:tobi/try.git", "https://gitlab.com/a/b", "x.git", "file:///tmp/r.git"])
      expect(isGitUri(u)).toBe(true);
    expect(isGitUri("redis")).toBe(false);
    expect(parseGitUri("https://github.com/tobi/try.git")).toEqual({ host: "github.com", user: "tobi", repo: "try" });
    expect(parseGitUri("git@github.com:tobi/try.git")).toEqual({ host: "github.com", user: "tobi", repo: "try" });
    expect(parseGitUri("https://gitlab.com/u/r.git")).toEqual({ host: "gitlab.com", user: "u", repo: "r" });
    expect(parseGitUri("git@host.com:u/r.git")).toEqual({ host: "host.com", user: "u", repo: "r" });
    expect(parseGitUri("/tmp/remotes/app.git")).toEqual({ host: "local", user: "remotes", repo: "app" });
    expect(cloneDirName("https://github.com/tobi/try.git", undefined, "2026-09-19-")).toBe("2026-09-19-tobi-try");
    expect(cloneDirName("https://github.com/tobi/try.git", "my-fork", "2026-09-19-")).toBe("my-fork");
  });

  test("try's name versioning", () => {
    const dir = sb.dir;
    expect(versionedBase(dir, "2026-09-19-", "foo")).toBe("foo");
    mkdirSync(join(dir, "2026-09-19-foo"));
    expect(versionedBase(dir, "2026-09-19-", "foo")).toBe("foo-2");
    mkdirSync(join(dir, "2026-09-19-v1"));
    mkdirSync(join(dir, "2026-09-19-v2"));
    expect(versionedBase(dir, "2026-09-19-", "v1")).toBe("v3");
  });
});

describe("args", () => {
  test("options anywhere, last wins, = form", () => {
    const a = ["x", "--path", "/a", "y", "--path=/b"];
    expect(takeOption(a, "--path")).toBe("/b");
    expect(a).toEqual(["x", "y"]);
    const b = ["--prefix", "", "n"];
    expect(takeOption(b, "--prefix")).toBe("");
    expect(takeOption(b, "--nope")).toBeUndefined();
    const c = ["--shortcut", "tries", "--shortcut=try=tries"];
    expect(takeOptions(c, "--shortcut")).toEqual(["tries", "try=tries"]);
    const d = ["-y", "a", "--yes"];
    expect(takeFlag(d, "--yes", "-y")).toBe(true);
    expect(d).toEqual(["a"]);
    expect(splitDashDash(["a", "--", "--x"])).toEqual([["a"], ["--x"]]);
  });
});

describe("emit", () => {
  test("quoting", () => {
    expect(q("it's")).toBe(`'it'"'"'s'`);
    expect(qFish("it's\\")).toBe(`'it\\'s\\\\'`);
  });

  test("modes", () => {
    expect(new Emitter({ exec: true, env: {} }).mode).toBe("exec");
    expect(new Emitter({ exec: false, env: { WORK_EMIT: "/x" } }).mode).toBe("file");
    expect(new Emitter({ exec: false, env: {} }).mode).toBe("direct");
    const e = new Emitter({ exec: false, env: { WORK_EMIT: "/x", WORK_SHELL: "fish" } });
    e.cd("/a b/it's");
    expect(e.script()).toBe("cd '/a b/it\\'s'\n");
  });
});

describe("history", () => {
  test("records visits, previous workspace, rename", () => {
    const root = new Root(sb.root);
    const h = new History(root);
    const a = join(root.path, "tries", "a");
    const b = join(root.path, "tries", "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    h.record(a, 1000);
    h.record(b, 2000);
    expect(h.previous(b)).toBe(a);
    expect(h.previous(a)).toBe(b);
    expect(h.lastVisits().get(b)!.getTime()).toBe(2000);
    const c = join(root.path, "labs", "b");
    h.rename(b, c);
    expect(h.lastVisits().get(c)!.getTime()).toBe(2000);
  });
});

describe("lock", () => {
  test("re-entrant, removes the file, breaks stale locks", () => {
    const stateDir = join(sb.dir, ".work");
    const inner = withLock(stateDir, "k", () => withLock(stateDir, "k", () => 42));
    expect(inner).toBe(42);
    expect(readdirSync(join(stateDir, "locks"))).toEqual([]);
    // stale lock from a dead pid
    const { createHash } = require("node:crypto");
    const file = join(stateDir, "locks", `${createHash("sha1").update("k").digest("hex").slice(0, 16)}.lock`);
    writeFileSync(file, JSON.stringify({ pid: 999999, t: 0 }));
    expect(withLock(stateDir, "k", () => "ok")).toBe("ok");
    expect(existsSync(file)).toBe(false);
  });

  test("serializes concurrent processes", async () => {
    const stateDir = join(sb.dir, ".work");
    const counter = join(sb.dir, "counter");
    writeFileSync(counter, "0");
    const script = join(sb.dir, "inc.ts");
    writeFileSync(
      script,
      `import { withLock } from ${JSON.stringify(join(import.meta.dir, "../src/lock.ts"))};
import { readFileSync, writeFileSync } from "node:fs";
for (let i = 0; i < 20; i++) withLock(${JSON.stringify(stateDir)}, "c", () => {
  const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
  Bun.sleepSync(1);
  writeFileSync(${JSON.stringify(counter)}, String(n + 1));
});`,
    );
    const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", script], { stdout: "ignore", stderr: "inherit" }));
    await Promise.all(procs.map((p) => p.exited));
    expect(require("node:fs").readFileSync(counter, "utf8")).toBe("80");
  });
});

describe("init", () => {
  const self = ["/usr/local/bin/work"];
  test("shortcuts", () => {
    expect(parseShortcuts(["tries", "try=tries"])).toEqual([
      { name: "tries", space: "tries" },
      { name: "try", space: "tries" },
    ]);
    expect(() => parseShortcuts(["bad name"])).toThrow();
  });

  for (const shell of ["zsh", "bash"]) {
    test(`${shell} script parses and defines functions`, () => {
      const script = initScript({ root: "/r o/Work", shortcuts: parseShortcuts(["tries", "labs"]), shell: "sh", self });
      const file = join(sb.dir, "init.sh");
      writeFileSync(file, script);
      sh([shell, "-n", file]);
      const out = sh([shell, "-c", `. ${file}; type work tries labs; __work_space_for labs`]);
      expect(out).toContain("labs");
      expect(script).toContain("--path '/r o/Work'");
    });
  }

  test("fish script parses", () => {
    if (!Bun.which("fish")) return;
    const file = join(sb.dir, "init.fish");
    writeFileSync(file, initScript({ root: "/r/Work", shortcuts: parseShortcuts(["tries"]), shell: "fish", self }));
    sh(["fish", "-n", file]);
  });
});
