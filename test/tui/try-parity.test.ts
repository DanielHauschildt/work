// Differential tests: the picker's stderr must equal the installed try's for the same directory, after swapping
// the header title and the footer additions.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { TRY_BIN, capture, itemsFromDir, makeEntries, tmpRoot, today } from "./helpers.ts";
import { parseTestKeys, runPicker } from "../../src/tui/index.ts";

const hasTry = existsSync(TRY_BIN);
const SPACE = "tries";

type Opts = {
  query?: string;
  type?: string;
  keys?: string;
  confirm?: string;
  exit?: boolean;
  noColors?: boolean;
  noExpand?: boolean;
  size?: [number, number];
};

function runTry(dir: string, args: string[], size: [number, number] = [80, 24]): { stderr: string; stdout: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TRY_WIDTH: String(size[0]),
    TRY_HEIGHT: String(size[1]),
  };
  delete env.NO_COLOR;
  const p = Bun.spawnSync([TRY_BIN, "exec", "--path", dir, ...args], { env, stdin: "ignore" });
  return { stderr: p.stderr.toString(), stdout: p.stdout.toString() };
}

/** try's output with work's header title, and the footer additions when the terminal is wide enough for them. */
function normalizeTry(s: string, width = 80): string {
  const out = s.replaceAll("📁 Try Selector", `📁 Work Selector · ${SPACE}`);
  if (width < 96) return out;
  return out.replaceAll("Ctrl-D: Delete  Esc: Cancel", "Ctrl-D: Delete  Tab: Scope  Ctrl-R: Move  Esc: Cancel");
}

async function runWork(dir: string, o: Opts): Promise<string> {
  const err = capture();
  const [w, h] = o.size ?? [80, 24];
  process.env.WORK_WIDTH = String(w);
  process.env.WORK_HEIGHT = String(h);
  const keys = parseTestKeys(o.keys);
  await runPicker({
    items: itemsFromDir(dir, SPACE),
    scopes: [SPACE],
    scope: SPACE,
    query: o.query,
    initialInput: o.type,
    prefixFor: () => `${today()}-`,
    createSpace: () => SPACE,
    rootPath: dir,
    test: {
      renderOnce: o.exit,
      noCls: Boolean(o.exit) || Boolean(keys?.length),
      keys,
      confirm: o.confirm,
      forceColors: Boolean(o.exit) || o.keys !== undefined,
    },
    colors: !o.noColors,
    expandTokens: !o.noExpand,
    stderr: err.stream,
  });
  return err.text();
}

function tryArgs(o: Opts): string[] {
  const args: string[] = [];
  if (o.noColors) args.push("--no-colors");
  if (o.noExpand) args.push("--no-expand-tokens");
  if (o.exit) args.push("--and-exit");
  if (o.type !== undefined) args.push("--and-type", o.type);
  if (o.keys !== undefined) args.push("--and-keys", o.keys);
  if (o.confirm !== undefined) args.push("--and-confirm", o.confirm);
  if (o.query) args.push(...o.query.split(" "));
  return args;
}

