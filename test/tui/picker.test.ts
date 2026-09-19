import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type PickerItem, parseTestKeys, runPicker } from "../../src/tui/index.ts";
import { capture, pick, plain, tmpRoot, today } from "./helpers.ts";

const NOW = new Date("2026-09-19T12:00:00Z");
const HOUR = 3_600_000;

let root: string;
let items: PickerItem[];
const saved = { w: process.env.WORK_WIDTH, h: process.env.WORK_HEIGHT };

function item(space: string, basename: string, ageHours: number, extra: Partial<PickerItem> = {}): PickerItem {
  const path = join(root, space, basename);
  mkdirSync(path, { recursive: true });
  return { basename, path, space, recency: new Date(NOW.getTime() - ageHours * HOUR), ...extra };
}

const chars = (s: string) => Array.from(s);
const byName = (name: string) => items.find((i) => i.basename === name)!;

beforeAll(() => {
  process.env.WORK_WIDTH = "80";
  process.env.WORK_HEIGHT = "24";
  root = tmpRoot();
  items = [
    item("tries", "2026-09-18-redis-bench", 2),
    item("tries", "2026-09-01-vector-search", 40),
    item("tries", "notes", 300),
    item("labs", "IMG-1234-autofit", 1),
    item("labs", "IMG-99-labs-thing", 90),
  ];
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved.w === undefined) delete process.env.WORK_WIDTH;
  else process.env.WORK_WIDTH = saved.w;
  if (saved.h === undefined) delete process.env.WORK_HEIGHT;
  else process.env.WORK_HEIGHT = saved.h;
});

const base = () => ({ items, rootPath: root, now: NOW, scopes: ["*", "labs", "tries"] });

/** Frames rendered in force-colors mode, split on the header line. */
function frames(out: string): string[] {
  return plain(out)
    .split("📁 Work Selector")
    .slice(1)
    .map((f) => `📁 Work Selector${f}`);
}

describe("select and filter", () => {
  test("filter + select", async () => {
    const { result } = await pick({ ...base(), scope: "tries", test: { keys: parseTestKeys("TYPE=VEC,ENTER") } });
    expect(result).toEqual({ type: "cd", path: byName("2026-09-01-vector-search").path });
  });

  test("navigate down + select, sorted by score", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: parseTestKeys("DOWN,ENTER") } });
    expect(result).toEqual({ type: "cd", path: byName("2026-09-01-vector-search").path });
    const first = frames(out)[0]!;
    expect(first.indexOf("redis-bench")).toBeLessThan(first.indexOf("vector-search"));
    expect(first.indexOf("vector-search")).toBeLessThan(first.indexOf("notes"));
    expect(first).not.toContain("autofit");
  });

  test("initial query (whitespace -> dash) filters, never auto-selects", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", query: "vector  search", test: { renderOnce: true } });
    expect(result).toBeNull();
    const f = frames(out);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("Search: vector-search");
    expect(f[0]).toContain("vector-search");
    expect(f[0]).not.toContain("redis-bench");
    expect(f[0]).toContain(`📂 Create new: ${today()}-vector-search`);
  });

  test("initialInput overrides the query", async () => {
    const { out } = await pick({ ...base(), scope: "tries", query: "redis", initialInput: "no tes", test: { renderOnce: true } });
    expect(plain(out)).toContain("Search: no-tes");
  });
});

