#!/usr/bin/env bun
import { existsSync, readSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { splitDashDash, takeFlag, takeOption, takeOptions } from "./args.ts";
import { complete, formatCandidates } from "./complete.ts";
import { Emitter } from "./emit.ts";
import {
  archiveEntry,
  createEntry,
  deleteEntries,
  moveEntry,
  parseMoveTarget,
  resolveEntry,
  spacePrefix,
  unarchiveEntry,
} from "./entries.ts";
import { fail, WorkError } from "./errors.ts";
import { checkoutStatus, findCheckouts, gitTry, run } from "./git.ts";
import { History } from "./history.ts";
import { initScript, parseShortcuts } from "./init.ts";
import {
  addRepo,
  createLane,
  DEFAULT_LANE,
  laneOfCwd,
  removalWarnings,
  removeLane,
  removeRepo,
  removeTree,
} from "./lanes.ts";
import { hasModel, loadModel, repoBranch, topoLanes } from "./model.ts";
import { cloneDirName, dashify, isGitUri, today, versionedBase } from "./naming.ts";
import { expandHome, isInside, type EntryInfo, Root } from "./root.ts";
import { parentRefOf, submit, sync } from "./stack.ts";
import { type CreateOption, formatRelativeTime, parseTestKeys, type PickerItem, runPicker } from "./tui/index.ts";

export const VERSION = "0.1.0";
const DEFAULT_SPACE = "tries";

interface Ctx {
  root: Root;
  history: History;
  emit: Emitter;
  cwd: string;
  space?: string;
  prefix?: string;
  lane?: string;
  on?: string;
  json: boolean;
  yes: boolean;
  force: boolean;
  first: boolean;
  flags: Set<string>;
  test: { type?: string; exit: boolean; keys?: string[]; confirm?: string };
  colors: boolean;
  expandTokens: boolean;
}

function out(s: string): void {
  process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
}

function info(s: string): void {
  if (!process.env.WORK_QUIET) process.stderr.write(`${s}\n`);
}

function help(): string {
  return `work v${VERSION} - workspaces with parallel, stacked lanes (replaces try)

Shell setup (~/.zshrc, ~/.bashrc; fish: eval (work init … | string collect)):
  eval "$(work init ~/Work --shortcut tries --shortcut labs)"

Usage:
  work [query]                     Picker over all spaces (Tab switches scope)
  work --space S [query]           Picker in space S (shortcuts: tries, labs, …)
  work new [--space S] [--prefix P] <name>   Create an entry without the picker
  work - | work back               Previous entry
  work . <name> | ./path [name]    New entry with a worktree of that repo
  work worktree dir|<path> [name]  Same (try compatible)
  work clone <url> [name] | <url>  New entry with a checkout of <url>
  work path <query> [lane]         Print the path of an entry (or lane)
  work ls [--space S] [--json] [--stale] [--archived]
  work space [ls | new <name> [--prefix P] | set <name> --prefix P]
  work info [entry] [--json]       Lanes, branches, parents, status, PRs
  work add <repo|url|path> [branch] [--lane L]
  work lane <name> [repos…] [--on <lane>|trunk]
  work mv [entry] <space>[/<name>] [--prefix P]
  work archive [entry] | work unarchive <entry>
  work rm <entry>[/<lane>[/<repo>]] | ./<lane>[/<repo>] [--yes] [--force]
  work sync [--continue|--abort]   Restack lanes onto their parents
  work submit [--draft]            Push lanes, open/update stacked PRs (gh)
  work init [path] [--shortcut NAME[=SPACE]]…
  work exec [args]                 Print the shell script instead of running it (try's manual mode)

Options:
  --path DIR     root folder (default ~/Work; env WORK_ROOT)
  --space S      space (default ${DEFAULT_SPACE});   --prefix auto|none|TEXT   entry name prefix
  --json         machine-readable output;   --yes  no confirmation;   --force  ignore dirty/unpushed
  --no-colors, --no-expand-tokens, NO_COLOR

Picker keys: ↑↓/Ctrl-P/N navigate, Enter select/create, Ctrl-T new, Ctrl-D delete, Ctrl-R move,
             Tab/Shift-Tab switch space (last tab: + new space), Ctrl-A/E/B/F/K/W edit, Esc cancel
             Type space/name to filter or create in another (or a new) space.
`;
}

// ---------------------------------------------------------------------------------------------------------------

function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function confirmYes(ctx: Ctx, what: string, warnings: string[]): void {
  if (ctx.yes) return;
  if (!isTty()) fail(`${what}: confirmation required, pass --yes`);
  process.stderr.write(`${what}\n${warnings.map((w) => `  ! ${w}\n`).join("")}Type YES to confirm: `);
  const buf = Buffer.alloc(256);
  let line = "";
  for (;;) {
    const n = readSync(0, buf, 0, buf.length, null);
    if (n <= 0) break;
    line += buf.subarray(0, n).toString();
    if (line.includes("\n")) break;
  }
  if (line.trim() !== "YES") fail("Cancelled.");
}

function currentEntry(ctx: Ctx): { entry: EntryInfo; rest: string[] } {
  const loc = ctx.root.locate(ctx.cwd);
  if (!loc) fail(`not inside an entry of ${ctx.root.path}`);
  return { entry: resolveEntry(ctx.root, loc.entryPath, ctx.cwd), rest: loc.rest };
}

function visit(ctx: Ctx, entryPath: string, cdTo = entryPath): void {
  ctx.history.record(entryPath);
  ctx.emit.cd(cdTo);
}

function staleDays(ctx: Ctx, space: string): number | undefined {
  return ctx.root.spaceConfig(space).cleanup_days;
}

function badgesFor(entryPath: string): string | undefined {
  if (!hasModel(entryPath)) return undefined;
  const model = loadModel(entryPath);
  const lanes = Object.keys(model.lanes);
  const repos = [...new Set(lanes.flatMap((l) => Object.keys(model.lanes[l]!.repos)))].sort();
  if (!lanes.length) return undefined;
  return lanes.length === 1 && lanes[0] === DEFAULT_LANE ? repos.join(" ") : `${lanes.length} lanes: ${repos.join(" ")}`;
}

async function asyncDirty(entryPath: string): Promise<boolean> {
  for (const c of findCheckouts(entryPath, 2)) {
    const p = Bun.spawn(["git", "-C", c, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    if (text.trim()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------

async function picker(ctx: Ctx, query: string): Promise<number> {
  ctx.root.ensure();
  if (ctx.space) ctx.root.spacePath(ctx.space);
  const spaces = ctx.root.spaces();
  // scopes are existing spaces only; a shortcut whose space doesn't exist yet starts in "all" and creates there
  // (the picker then asks for the new space's default prefix)
  const scopes = ["*", ...spaces];
  const startScope = ctx.space && spaces.includes(ctx.space) ? ctx.space : "*";
  const visits = ctx.history.lastVisits();
  const now = new Date();
  const items: PickerItem[] = ctx.root.allEntries().map((e) => {
    const recency = visits.get(e.path) ?? e.mtime;
    const days = staleDays(ctx, e.space);
    return {
      basename: e.name,
      path: e.path,
      space: e.space,
      recency,
      badges: badgesFor(e.path),
      stale: days !== undefined && now.getTime() - recency.getTime() > days * 86_400_000,
      dirty: hasModel(e.path) ? () => asyncDirty(e.path) : undefined,
    };
  });
  const defaultSpace = ctx.space ?? DEFAULT_SPACE;
  const result = await runPicker({
    items,
    scopes,
    scope: startScope,
    query,
    initialInput: ctx.test.type,
    defaultSpace,
    createOptions: (s) => createOptions(ctx, s),
    addSpace: (name, prefix) => {
      ctx.root.addSpace(name, prefix);
    },
    deleteWarnings: (paths) => paths.flatMap((p) => removalWarnings(p)),
    rootPath: ctx.root.path,
    test: {
      renderOnce: ctx.test.exit,
      noCls: ctx.test.exit || Boolean(ctx.test.keys?.length),
      keys: ctx.test.keys,
      confirm: ctx.test.confirm,
      forceColors: ctx.test.exit || Boolean(ctx.test.keys?.length),
    },
    colors: ctx.colors,
    expandTokens: ctx.expandTokens,
  });
  if (!result) {
    out("Cancelled.");
    return 1;
  }
  switch (result.type) {
    case "cd":
      visit(ctx, result.path);
      return 0;
    case "mkdir": {
      const { path } = createEntry(ctx.root, result.space, result.name);
      visit(ctx, path);
      return 0;
    }
    case "delete": {
      deleteEntries(ctx.root, result.paths, { force: true });
      info(`Deleted: ${result.paths.map((p) => basename(p)).join(", ")}`);
      const hit = result.paths.find((p) => isInside(ctx.cwd, p));
      if (hit) ctx.emit.cd(resolve(hit, ".."));
      return 0;
    }
    case "move": {
      const entry = resolveEntry(ctx.root, result.from, ctx.cwd);
      const target = parseMoveTarget(ctx.root, entry, result.to, undefined);
      const moved = moveEntry(ctx.root, entry, target, ctx.history, ctx.cwd);
      info(`Moved ${entry.space}/${entry.name} → ${target.space}/${target.name}`);
      ctx.history.record(moved.path);
      ctx.emit.cd(moved.cd ?? moved.path);
      return 0;
    }
  }
}

/** Create rows for a space: its default prefix first, then the other variant (date ↔ no date). */
function createOptions(ctx: Ctx, space: string): CreateOption[] {
  const first = spacePrefix(ctx.root, space, ctx.prefix);
  const dated = `${today()}-`;
  return first === "" ? [{ prefix: "", label: "" }, { prefix: dated, label: "date" }] : [{ prefix: first, label: "" }, { prefix: "", label: "no date" }];
}

/** Normalize a --prefix value for .space.toml: none → "". */
function prefixSetting(p: string): string {
  return p === "none" ? "" : p;
}

function cmdSpace(ctx: Ctx, args: string[]): number {
  const [sub = "ls", name] = args;
  switch (sub) {
    case "ls": {
      const rows = ctx.root.spaces().map((space) => {
        const cfg = ctx.root.spaceConfig(space);
        return { space, prefix: cfg.prefix ?? "auto", entries: ctx.root.entries(space).length, path: ctx.root.spacePath(space) };
      });
      if (ctx.json) out(JSON.stringify(rows, null, 2));
      else for (const r of rows) out(`${r.space.padEnd(16)} prefix ${(r.prefix === "" ? "none" : r.prefix).padEnd(10)} ${r.entries} entries`);
      return 0;
    }
    case "new": {
      if (!name) fail("usage: work space new <name> [--prefix auto|none|TEXT]");
      const dir = ctx.root.addSpace(name, ctx.prefix === undefined ? undefined : prefixSetting(ctx.prefix));
      if (ctx.json) out(JSON.stringify({ space: name, path: dir }));
      else info(`Created space ${name}`);
      ctx.emit.cd(dir);
      return 0;
    }
    case "set": {
      if (!name || ctx.prefix === undefined) fail("usage: work space set <name> --prefix auto|none|TEXT");
      if (!ctx.root.spaces().includes(name)) fail(`no such space: ${name}`);
      ctx.root.writeSpaceConfig(name, { prefix: prefixSetting(ctx.prefix) });
      info(`${name}: prefix ${ctx.prefix}`);
      return 0;
    }
    default:
      fail("usage: work space [ls | new <name> [--prefix P] | set <name> --prefix P]");
  }
}

function cmdNew(ctx: Ctx, args: string[]): number {
  const name = args.join(" ").trim();
  if (!name) fail("usage: work new [--space S] [--prefix P] <name>");
  const space = ctx.space ?? DEFAULT_SPACE;
  const { path, created } = createEntry(ctx.root, space, `${spacePrefix(ctx.root, space, ctx.prefix)}${dashify(name)}`);
  visit(ctx, path);
  if (ctx.json) {
    out(JSON.stringify({ space, name: basename(path), path, created }));
    return 0;
  }
  if (ctx.emit.mode === "file") info(`${created ? "Created" : "Exists"}: ${path}`);
  return 0;
}

function cmdClone(ctx: Ctx, args: string[]): number {
  const [url, custom] = args;
  if (!url) fail("Error: git URI required for clone command\nUsage: work clone <git-uri> [name]");
  const space = ctx.space ?? DEFAULT_SPACE;
  const dir = cloneDirName(url, custom, spacePrefix(ctx.root, space, ctx.prefix));
  if (!dir) fail(`Error: Unable to parse git URI: ${url}`);
  const entryPath = join(ctx.root.spacePath(space), dir);
  if (existsSync(entryPath)) fail(`${entryPath} already exists`);
  createEntry(ctx.root, space, dir);
  info(`Using git clone (bare store + worktree) to create this entry from ${url}.`);
  try {
    const checkout = addRepo(ctx.root, entryPath, { lane: DEFAULT_LANE, spec: url, cwd: ctx.cwd, postAdd: ctx.root.spaceConfig(space).post_add });
    visit(ctx, entryPath, checkout);
  } catch (e) {
    removeTree(ctx.root, entryPath);
    throw e;
  }
  return 0;
}

/** try's `.`, `./path` and `worktree dir|path`: new dated entry, worktree of the repo in lane root. */
function cmdDot(ctx: Ctx, pathArg: string, customParts: string[], explicit: boolean): number {
  const custom = customParts.join(" ").trim();
  if (pathArg === "." && !custom && !explicit) fail("Error: 'work .' requires a name argument\nUsage: work . <name>");
  const repoDir = pathArg === "dir" ? ctx.cwd : resolve(ctx.cwd, expandHome(pathArg));
  const base = custom ? dashify(custom) : basename(repoDir);
  const space = ctx.space ?? DEFAULT_SPACE;
  const prefix = spacePrefix(ctx.root, space, ctx.prefix);
  const spaceDir = ctx.root.spacePath(space);
  const name = `${prefix}${versionedBase(spaceDir, prefix, base)}`;
  const { path: entryPath } = createEntry(ctx.root, space, name);
  const isRepo = existsSync(repoDir) && gitTry(repoDir, ["rev-parse", "--show-toplevel"]) !== undefined;
  if (!isRepo) {
    visit(ctx, entryPath);
    return 0;
  }
  info(`Using git worktree to create this entry from ${repoDir}.`);
  try {
    const checkout = addRepo(ctx.root, entryPath, { lane: DEFAULT_LANE, spec: repoDir, cwd: ctx.cwd, postAdd: ctx.root.spaceConfig(space).post_add });
    visit(ctx, entryPath, checkout);
  } catch (e) {
    removeTree(ctx.root, entryPath);
    throw e;
  }
  return 0;
}

function cmdPath(ctx: Ctx, args: string[]): number {
  const [query, lane] = args;
  if (!query) fail("usage: work path <query> [lane]");
  const entry = resolveEntry(ctx.root, query, ctx.cwd, { space: ctx.space, first: ctx.first });
  let path = entry.path;
  if (lane) {
    path = join(entry.path, lane);
    if (!existsSync(path)) fail(`no lane ${lane} in ${entry.space}/${entry.name}`);
  }
  out(ctx.json ? JSON.stringify({ space: entry.space, name: entry.name, path }) : path);
  return 0;
}

function cmdLs(ctx: Ctx): number {
  const visits = ctx.history.lastVisits();
  const now = Date.now();
  const archived = ctx.flags.has("--archived");
  const list = (archived ? ctx.root.archived(ctx.space) : ctx.space ? ctx.root.entries(ctx.space) : ctx.root.allEntries())
    .map((e) => {
      const recency = visits.get(e.path) ?? e.mtime;
      const days = staleDays(ctx, e.space) ?? (ctx.flags.has("--stale") ? 30 : undefined);
      const model = hasModel(e.path) ? loadModel(e.path) : undefined;
      return {
        space: e.space,
        name: e.name,
        path: e.path,
        recency: recency.toISOString(),
        stale: days !== undefined && now - recency.getTime() > days * 86_400_000,
        lanes: model ? Object.keys(model.lanes) : [],
        repos: model ? [...new Set(Object.values(model.lanes).flatMap((l) => Object.keys(l.repos)))].sort() : [],
        _t: recency.getTime(),
      };
    })
    .filter((e) => !ctx.flags.has("--stale") || e.stale)
    .sort((a, b) => b._t - a._t);
  if (ctx.json) {
    out(JSON.stringify(list.map(({ _t, ...e }) => e), null, 2));
    return 0;
  }
  const width = Math.max(10, ...list.map((e) => e.space.length + e.name.length + 1));
  for (const e of list) {
    const label = `${e.space}/${e.name}`.padEnd(width);
    const extra = [e.lanes.length > 1 ? `${e.lanes.length} lanes` : "", e.repos.join(" "), e.stale ? "stale" : ""].filter(Boolean).join(" · ");
    out(`${label}  ${formatRelativeTime(new Date(e._t)).padEnd(9)} ${extra}`.trimEnd());
  }
  return 0;
}

function cmdInfo(ctx: Ctx, args: string[]): number {
  const entry = resolveEntry(ctx.root, args[0] ?? ".", ctx.cwd, { space: ctx.space, first: ctx.first });
  const model = loadModel(entry.path);
  const lanes = topoLanes(model).map((name) => {
    const l = model.lanes[name]!;
    return {
      name,
      branch: l.branch,
      parent: l.parent,
      path: join(entry.path, name),
      repos: Object.entries(l.repos).map(([repo, rec]) => {
        const checkout = join(entry.path, name, repo);
        const exists = existsSync(checkout);
        const st = exists ? checkoutStatus(checkout) : undefined;
        let parentRef: string | undefined;
        let ahead: number | undefined;
        let behind: number | undefined;
        try {
          parentRef = parentRefOf(model, name, repo).ref;
          const counts = gitTry(checkout, ["rev-list", "--left-right", "--count", `${parentRef}...${repoBranch(l, repo)}`]);
          if (counts) [behind, ahead] = counts.split(/\s+/).map(Number);
        } catch {
          // source gone
        }
        return {
          repo,
          path: checkout,
          exists,
          branch: repoBranch(l, repo),
          checkedOut: st?.branch,
          dirty: st?.dirty ?? false,
          unpushed: st?.unpushed ?? 0,
          rebasing: st?.rebasing ?? false,
          parentRef,
          ahead,
          behind,
          base: rec.base,
          pr: rec.pr,
          merged: rec.merged ?? false,
          source: rec.source,
        };
      }),
    };
  });
  const data = { space: entry.space, name: entry.name, path: entry.path, lanes, sync: model.sync };
  if (ctx.json) {
    out(JSON.stringify(data, null, 2));
    return 0;
  }
  out(`${entry.space}/${entry.name}  ${entry.path}`);
  if (!lanes.length) out("  (no lanes — `work add <repo>` creates lane root)");
  for (const l of lanes) {
    out(`  ${l.name}/  ${l.branch}  on ${l.parent ?? "trunk"}`);
    for (const r of l.repos) {
      const flags = [
        r.dirty && "dirty",
        r.unpushed && `${r.unpushed} unpushed`,
        r.rebasing && "REBASING",
        r.ahead !== undefined && `+${r.ahead}/-${r.behind} vs ${r.parentRef}`,
        r.pr && `PR #${r.pr}${r.merged ? " merged" : ""}`,
        !r.exists && "missing",
      ].filter(Boolean);
      out(`    ${r.repo}  ${r.branch}${flags.length ? `  (${flags.join(", ")})` : ""}`);
    }
  }
  if (model.sync) out(`  sync in progress: stopped at ${model.sync.pending[0]?.join("/")}`);
  return 0;
}

function cmdAdd(ctx: Ctx, args: string[]): number {
  const [spec, branch] = args;
  if (!spec) fail("usage: work add <repo|url|path> [branch] [--lane L]");
  const { entry, rest } = currentEntry(ctx);
  const model = loadModel(entry.path);
  const current = laneOfCwd(model, rest);
  const lane = ctx.lane ?? current ?? DEFAULT_LANE;
  const parent = model.lanes[lane] ? undefined : ctx.on === "trunk" ? null : (ctx.on ?? (lane === DEFAULT_LANE ? null : (current ?? null)));
  const checkout = addRepo(ctx.root, entry.path, {
    lane,
    spec,
    branch,
    cwd: ctx.cwd,
    parent,
    postAdd: ctx.root.spaceConfig(entry.space).post_add,
  });
  out(ctx.json ? JSON.stringify({ lane, path: checkout }) : checkout);
  return 0;
}

function cmdLane(ctx: Ctx, args: string[]): number {
  const [name, ...repos] = args;
  if (!name) fail("usage: work lane <name> [repos…] [--on <lane>|trunk]");
  const { entry, rest } = currentEntry(ctx);
  const model = loadModel(entry.path);
  const parent = ctx.on === "trunk" ? null : (ctx.on ?? laneOfCwd(model, rest) ?? null);
  const path = createLane(ctx.root, entry.path, { name, parent, repos, cwd: ctx.cwd, postAdd: ctx.root.spaceConfig(entry.space).post_add });
  ctx.emit.cd(path);
  if (ctx.json) out(JSON.stringify({ lane: name, parent, path }));
  else if (ctx.emit.mode === "file") info(`Lane ${name} on ${parent ?? "trunk"}: ${path}`);
  return 0;
}

function cmdMv(ctx: Ctx, args: string[]): number {
  if (!args.length || args.length > 2) fail("usage: work mv [entry] <space>[/<name>] [--prefix P]");
  const [source, target] = args.length === 2 ? args : [".", args[0]!];
  const entry = resolveEntry(ctx.root, source!, ctx.cwd, { first: ctx.first });
  const t = parseMoveTarget(ctx.root, entry, target!, ctx.prefix);
  const moved = moveEntry(ctx.root, entry, t, ctx.history, ctx.cwd);
  info(`Moved ${entry.space}/${entry.name} → ${t.space}/${t.name}`);
  if (moved.cd) ctx.emit.cd(moved.cd);
  if (ctx.json) out(JSON.stringify({ from: entry.path, path: moved.path }));
  else if (!moved.cd) out(moved.path); // with a cd the target is emitted instead
  return 0;
}

function cmdArchive(ctx: Ctx, args: string[]): number {
  const entry = resolveEntry(ctx.root, args[0] ?? ".", ctx.cwd, { first: ctx.first });
  const res = archiveEntry(ctx.root, entry, ctx.history, ctx.cwd);
  info(`Archived ${entry.space}/${entry.name}`);
  if (res.cd) ctx.emit.cd(res.cd);
  if (ctx.json) out(JSON.stringify({ path: res.path }));
  return 0;
}

function cmdUnarchive(ctx: Ctx, args: string[]): number {
  if (!args[0]) fail("usage: work unarchive <entry>");
  const path = unarchiveEntry(ctx.root, args[0], ctx.history);
  info(`Restored ${path}`);
  out(ctx.json ? JSON.stringify({ path }) : path);
  return 0;
}

function cmdRm(ctx: Ctx, args: string[]): number {
  const target = args[0];
  if (!target) fail("usage: work rm <entry>[/<lane>[/<repo>]] | ./<lane>[/<repo>] [--yes] [--force]");
  const parts = target.split("/").filter(Boolean);
  let entry: EntryInfo;
  let rest: string[];
  if (target === "." || parts[0] === ".") {
    entry = currentEntry(ctx).entry;
    rest = parts.slice(1);
  } else if (parts.length >= 2 && ctx.root.spaces().includes(parts[0]!) && existsSync(join(ctx.root.path, parts[0]!, parts[1]!))) {
    entry = resolveEntry(ctx.root, `${parts[0]}/${parts[1]}`, ctx.cwd);
    rest = parts.slice(2);
  } else {
    entry = resolveEntry(ctx.root, parts[0]!, ctx.cwd, { space: ctx.space, first: ctx.first });
    rest = parts.slice(1);
  }
  if (rest.length > 2) fail(`too many path parts in ${target}`);
  const dir = join(entry.path, ...rest);
  if (!existsSync(dir)) fail(`${dir} does not exist`);
  const warnings = removalWarnings(dir);
  if (warnings.length && !ctx.force) fail(`refusing to delete (use --force):\n${warnings.join("\n")}`);
  const label = [`${entry.space}/${entry.name}`, ...rest].join("/");
  confirmYes(ctx, `Delete ${label}?`, warnings);
  if (rest.length === 0) deleteEntries(ctx.root, [entry.path], { force: true });
  else if (rest.length === 1) removeLane(ctx.root, entry.path, rest[0]!);
  else removeRepo(ctx.root, entry.path, rest[0]!, rest[1]!);
  info(`Deleted ${label}`);
  if (isInside(ctx.cwd, dir)) ctx.emit.cd(resolve(dir, ".."));
  return 0;
}

function cmdSync(ctx: Ctx): number {
  const { entry } = currentEntry(ctx);
  const reports = sync(ctx.root, entry.path, { continue: ctx.flags.has("--continue"), abort: ctx.flags.has("--abort") });
  if (ctx.json) out(JSON.stringify(reports, null, 2));
  return 0;
}

function cmdSubmit(ctx: Ctx): number {
  const { entry } = currentEntry(ctx);
  const reports = submit(ctx.root, entry.path, { draft: ctx.flags.has("--draft") });
  if (ctx.json) out(JSON.stringify(reports, null, 2));
  return 0;
}

function cmdBack(ctx: Ctx): number {
  const loc = ctx.root.locate(ctx.cwd);
  const prev = ctx.history.previous(loc?.entryPath);
  if (!prev) fail("no previous entry");
  visit(ctx, prev);
  return 0;
}

function cmdInit(ctx: Ctx, args: string[], pathFlag: string | undefined): number {
  const shortcuts = parseShortcuts(takeOptions(args, "--shortcut"));
  const rootArg = args[0] ?? pathFlag ?? process.env.WORK_ROOT ?? "~/Work";
  const root = resolve(expandHome(rootArg));
  const shell = (process.env.SHELL ?? "").includes("fish") ? "fish" : "sh";
  out(initScript({ root, shortcuts, shell }));
  return 0;
}

/** try's default command: `.`/`./path`, a git URL, or the picker. */
async function defaultCommand(ctx: Ctx, args: string[]): Promise<number> {
  const first = args[0];
  if (first?.startsWith(".")) return cmdDot(ctx, first, args.slice(1), false);
  if (isGitUri(first)) return cmdClone(ctx, [first!, args.slice(1).join(" ") || undefined].filter((x): x is string => x !== undefined));
  return picker(ctx, args.join(" "));
}

// ---------------------------------------------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const rawArgs = argv.slice(2);
  const [head, tail] = splitDashDash(rawArgs);
  const args = [...head];

  // completion runs before anything else and never fails loudly
  const ci = args.indexOf("__complete");
  if (ci >= 0) {
    const pre = args.slice(0, ci);
    const post = args.slice(ci + 1);
    const pathFlag = takeOption(pre, "--path");
    const shell = takeOption(post, "--shell") ?? "zsh";
    const cmd = takeOption(post, "--cmd") ?? "work";
    const space = takeOption(post, "--space") || undefined;
    try {
      const root = Root.resolve(pathFlag);
      process.stdout.write(formatCandidates(complete(root, { cmd, space, words: tail, cwd: process.cwd() }), shell));
    } catch {
      // no completion
    }
    return 0;
  }

  const expandTokens = !takeFlag(args, "--no-expand-tokens");
  const colors = !takeFlag(args, "--no-colors") && !(process.env.NO_COLOR ?? "");
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help());
    return 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    out(`work ${VERSION}`);
    return 0;
  }

  const pathFlag = takeOption(args, "--path");
  const ctx: Ctx = {
    root: Root.resolve(pathFlag),
    history: undefined as unknown as History,
    emit: undefined as unknown as Emitter,
    cwd: process.cwd(),
    space: takeOption(args, "--space") || undefined,
    prefix: takeOption(args, "--prefix"),
    lane: takeOption(args, "--lane"),
    on: takeOption(args, "--on"),
    json: takeFlag(args, "--json"),
    yes: takeFlag(args, "--yes", "-y"),
    force: takeFlag(args, "--force", "-f"),
    first: takeFlag(args, "--first"),
    flags: new Set(["--continue", "--abort", "--draft", "--stale", "--archived"].filter((f) => takeFlag(args, f))),
    test: {
      type: takeOption(args, "--and-type"),
      exit: takeFlag(args, "--and-exit"),
      keys: parseTestKeys(takeOption(args, "--and-keys")),
      confirm: takeOption(args, "--and-confirm"),
    },
    colors,
    expandTokens,
  };
  ctx.history = new History(ctx.root);
  args.push(...tail);

  let cmd = args.shift();
  let exec = false;
  if (cmd === "exec") {
    exec = true;
    cmd = args.shift();
    if (cmd === "cd") cmd = args.shift();
  }
  ctx.emit = new Emitter({ exec });

  let code: number;
  switch (cmd) {
    case undefined:
      if (!exec && !process.env.WORK_EMIT && !ctx.space && !ctx.test.exit && !ctx.test.keys) {
        process.stdout.write(help());
        return 2;
      }
      code = await picker(ctx, "");
      break;
    case "init":
      return cmdInit(ctx, args, pathFlag);
    case "space":
      code = cmdSpace(ctx, args);
      break;
    case "new":
      code = cmdNew(ctx, args);
      break;
    case "clone":
      code = cmdClone(ctx, args);
      break;
    case "worktree":
      code = cmdDot(ctx, args[0] ?? "dir", args.slice(1), true);
      break;
    case "path":
      code = cmdPath(ctx, args);
      break;
    case "ls":
      code = cmdLs(ctx);
      break;
    case "info":
      code = cmdInfo(ctx, args);
      break;
    case "add":
      code = cmdAdd(ctx, args);
      break;
    case "lane":
      code = cmdLane(ctx, args);
      break;
    case "mv":
      code = cmdMv(ctx, args);
      break;
    case "archive":
      code = cmdArchive(ctx, args);
      break;
    case "unarchive":
      code = cmdUnarchive(ctx, args);
      break;
    case "rm":
      code = cmdRm(ctx, args);
      break;
    case "sync":
      code = cmdSync(ctx);
      break;
    case "submit":
      code = cmdSubmit(ctx);
      break;
    case "-":
    case "back":
      code = cmdBack(ctx);
      break;
    default:
      code = await defaultCommand(ctx, [cmd, ...args]);
  }
  // direct calls with --json already printed a document; don't append the cd target to it
  if (!(ctx.json && ctx.emit.mode === "direct")) ctx.emit.flush();
  return code;
}

if (import.meta.main) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof WorkError) {
        process.stderr.write(`${e.message.startsWith("Error") || e.message === "Cancelled." ? "" : "work: "}${e.message}\n`);
        process.exit(e.exitCode);
      }
      process.stderr.write(`work: ${(e as Error).stack ?? e}\n`);
      process.exit(1);
    });
}

export { run };