describe.skipIf(!hasTry)("render parity with try", () => {
  let dir: string;
  let many: string;
  const saved = { w: process.env.WORK_WIDTH, h: process.env.WORK_HEIGHT };

  beforeAll(() => {
    dir = tmpRoot();
    // Distinct ages keep scores apart (the Ruby sort is unstable on ties).
    makeEntries(dir, {
      "2026-09-18-redis-bench": 2.2,
      "2026-09-10-vector-search": 30.5,
      "2025-01-01-some-very-long-name-that-goes-on-and-on-and-on-forever-and-ever": 200.3,
      "notes-scratch": 5.4,
      "a-plain-folder-with-a-rather-long-name-that-needs-truncating-at-80-columns": 50.1,
      "2026-08-01-vbo-viz": 1000.7,
      "2026-08-02-v": 1100.2,
      ".hidden": 1,
    });
    many = tmpRoot();
    const entries: Record<string, number> = {};
    for (let i = 0; i < 25; i++) entries[`2026-07-${String(i + 1).padStart(2, "0")}-item-${i}`] = 3 + i * 7.3;
    makeEntries(many, entries);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(many, { recursive: true, force: true });
    if (saved.w === undefined) delete process.env.WORK_WIDTH;
    else process.env.WORK_WIDTH = saved.w;
    if (saved.h === undefined) delete process.env.WORK_HEIGHT;
    else process.env.WORK_HEIGHT = saved.h;
  });

  const cases: Array<[string, Opts]> = [
    ["render once, empty query", { exit: true }],
    ["render once, query", { exit: true, query: "redis" }],
    ["render once, query with dash", { exit: true, query: "v-s" }],
    ["render once, multi-word query", { exit: true, query: "vector search" }],
    ["render once, no match", { exit: true, query: "zzzz" }],
    ["render once, --and-type", { exit: true, type: "note" }],
    ["navigation", { keys: "DOWN,DOWN,DOWN,UP,CTRL-N,CTRL-P" }],
    ["typing and editing", { keys: "TYPE=VEC,BACKSPACE,CTRL-A,RIGHT,CTRL-F,CTRL-B,CTRL-E,CTRL-W,TYPE=RE,CTRL-K" }],
    ["create-new row selected", { keys: "TYPE=ZZZ,DOWN,ENTER" }],
    ["select", { keys: "DOWN,ENTER" }],
    ["delete mode toggle and esc", { keys: "CTRL-D,DOWN,CTRL-D,CTRL-D,ESC" }],
    ["delete confirmed via keys", { keys: "DOWN,CTRL-D,ENTER,Y,E,S,ENTER" }],
    ["delete cancelled via keys", { keys: "CTRL-D,ENTER,N,O,ENTER" }],
    ["delete confirmed via --and-confirm", { keys: "CTRL-D,ENTER", confirm: "YES" }],
    ["raw key mode", { keys: "red\x1b[B\x1b[A" }],
    ["ctrl-t with query", { keys: "TYPE=NEW THING,CTRL-T" }],
    ["esc cancels", { keys: "ESC" }],
    ["ctrl-c cancels", { keys: "TYPE=R,\x03" }],
    ["arrows left/right ignored", { keys: "LEFT,RIGHT" }],
    ["--no-colors", { exit: true, query: "re", noColors: true }],
    ["--no-expand-tokens", { keys: "TYPE=RE,DOWN", noExpand: true }],
    ["narrow 40x10", { exit: true, size: [40, 10] }],
    ["narrow 40x10 query", { keys: "TYPE=E,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN", size: [40, 10] }],
    ["tiny 20x6", { exit: true, size: [20, 6] }],
    ["wide 140x40", { exit: true, query: "o", size: [140, 40] }],
    ["96 columns: footer additions fit", { keys: "DOWN", size: [96, 24] }],
    ["95 columns: try's footer", { keys: "DOWN", size: [95, 24] }],
  ];

  for (const [name, o] of cases) {
    test(name, async () => {
      const t = runTry(dir, tryArgs(o), o.size);
      const w = await runWork(dir, o);
      expect(w.length).toBeGreaterThan(100);
      expect(w).toBe(normalizeTry(t.stderr, o.size?.[0]));
    });
  }

  test("scroll indicator", async () => {
    const t = runTry(many, tryArgs({ keys: "DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN" }));
    const w = await runWork(many, { keys: "DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN" });
    expect(w).toBe(normalizeTry(t.stderr));
  });

  test("scroll indicator with create-new row", async () => {
    const o = { keys: `TYPE=ITEM,${Array(26).fill("DOWN").join(",")},UP,UP` };
    const t = runTry(many, tryArgs(o));
    const w = await runWork(many, o);
    expect(w).toBe(normalizeTry(t.stderr));
  });
});
