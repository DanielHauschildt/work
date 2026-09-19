import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type CreateOption, type PickerItem, type PickerOptions, parseTestKeys, runPicker } from "../../src/tui/index.ts";
import { capture, pick, plain, tmpRoot, today } from "./helpers.ts";

const NOW = new Date("2026-09-19T12:00:00Z");
const HOUR = 3_600_000;
const DATE = `${today()}-`;

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
const TWO_OPTIONS = (): CreateOption[] => [
  { prefix: DATE, label: "" },
  { prefix: "", label: "no date" },
];

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

const HEADER = "📁 work  ";

/** Frames rendered in force-colors mode, split on the header line. */
function frames(out: string): string[] {
  return plain(out)
    .split(HEADER)
    .slice(1)
    .map((f) => `${HEADER}${f}`);
}

/** Active tab of each frame's space bar. */
function activeTabs(out: string): string[] {
  return frames(out).map((f) => /\[([^\]]+)\]/.exec(f.split("\n")[0]!)![1]!);
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
    expect(f[0]).not.toContain("redis-bench");
    expect(f[0]).toContain(`📂 New tries/${DATE}vector-search`);
  });

  test("initialInput overrides the query", async () => {
    const { out } = await pick({ ...base(), scope: "tries", query: "redis", initialInput: "no tes", test: { renderOnce: true } });
    expect(plain(out)).toContain("Search: no-tes");
  });
});

describe("space bar and footer", () => {
  test("tabs: all, spaces, + new; active one bracketed", async () => {
    const { out } = await pick({ ...base(), scope: "tries", test: { renderOnce: true, forceColors: false } });
    expect(out.split("\n")[0]).toBe("📁 work   all  labs [tries] + new ");
    const all = await pick({ ...base(), scope: "*", test: { renderOnce: true } });
    expect(all.out).toContain("\x1b[1;38;5;208m📁 work\x1b[0m\x1b[39m\x1b[49m  \x1b[1m[all]\x1b[0m\x1b[90m labs \x1b[39m");
  });

  test("elides tabs that don't fit, keeping the active one", async () => {
    const scopes = ["*", "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
    process.env.WORK_WIDTH = "40";
    try {
      const { out } = await pick({ ...base(), scopes, scope: "echo", test: { renderOnce: true, forceColors: false } });
      const header = out.split("\n")[0]!;
      expect(header).toContain("[echo]");
      expect(header).toContain(" … ");
      expect(header.startsWith("📁 work   … ")).toBe(true);
      expect(Array.from(header).length + 1).toBeLessThanOrEqual(39); // 📁 is two columns
      const first = await pick({ ...base(), scopes, scope: "*", test: { renderOnce: true, forceColors: false } });
      expect(first.out.split("\n")[0]!.startsWith("📁 work  [all] alpha ")).toBe(true);
      expect(first.out.split("\n")[0]!.endsWith(" … ")).toBe(true);
    } finally {
      process.env.WORK_WIDTH = "80";
    }
  });

  test("Tab / Shift-Tab cycle all → spaces → + new and reset the cursor", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "*",
      test: { keys: parseTestKeys("DOWN,TAB,TAB,TAB,TAB,SHIFT-TAB,SHIFT-TAB,SHIFT-TAB,DOWN,TAB,ENTER") },
    });
    expect(activeTabs(out)).toEqual(["all", "all", "labs", "tries", "+ new", "all", "+ new", "tries", "labs", "labs", "tries"]);
    // Tab after DOWN resets the cursor to the top row of the new scope
    expect(result).toEqual({ type: "cd", path: byName("2026-09-18-redis-bench").path });
  });

  test("compact footer", async () => {
    const { out } = await pick({ ...base(), scope: "tries", test: { renderOnce: true } });
    expect(plain(out)).toContain("\n↑↓ Enter  ^T New  ^D Delete  ^R Move  Tab Space  Esc\n");
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
    expect(plain(out)).not.toContain("labs/");
  });
});