describe("create", () => {
  test("Enter on Create new", async () => {
    const { result } = await pick({ ...base(), scope: "tries", test: { keys: parseTestKeys("TYPE=ZZ TOP,ENTER") } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: `${today()}-ZZ-TOP` });
  });

  test("Create new uses prefixFor(createSpace(scope))", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "labs",
      prefixFor: (space) => (space === "labs" ? "IMG-1234-" : "x-"),
      createSpace: (scope) => (scope === "*" ? "tries" : scope),
      test: { keys: [...chars("zzz"), "\r"] },
    });
    expect(result).toEqual({ type: "mkdir", space: "labs", name: "IMG-1234-zzz" });
    expect(plain(out)).toContain("📂 Create new: IMG-1234-zzz");
  });

  test("all scope creates in the default space", async () => {
    const { result } = await pick({ ...base(), scope: "*", prefixFor: () => "", test: { keys: [...chars("qq"), "\x14"] } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: "qq" });
  });

  test("Ctrl-T with empty query prompts for a name", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: ["\x14", ...chars("my thing"), "\r"] } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: `${today()}-my-thing` });
    expect(out).toContain("\x1b[2J\x1b[H"); // prompt clears the screen
    expect(out).toContain(`\x1b[1;34mEnter new name\x1b[0m\x1b[39m\x1b[49m\n> \x1b[90m${today()}-\x1b[39m`);
    expect(out).toContain("\x1b[?25h");
  });

  test("Ctrl-T prompt with empty input returns to the list", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: ["\x14", "\r", "\x1b[B", "\r"] } });
    expect(result).toEqual({ type: "cd", path: byName("2026-09-01-vector-search").path });
    expect(frames(out).length).toBeGreaterThanOrEqual(2);
  });
});

describe("delete", () => {
  test("mark + YES returns validated realpaths, warnings shown", async () => {
    const seen: string[][] = [];
    const { result, out } = await pick({
      ...base(),
      scope: "tries",
      deleteWarnings: (paths) => {
        seen.push(paths);
        return ["notes: cesdk-web has uncommitted changes"];
      },
      test: { keys: parseTestKeys("CTRL-D,DOWN,DOWN,CTRL-D,ENTER,Y,E,S,ENTER") },
    });
    const paths = [byName("2026-09-18-redis-bench").path, byName("notes").path];
    expect(result).toEqual({ type: "delete", paths });
    expect(seen).toEqual([paths]);
    const p = plain(out);
    expect(p).toContain("DELETE MODE  2 marked  |  Ctrl-D: Toggle  Enter: Confirm  Esc: Cancel");
    expect(p).toContain("Delete 2 Directories\n  📁 2026-09-18-redis-bench\n  📁 notes\n  notes: cesdk-web has uncommitted changes\nType YES to confirm deletion: ");
    expect(p).toContain("🗑️  ");
  });

  test("confirmation via test.confirm", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: ["\x04", "\r"], confirm: "YES" } });
    expect(result).toEqual({ type: "delete", paths: [byName("2026-09-18-redis-bench").path] });
    expect(plain(out)).toContain("Delete 1 Directory\n");
  });

  test("wrong confirmation cancels and clears marks", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: parseTestKeys("CTRL-D,ENTER,Y,E,S,S,ENTER") } });
    expect(result).toBeNull();
    const p = plain(out);
    expect(p).toContain("Delete cancelled");
    // the frame after the cancel shows the status once and is no longer in delete mode
    expect(frames(out).at(-1)).toContain("Delete cancelled");
    expect(frames(out).at(-1)).not.toContain("🗑️");
  });

  test("safety failure: symlink pointing outside the root", async () => {
    const outside = tmpRoot("work-tui-outside-");
    const link = join(root, "tries", "escape");
    symlinkSync(outside, link);
    try {
      const escape: PickerItem = { basename: "escape", path: link, space: "tries", recency: NOW };
      const { result, out } = await pick({
        ...base(),
        items: [escape],
        scope: "tries",
        test: { keys: parseTestKeys("CTRL-D,ENTER,Y,E,S,ENTER") },
      });
      expect(result).toBeNull();
      const p = plain(out);
      expect(p).toContain(`Error: Safety check failed: ${outside} is not inside ${root}`);
      // marks survive a failed check (as in try)
      const errorFrame = frames(out).find((f) => f.includes("Error: Safety check failed"));
      expect(errorFrame).toContain("🗑️");
    } finally {
      rmSync(link);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("safety failure: root itself is not a valid target", async () => {
    const self: PickerItem = { basename: "root", path: root, space: "tries", recency: NOW };
    const { result, out } = await pick({ ...base(), items: [self], scope: "tries", test: { keys: ["\x04", "\r"], confirm: "YES" } });
    expect(result).toBeNull();
    expect(plain(out)).toContain("Error: Safety check failed");
  });

  test("missing folder", async () => {
    const gone: PickerItem = { basename: "gone", path: join(root, "tries", "gone"), space: "tries", recency: NOW };
    const { result, out } = await pick({ ...base(), items: [gone], scope: "tries", test: { keys: ["\x04", "\r"], confirm: "YES" } });
    expect(result).toBeNull();
    expect(plain(out)).toContain(`Error: No such file or directory @ realpath_rec - ${gone.path}`);
  });

  test("Esc leaves delete mode first", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: ["\x04", "\x1b", "\r"] } });
    expect(result).toEqual({ type: "cd", path: byName("2026-09-18-redis-bench").path });
    expect(plain(out)).toContain("DELETE MODE");
  });
});

