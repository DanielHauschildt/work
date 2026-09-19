// Differential tests against the installed try: same keys must give the same list area (rows, ranking, cursor,
// highlighting, scroll indicator), the same search line, the same dialogs and the same frame count. The header
// (space bar), the normal footer and the create row's wording intentionally differ.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { parseTestKeys, runPicker } from "../../src/tui/index.ts";
import { TRY_BIN, capture, itemsFromDir, makeEntries, plain, tmpRoot, today } from "./helpers.ts";

const hasTry = existsSync(TRY_BIN);
const SPACE = "tries";
const H1 = "\x1b[1;38;5;208m📁 ";
const SEPARATOR = "─────";

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

function runTry(dir: string, o: Opts): string {
  const [w, h] = o.size ?? [80, 24];
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TRY_WIDTH: String(w), TRY_HEIGHT: String(h) };
  delete env.NO_COLOR;
  const args: string[] = [];
  if (o.noColors) args.push("--no-colors");
  if (o.noExpand) args.push("--no-expand-tokens");
  if (o.exit) args.push("--and-exit");
  if (o.type !== undefined) args.push("--and-type", o.type);
  if (o.keys !== undefined) args.push("--and-keys", o.keys);
  if (o.confirm !== undefined) args.push("--and-confirm", o.confirm);
  if (o.query) args.push(...o.query.split(" "));
  const p = Bun.spawnSync([TRY_BIN, "exec", "--path", dir, ...args], { env, stdin: "ignore" });
  return p.stderr.toString();
}

async function runWork(dir: string, o: Opts): Promise<string> {
  const err = capture();
  const [w, h] = o.size ?? [80, 24];
  process.env.WORK_WIDTH = String(w);
  process.env.WORK_HEIGHT = String(h);
  const keys = parseTestKeys(o.keys);
  await runPicker({
    items: itemsFromDir(dir, SPACE),
    scopes: ["*", SPACE],
    scope: SPACE,
    query: o.query,
    initialInput: o.type,
    defaultSpace: SPACE,
    // one create option, so the number of rows (and so the cursor range) equals try's
    createOptions: () => [{ prefix: `${today()}-`, label: "" }],
    addSpace: () => {
      throw new Error("unexpected addSpace");
    },
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

/** Create rows reduced to `[→ ]CREATE <name>`; try says "Create new: X", work "New tries/X   <label>". */
function normalizeCreateRow(line: string): string {
  const p = plain(line).replace(/[{][a-z/_]+[}]/g, "");
  const m = /^(→ | {2})📂 (?:Create new: |New tries\/)(.*?)\s*$/.exec(p);
  return m ? `${m[1]}CREATE ${m[2]}` : line;
}

interface Frame {
  lead: string;
  search: string;
  list: string[];
  footer: string;
  trailing: string[];
}

/**
 * Split a force-colors stream into frames. Each frame: header, separator, search, separator, list area...,
 * separator, footer, then whatever follows before the next header (dialogs).
 */
function parseFrames(out: string, normalFooter: RegExp): { preamble: string[]; frames: Frame[] } {
  const lines = out.split("\n");
  const preamble: string[] = [];
  const groups: string[][] = [];
  for (const line of lines) {
    if (line.includes(H1) || line.includes("{h1}📁 ")) groups.push([line]);
    else if (groups.length === 0) preamble.push(line);
    else groups.at(-1)!.push(line);
  }
  const frames = groups.map((g) => {
    const seps = g.flatMap((l, i) => (l.includes(SEPARATOR) ? [i] : []));
    expect(seps[0]).toBe(1);
    expect(seps[1]).toBe(3);
    const last = seps.at(-1)!;
    const footer = g[last + 1] ?? "";
    const header = g[0]!;
    return {
      // escapes written before the header (cursor show/hide after dialogs)
      lead: header.slice(0, Math.max(header.indexOf(H1), header.indexOf("{h1}"), 0)),
      search: g[2]!,
      list: g.slice(4, last).map(normalizeCreateRow),
      footer: normalFooter.test(plain(footer)) ? "HELP" : footer,
      trailing: g.slice(last + 2),
    };
  });
  return { preamble, frames };
}

const TRY_FOOTER = /↑↓: Navigate {2}Enter: Select {2}Ctrl-T: New {2}Ctrl-D: Delete {2}Esc: Cancel/;
const WORK_FOOTER = /↑↓ Enter {2}\^T New {2}\^D Delete {2}\^R Move {2}Tab Space {2}Esc/;

async function compare(dir: string, o: Opts): Promise<void> {
  const t = parseFrames(runTry(dir, o), TRY_FOOTER);
  const w = parseFrames(await runWork(dir, o), WORK_FOOTER);
  expect(w.frames.length).toBeGreaterThan(0);
  expect(w.preamble).toEqual(t.preamble);
  expect(w.frames).toEqual(t.frames);
}

describe.skipIf(!hasTry)("list parity with try", () => {
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
    ["create row selected", { keys: "TYPE=ZZZ,DOWN,ENTER" }],
    ["create row after matches", { keys: "TYPE=E,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,DOWN,UP" }],
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
  ];

  for (const [name, o] of cases) test(name, () => compare(dir, o));

  test("scroll indicator", () => compare(many, { keys: Array(18).fill("DOWN").join(",") }));

  test("scroll indicator with create row", () =>
    compare(many, { keys: `TYPE=ITEM,${Array(26).fill("DOWN").join(",")},UP,UP` }));
});