describe("create", () => {
  test("Enter on a create row", async () => {
    const { result } = await pick({ ...base(), scope: "tries", test: { keys: parseTestKeys("TYPE=ZZ TOP,ENTER") } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: `${DATE}ZZ-TOP` });
  });

  test("one row per create option, labels right-aligned", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "labs",
      createOptions: (space) =>
        space === "labs"
          ? [
              { prefix: "IMG-1-", label: "" },
              { prefix: "", label: "no date" },
              { prefix: DATE, label: "date" },
            ]
          : [],
      test: { keys: [...chars("zzz"), "\x1b[B", "\r"] },
    });
    expect(result).toEqual({ type: "mkdir", space: "labs", name: "zzz" });
    const lines = frames(out)[3]!.split("\n");
    expect(lines).toContain("→ 📂 New labs/IMG-1-zzz");
    const noDate = lines.find((l) => l.includes("New labs/zzz"))!;
    expect(noDate).toBe(`  📂 New labs/zzz${" ".repeat(80 - 1 - 7 - 5 - 12)}no date`);
    expect(lines.find((l) => l.includes(`New labs/${DATE}zzz`))!.endsWith(" date")).toBe(true);
  });

  test("create rows follow the matches after a blank line", async () => {
    const { out } = await pick({ ...base(), scope: "tries", createOptions: TWO_OPTIONS, test: { keys: [..."e", "\x1b[B"] } });
    const f = frames(out).at(-1)!;
    expect(f).toContain("notes");
    expect(f).toMatch(/notes[^\n]*\n {2}📂 New tries\//);
  });

  test("Ctrl-T uses the first option", async () => {
    const { result } = await pick({ ...base(), scope: "tries", createOptions: TWO_OPTIONS, test: { keys: [..."qq", "\x14"] } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: `${DATE}qq` });
  });

  test("all scope creates in defaultSpace", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "*",
      defaultSpace: "labs",
      createOptions: () => [{ prefix: "", label: "" }],
      test: { keys: [..."qq", "\x14"] },
    });
    expect(result).toEqual({ type: "mkdir", space: "labs", name: "qq" });
    expect(plain(out)).toContain("📂 New labs/qq");
  });

  test("Ctrl-T with empty query prompts for a name", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: ["\x14", ...chars("my thing"), "\r"] } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: `${DATE}my-thing` });
    expect(out).toContain("\x1b[2J\x1b[H"); // prompt clears the screen
    expect(out).toContain(`\x1b[1;34mEnter new name\x1b[0m\x1b[39m\x1b[49m\n> \x1b[90mtries/${DATE}\x1b[39m`);
    expect(out).toContain("\x1b[?25h");
  });

  test("Ctrl-T prompt with empty input returns to the list", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", test: { keys: ["\x14", "\r", "\x1b[B", "\r"] } });
    expect(result).toEqual({ type: "cd", path: byName("2026-09-01-vector-search").path });
    expect(frames(out).length).toBeGreaterThanOrEqual(2);
  });

  test("no create options: no rows, Ctrl-T does nothing", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries", createOptions: () => [], test: { keys: [..."zzz", "\x14", "\r"] } });
    expect(result).toBeNull();
    expect(plain(out)).not.toContain("📂");
  });
});

describe("new space from a create row", () => {
  function newSpaceRun(keys: string[], extra: Partial<PickerOptions> = {}) {
    const calls: Array<[string, string]> = [];
    const run = pick({
      ...base(),
      scope: "*",
      defaultSpace: "ideas",
      createOptions: TWO_OPTIONS,
      addSpace: (name, prefix) => {
        calls.push([name, prefix]);
      },
      test: { keys },
      ...extra,
    });
    return { calls, run };
  }

  test("rows are marked (new space); Enter asks for the default, then creates", async () => {
    const { calls, run } = newSpaceRun([..."foo", "\r", "\r"]);
    const { result, out } = await run;
    expect(result).toEqual({ type: "mkdir", space: "ideas", name: `${DATE}foo` });
    expect(calls).toEqual([["ideas", "auto"]]);
    const p = plain(out);
    expect(p).toMatch(/→ 📂 New ideas\/\d{4}-\d{2}-\d{2}-foo +\(new space\)\n/);
    expect(p).toMatch(/ {2}📂 New ideas\/foo +\(new space\) {2}no date\n/);
    expect(p).toContain(`New space "ideas" — default for new entries:\n→ date      (${DATE}name)\n  no date   (name)\n↑↓ Enter  Esc Back\n`);
  });

  test("preselects no date for a row without prefix; the choice can be changed", async () => {
    const { calls, run } = newSpaceRun([..."foo", "\x1b[B", "\r", "\x1b[A", "\r"]);
    const { result, out } = await run;
    expect(plain(out)).toContain("  date      (");
    expect(plain(out)).toContain("→ no date   (name)");
    expect(calls).toEqual([["ideas", "auto"]]);
    // the entry keeps the prefix of the row that was picked
    expect(result).toEqual({ type: "mkdir", space: "ideas", name: "foo" });
  });

  test("no date variant", async () => {
    const { calls, run } = newSpaceRun([..."foo", "\r", "\x1b[B", "\r"]);
    expect((await run).result).toEqual({ type: "mkdir", space: "ideas", name: `${DATE}foo` });
    expect(calls).toEqual([["ideas", ""]]);
  });

  test("Esc on the choice screen goes back to the list", async () => {
    const { calls, run } = newSpaceRun([..."foo", "\x14", "\x1b", "\x1b[B", "\r"]);
    const { result } = await run;
    expect(calls).toEqual([]);
    // back in the list (cursor kept), the choice screen came up again for the second row
    expect(result).toBeNull();
  });

  test("addSpace throwing shows the message and stays in the picker", async () => {
    const { run } = newSpaceRun([..."foo", "\r", "\r", "\x1b[B"], {
      addSpace: () => {
        throw new Error('space "ideas" is not allowed');
      },
    });
    const { result, out } = await run;
    expect(result).toBeNull();
    const f = frames(out);
    expect(f.at(-2)).toContain('Error: space "ideas" is not allowed');
    expect(f.at(-1)).toContain("↑↓ Enter  ^T New");
  });

  test("Ctrl-T prompt into a new space", async () => {
    const { calls, run } = newSpaceRun(["\x14", ..."bar", "\r", "\r"]);
    expect((await run).result).toEqual({ type: "mkdir", space: "ideas", name: `${DATE}bar` });
    expect(calls).toEqual([["ideas", "auto"]]);
  });
});