describe("cancel", () => {
  test("Esc", async () => {
    expect((await pick({ ...base(), scope: "tries", test: { keys: ["\x1b"] } })).result).toBeNull();
  });

  test("Ctrl-C", async () => {
    expect((await pick({ ...base(), scope: "tries", test: { keys: ["\x03"] } })).result).toBeNull();
  });

  test("exhausted keys act as Esc", async () => {
    expect((await pick({ ...base(), scope: "tries", test: { keys: ["\x1b[B"] } })).result).toBeNull();
  });
});

describe("scopes", () => {
  test("Tab / Shift-Tab cycle scopes and reset the cursor", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "*",
      test: { keys: parseTestKeys("DOWN,TAB,TAB,TAB,SHIFT-TAB,SHIFT-TAB,DOWN,TAB,ENTER") },
    });
    const headers = plain(out).match(/📁 Work Selector · \S+/g)!;
    expect(headers.map((h) => h.split(" · ")[1])).toEqual([
      "all",
      "all",
      "labs",
      "tries",
      "all",
      "tries",
      "labs",
      "labs",
      "tries",
    ]);
    // Tab after DOWN resets the cursor to the top row of the new scope
    expect(result).toEqual({ type: "cd", path: byName("2026-09-18-redis-bench").path });
  });

  test("all scope shows a dim space/ prefix; matching uses the basename only", async () => {
    const { out } = await pick({ ...base(), scope: "*", test: { renderOnce: true } });
    expect(out).toContain("\x1b[90mlabs/\x1b[39m");
    expect(out).toContain("\x1b[90mtries/\x1b[39m\x1b[90m2026-09-18\x1b[39m");
    expect(plain(out)).toContain("📁 labs/IMG-1234-autofit");

    const q = await pick({ ...base(), scope: "*", query: "labs", test: { renderOnce: true } });
    const p = plain(q.out);
    expect(p).toContain("IMG-99-labs-thing");
    expect(p).not.toContain("IMG-1234-autofit");
  });

  test("single scope shows no prefix", async () => {
    const { out } = await pick({ ...base(), scope: "labs", test: { renderOnce: true } });
    expect(plain(out)).toContain("📁 IMG-1234-autofit");
    expect(plain(out)).not.toContain("tries");
  });
});

describe("move", () => {
  test("Ctrl-R prompts and returns the typed target", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "tries",
      test: { keys: ["\x1b[B", "\x12", ...chars("labs/vector"), "\r"] },
    });
    expect(result).toEqual({ type: "move", from: byName("2026-09-01-vector-search").path, to: "labs/vector" });
    const p = plain(out);
    expect(p).toContain("Move to (space/name):\ncurrent: tries/2026-09-01-vector-search\n> ");
  });

  test("empty input returns to the list", async () => {
    const { result } = await pick({ ...base(), scope: "tries", test: { keys: ["\x12", "\r", "\r"] } });
    expect(result).toEqual({ type: "cd", path: byName("2026-09-18-redis-bench").path });
  });

  test("Ctrl-R on the Create new row does nothing", async () => {
    const { result } = await pick({ ...base(), scope: "tries", test: { keys: [...chars("zzz"), "\x12", "\r"] } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: `${today()}-zzz` });
  });
});