describe("space/rest queries", () => {
  test("`labs/` lists that space (with prefix) from another scope", async () => {
    const { out } = await pick({ ...base(), scope: "tries", query: "labs/", test: { renderOnce: true } });
    const p = plain(out);
    expect(p).toContain("📁 labs/IMG-1234-autofit");
    expect(p).toContain("📁 labs/IMG-99-labs-thing");
    expect(p).not.toContain("redis");
    expect(p).not.toContain("📂"); // no name yet
  });

  test("`labs/rest` filters by rest and creates in labs", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "*",
      createOptions: (space) => [{ prefix: space === "labs" ? "IMG-7-" : "x-", label: "" }],
      test: { keys: [..."labs/auto", "\x1b[B", "\r"] },
    });
    expect(result).toEqual({ type: "mkdir", space: "labs", name: "IMG-7-auto" });
    const last = frames(out).at(-1)!;
    expect(last).toContain("Search: labs/auto");
    expect(last).toContain("IMG-1234-autofit");
    expect(last).not.toContain("IMG-99-labs-thing");
    expect(last).toContain("→ 📂 New labs/IMG-7-auto");
    // highlighting uses the part after the slash
    expect(out).toContain("\x1b[1;33ma\x1b[22m\x1b[39m\x1b[1;33mu\x1b[22m\x1b[39m");
  });

  test("unknown space: no rows, create rows marked (new space)", async () => {
    const calls: string[] = [];
    const { result, out } = await pick({
      ...base(),
      scope: "tries",
      addSpace: (name) => {
        calls.push(name);
      },
      test: { keys: [..."docs/guide", "\r", "\r"] },
    });
    expect(result).toEqual({ type: "mkdir", space: "docs", name: `${DATE}guide` });
    expect(calls).toEqual(["docs"]);
    expect(frames(out).at(-1)).toMatch(/→ 📂 New docs\/\S+guide +\(new space\)/);
  });

  test("not a space name before the slash: plain query, no create rows", async () => {
    const { out } = await pick({ ...base(), scope: "tries", query: "-x/y", test: { renderOnce: true } });
    expect(plain(out)).toContain("Search: -x/y");
    expect(plain(out)).not.toContain("📂");
  });
});