describe("badges", () => {
  test("badges and stale render dim after the name when they fit", async () => {
    const list = [
      { ...byName("notes"), badges: "2 lanes: cesdk-web docs", stale: true },
      {
        ...byName("2026-09-18-redis-bench"),
        basename: "2026-09-18-a-very-long-name-that-leaves-no-room-for-badges-x",
        badges: "3 lanes",
      },
    ];
    const { out } = await pick({ ...base(), items: list, scope: "tries", test: { renderOnce: true } });
    expect(out).toContain("📁 notes  \x1b[90m2 lanes: cesdk-web docs stale\x1b[39m");
    expect(plain(out)).not.toContain("3 lanes");
    // layout still right-aligns the meta column
    const line = plain(out)
      .split("\n")
      .find((l) => l.includes("notes"))!;
    expect(line.endsWith("1w ago, 0.2")).toBe(true);
  });

  test("async dirty check adds a * badge and redraws", async () => {
    let calls = 0;
    const list = [
      {
        ...byName("notes"),
        dirty: async () => {
          calls++;
          return true;
        },
      },
    ];
    const { out } = await pick({ ...base(), items: list, scope: "tries", test: { keys: ["\x1b[B", "\x1b[A"] } });
    expect(calls).toBe(1);
    const f = frames(out);
    expect(f[0]).not.toContain("notes  *");
    expect(f.at(-1)).toContain("notes  *");
  });

  test("dirty checks are not started in render-once mode", async () => {
    let calls = 0;
    const list = [{ ...byName("notes"), dirty: async () => (calls++, true) }];
    await pick({ ...base(), items: list, scope: "tries", test: { renderOnce: true } });
    expect(calls).toBe(0);
  });
});

describe("output modes", () => {
  test("renderOnce renders a single frame and returns null", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { renderOnce: true } });
    expect(result).toBeNull();
    expect(frames(out)).toHaveLength(1);
    expect(out.startsWith("\x1b[1;38;5;208m📁 Work Selector · tries\x1b[0m")).toBe(true);
  });

  test("footer shows Tab/Ctrl-R hints only when they fit", async () => {
    const narrow = await pick({ ...base(), scope: "tries", test: { renderOnce: true } });
    expect(plain(narrow.out)).toContain("Ctrl-D: Delete  Esc: Cancel");
    process.env.WORK_WIDTH = "100";
    try {
      const wide = await pick({ ...base(), scope: "tries", test: { renderOnce: true } });
      expect(plain(wide.out)).toContain(
        "↑↓: Navigate  Enter: Select  Ctrl-T: New  Ctrl-D: Delete  Tab: Scope  Ctrl-R: Move  Esc: Cancel",
      );
    } finally {
      process.env.WORK_WIDTH = "80";
    }
  });

  test("non-TTY without keys errors", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries" });
    expect(result).toBeNull();
    expect(out).toContain("Error: work requires an interactive terminal\n");
    expect(out).not.toContain("Work Selector");
  });

  test("colors: false leaves tokens unexpanded", async () => {
    const { out } = await pick({ ...base(), scope: "tries", colors: false, test: { renderOnce: true } });
    expect(out).toContain("{h1}📁 Work Selector · tries{reset}\n");
  });

  test("plain text when not a TTY and colors are not forced", async () => {
    const { out } = await pick({ ...base(), scope: "tries", test: { renderOnce: true, forceColors: false } });
    expect(out).not.toContain("{");
    expect(out.split("\n")[0]).toBe("📁 Work Selector · tries");
  });
});

// --- real terminal path ---------------------------------------------------------------------------

interface FakeTTY {
  stdin: PassThrough & { isTTY: boolean; setRawMode(m: boolean): unknown };
  raw: boolean[];
}

function fakeStdin(): FakeTTY {
  const raw: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(m: boolean) {
      raw.push(m);
      return stdin;
    },
  });
  return { stdin, raw };
}