describe("+ new tab", () => {
  function plusNew(keys: string[], extra: Partial<PickerOptions> = {}) {
    const calls: Array<[string, string]> = [];
    const run = pick({
      ...base(),
      scope: "*",
      addSpace: (name, prefix) => {
        calls.push([name, prefix]);
      },
      test: { keys: ["\x1b[Z", ...keys] },
      ...extra,
    });
    return { calls, run };
  }

  test("search label and hint", async () => {
    const { run } = plusNew([]);
    const f = frames((await run).out)[1]!;
    expect(f).toContain("[+ new]");
    expect(f).toContain("New space:  \n");
    expect(f).toContain("\n  Type a name, Enter to create · Tab to leave\n");
    expect(f).not.toContain("📁 tries/");
  });

  test("creates the space, switches to it and stays in the picker", async () => {
    const { calls, run } = plusNew([..."ideas", "\r", "\r", ..."foo", "\r"]);
    const { result, out } = await run;
    expect(calls).toEqual([["ideas", "auto"]]);
    expect(result).toEqual({ type: "mkdir", space: "ideas", name: `${DATE}foo` });
    const f = frames(out);
    const switched = f.find((x) => x.includes("[ideas]"))!;
    expect(switched.split("\n")[0]).toBe("📁 work   all [ideas] labs  tries  + new ");
    expect(switched).toContain("Search:  \n");
    expect(f.at(-1)).toContain("→ 📂 New ideas/");
    expect(f.at(-1)).not.toContain("(new space)");
  });

  test("Ctrl-T creates too; no date variant", async () => {
    const { calls, run } = plusNew([..."zeta", "\x14", "\x1b[B", "\r"]);
    const { out } = await run;
    expect(calls).toEqual([["zeta", ""]]);
    expect(activeTabs(out).at(-1)).toBe("zeta");
    expect(frames(out).at(-1)!.split("\n")[0]).toBe("📁 work   all  labs  tries [zeta] + new ");
  });

  test("invalid and existing names show a status and stay", async () => {
    const { calls, run } = plusNew([..."a/b", "\r", "\x7f", "\x7f", "\x7f", ..."LABS", "\r", "\x1b[D"]);
    const { result, out } = await run;
    expect(calls).toEqual([]);
    expect(result).toBeNull();
    const p = plain(out);
    expect(p).toContain("Invalid space name: a/b");
    expect(p).toContain("Space LABS already exists");
    expect(activeTabs(out).at(-1)).toBe("+ new");
  });

  test("addSpace throwing keeps the + new tab", async () => {
    const { run } = plusNew([..."ideas", "\r", "\r", "\x1b[D"], {
      addSpace: () => {
        throw new Error("no permission");
      },
    });
    const { out } = await run;
    expect(plain(out)).toContain("Error: no permission");
    expect(activeTabs(out).at(-1)).toBe("+ new");
  });

  test("Esc cancels the picker", async () => {
    const { run } = plusNew(["\x1b"]);
    expect((await run).result).toBeNull();
  });

  test("Esc on the choice screen returns to the tab", async () => {
    const { calls, run } = plusNew([..."ideas", "\r", "\x1b", "\x1b[D"]);
    const { out } = await run;
    expect(calls).toEqual([]);
    expect(activeTabs(out).at(-1)).toBe("+ new");
    expect(frames(out).at(-1)).toContain("New space: ideas");
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
    expect(p).toContain(
      "Delete 2 Directories\n  📁 2026-09-18-redis-bench\n  📁 notes\n  notes: cesdk-web has uncommitted changes\nType YES to confirm deletion: ",
    );
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
      expect(plain(out)).toContain(`Error: Safety check failed: ${outside} is not inside ${root}`);
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

describe("move", () => {
  test("Ctrl-R prompts and returns the typed target", async () => {
    const { result, out } = await pick({
      ...base(),
      scope: "tries",
      test: { keys: ["\x1b[B", "\x12", ...chars("labs/vector"), "\r"] },
    });
    expect(result).toEqual({ type: "move", from: byName("2026-09-01-vector-search").path, to: "labs/vector" });
    expect(plain(out)).toContain("Move to (space/name):\ncurrent: tries/2026-09-01-vector-search\n> ");
  });

  test("empty input returns to the list", async () => {
    const { result } = await pick({ ...base(), scope: "tries", test: { keys: ["\x12", "\r", "\r"] } });
    expect(result).toEqual({ type: "cd", path: byName("2026-09-18-redis-bench").path });
  });

  test("Ctrl-R on a create row does nothing", async () => {
    const { result } = await pick({ ...base(), scope: "tries", test: { keys: [...chars("zzz"), "\x12", "\r"] } });
    expect(result).toEqual({ type: "mkdir", space: "tries", name: `${DATE}zzz` });
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
    expect(out.startsWith("\x1b[1;38;5;208m📁 work\x1b[0m")).toBe(true);
  });

  test("non-TTY without keys errors", async () => {
    const { result, out } = await pick({ ...base(), scope: "tries" });
    expect(result).toBeNull();
    expect(out).toContain("Error: work requires an interactive terminal\n");
    expect(out).not.toContain("📁 work");
  });

  test("colors: false leaves tokens unexpanded", async () => {
    const { out } = await pick({ ...base(), scope: "tries", colors: false, test: { renderOnce: true } });
    expect(out).toContain("{h1}📁 work{reset}  {dim} all {/fg}");
  });

  test("plain text when not a TTY and colors are not forced", async () => {
    const { out } = await pick({ ...base(), scope: "tries", test: { renderOnce: true, forceColors: false } });
    expect(out).not.toContain("{");
    expect(out.split("\n")[2]).toBe("Search: \x1b[7m \x1b[27m");
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

function ttyOptions(stdin: PassThrough, stderr: NodeJS.WriteStream, extra: Partial<PickerOptions> = {}): PickerOptions {
  return {
    ...base(),
    scope: "tries",
    defaultSpace: "tries",
    createOptions: () => [{ prefix: "", label: "" }],
    addSpace: () => {},
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr,
    ...extra,
  };
}

describe("terminal", () => {
  test("raw mode, multi-key chunks, restore on exit", async () => {
    const { stdin, raw } = fakeStdin();
    const err = ttyErr();
    const winch = process.listenerCount("SIGWINCH");
    const p = runPicker(ttyOptions(stdin, err.stream));
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
    const p = runPicker(ttyOptions(stdin, ttyErr().stream));
    await tick();
    stdin.write("\x1b");
    expect(await p).toBeNull();
  });

  test("cooked-mode prompt for Ctrl-T", async () => {
    const { stdin, raw } = fakeStdin();
    const p = runPicker(ttyOptions(stdin, ttyErr().stream, { createOptions: () => [{ prefix: "p-", label: "" }] }));
    await tick();
    stdin.write("\x14");
    await tick();
    expect(raw).toEqual([true, false]);
    stdin.write("new one\n");
    expect(await p).toEqual({ type: "mkdir", space: "tries", name: "p-new-one" });
    expect(raw).toEqual([true, false, true, false]);
  });

  test("choice screen with arrow keys", async () => {
    const { stdin } = fakeStdin();
    const calls: string[] = [];
    const p = runPicker(
      ttyOptions(stdin, ttyErr().stream, {
        scope: "*",
        defaultSpace: "ideas",
        addSpace: (name, prefix) => {
          calls.push(`${name}:${prefix}`);
        },
      }),
    );
    await tick();
    stdin.write("x\r");
    await tick();
    stdin.write("\x1b[B\r");
    expect(await p).toEqual({ type: "mkdir", space: "ideas", name: "x" });
    expect(calls).toEqual(["ideas:"]);
  });

  test("cooked-mode YES confirmation", async () => {
    const { stdin } = fakeStdin();
    const p = runPicker(ttyOptions(stdin, ttyErr().stream));
    await tick();
    stdin.write("\x04\r");
    await tick();
    stdin.write("YES\n");
    expect(await p).toEqual({ type: "delete", paths: [byName("2026-09-18-redis-bench").path] });
  });

  test("SIGWINCH clears and redraws", async () => {
    const { stdin } = fakeStdin();
    const err = ttyErr();
    const p = runPicker(ttyOptions(stdin, err.stream));
    await tick();
    const before = err.text().split("\x1b[2J").length;
    process.kill(process.pid, "SIGWINCH");
    await tick(100);
    expect(err.text().split("\x1b[2J").length).toBe(before + 1);
    expect(err.text().split("📁 work").length).toBe(3);
    stdin.write("\x03");
    expect(await p).toBeNull();
  });

  test("terminal is restored when a callback throws", async () => {
    const { stdin, raw } = fakeStdin();
    const err = ttyErr();
    const winch = process.listenerCount("SIGWINCH");
    const p = runPicker(
      ttyOptions(stdin, err.stream, {
        createOptions: () => {
          throw new Error("boom");
        },
      }),
    );
    await tick();
    stdin.write("a");
    await expect(p).rejects.toThrow("boom");
    expect(raw).toEqual([true, false]);
    expect(process.listenerCount("SIGWINCH")).toBe(winch);
    expect(err.text().endsWith("\x1b[2J\x1b[H\x1b[?25h")).toBe(true);
  });

  test("stdin EOF cancels", async () => {
    const { stdin } = fakeStdin();
    const p = runPicker(ttyOptions(stdin, ttyErr().stream));
    await tick();
    stdin.end();
    expect(await p).toBeNull();
  });
});