function ttyErr() {
  const err = capture(true);
  Object.assign(err.stream, { columns: 80, rows: 24 });
  return err;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("terminal", () => {
  test("raw mode, multi-key chunks, restore on exit", async () => {
    const { stdin, raw } = fakeStdin();
    const err = ttyErr();
    const winch = process.listenerCount("SIGWINCH");
    const p = runPicker({
      ...base(),
      scope: "tries",
      prefixFor: () => "",
      createSpace: () => "tries",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: err.stream,
    });
    await tick();
    expect(process.listenerCount("SIGWINCH")).toBe(winch + 1);
    stdin.write("\x1b[B\x1b[B");
    await tick();
    stdin.write("\x1b[A\r");
    expect(await p).toEqual({ type: "cd", path: byName("2026-09-01-vector-search").path });
    expect(raw).toEqual([true, false]);
    expect(process.listenerCount("SIGWINCH")).toBe(winch);
    const out = err.text();
    expect(out.startsWith("\x1b[2J\x1b[H\x1b[?25l\x1b[H\x1b[1;1H\x1b[2K")).toBe(true);
    expect(out.endsWith("\x1b[2J\x1b[H\x1b[?25h")).toBe(true);
  });

  test("lone Esc cancels", async () => {
    const { stdin } = fakeStdin();
    const p = runPicker({
      ...base(),
      scope: "tries",
      prefixFor: () => "",
      createSpace: () => "tries",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: ttyErr().stream,
    });
    await tick();
    stdin.write("\x1b");
    expect(await p).toBeNull();
  });

  test("cooked-mode prompt for Ctrl-T", async () => {
    const { stdin, raw } = fakeStdin();
    const p = runPicker({
      ...base(),
      scope: "tries",
      prefixFor: () => "p-",
      createSpace: () => "tries",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: ttyErr().stream,
    });
    await tick();
    stdin.write("\x14");
    await tick();
    expect(raw).toEqual([true, false]);
    stdin.write("new one\n");
    expect(await p).toEqual({ type: "mkdir", space: "tries", name: "p-new-one" });
    expect(raw).toEqual([true, false, true, false]);
  });

  test("cooked-mode YES confirmation", async () => {
    const { stdin } = fakeStdin();
    const p = runPicker({
      ...base(),
      scope: "tries",
      prefixFor: () => "",
      createSpace: () => "tries",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: ttyErr().stream,
    });
    await tick();
    stdin.write("\x04\r");
    await tick();
    stdin.write("YES\n");
    expect(await p).toEqual({ type: "delete", paths: [byName("2026-09-18-redis-bench").path] });
  });

  test("SIGWINCH clears and redraws", async () => {
    const { stdin } = fakeStdin();
    const err = ttyErr();
    const p = runPicker({
      ...base(),
      scope: "tries",
      prefixFor: () => "",
      createSpace: () => "tries",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: err.stream,
    });
    await tick();
    const before = err.text().split("\x1b[2J").length;
    process.kill(process.pid, "SIGWINCH");
    await tick(100);
    expect(err.text().split("\x1b[2J").length).toBe(before + 1);
    expect(err.text().split("Work Selector").length).toBe(3);
    stdin.write("\x03");
    expect(await p).toBeNull();
  });

  test("terminal is restored when a callback throws", async () => {
    const { stdin, raw } = fakeStdin();
    const err = ttyErr();
    const winch = process.listenerCount("SIGWINCH");
    const p = runPicker({
      ...base(),
      scope: "tries",
      prefixFor: () => {
        throw new Error("boom");
      },
      createSpace: () => "tries",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: err.stream,
    });
    await tick();
    stdin.write("a");
    await expect(p).rejects.toThrow("boom");
    expect(raw).toEqual([true, false]);
    expect(process.listenerCount("SIGWINCH")).toBe(winch);
    expect(err.text().endsWith("\x1b[2J\x1b[H\x1b[?25h")).toBe(true);
  });

  test("stdin EOF cancels", async () => {
    const { stdin } = fakeStdin();
    const p = runPicker({
      ...base(),
      scope: "tries",
      prefixFor: () => "",
      createSpace: () => "tries",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: ttyErr().stream,
    });
    await tick();
    stdin.end();
    expect(await p).toBeNull();
  });
});
