import { cpSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { writeAgentFiles } from "./agents.ts";
import { fail } from "./errors.ts";
import { findWorktrees, isLinkedWorktree } from "./git.ts";
import type { History } from "./history.ts";
import { removalWarnings, removeTree } from "./lanes.ts";
import { hasModel, loadModel } from "./model.ts";
import { dashify, prefixText, stripDate } from "./naming.ts";
import { repairWorktree } from "./repos.ts";
import { isInside, real, type Root, type WorkspaceInfo } from "./root.ts";
import { calculateScore } from "./tui/index.ts";

/** Effective prefix text for a space: explicit flag > .space.toml > auto (date). */
export function spacePrefix(root: Root, space: string, flag: string | undefined): string {
  return prefixText(flag ?? root.spaceConfig(space).prefix);
}

/** Create (or reuse) `<space>/<name>`; copies the space template into new workspaces. */
export function createWorkspace(root: Root, space: string, name: string): { path: string; created: boolean } {
  const spaceDir = root.spacePath(space);
  if (!existsSync(spaceDir)) root.checkNewSpace(space);
  const clean = dashify(name);
  if (!clean || clean.includes("/") || clean.startsWith(".")) fail(`invalid workspace name: ${name}`);
  const path = join(spaceDir, clean);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(path, { recursive: true });
  const template = root.spaceConfig(space).template;
  if (template) {
    const src = join(spaceDir, template);
    if (existsSync(src)) cpSync(src, path, { recursive: true });
    else process.stderr.write(`warning: template ${src} not found\n`);
  }
  return { path, created: true };
}

/** `space/name`, an absolute path, `.` (current workspace) or a query → workspace path. */
export function resolveWorkspace(root: Root, query: string, cwd: string, opts: { space?: string; first?: boolean } = {}): WorkspaceInfo {
  if (query === "." || query === "") {
    const loc = root.locate(cwd);
    if (!loc) fail("not inside a workspace");
    return info(root, loc.space, loc.workspace);
  }
  if (query.startsWith("/")) {
    const loc = root.locate(query);
    if (!loc) fail(`${query} is not inside ${root.path}`);
    return info(root, loc.space, loc.workspace);
  }
  const slash = query.indexOf("/");
  if (slash > 0) {
    const space = query.slice(0, slash);
    const name = query.slice(slash + 1);
    if (existsSync(join(root.path, space, name))) return info(root, space, name);
  }
  const pool = opts.space ? root.workspaces(opts.space) : root.allWorkspaces();
  const q = query.toLowerCase();
  const exact = pool.filter((e) => e.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const sub = pool.filter((e) => e.name.toLowerCase().includes(q));
  if (sub.length === 1) return sub[0]!;
  const scored = pool
    .map((e) => ({ e, s: calculateScore(e.name, dashify(query), e.mtime) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 1 || (opts.first && scored.length)) return scored[0]!.e;
  if (!scored.length) fail(`no workspace matches '${query}'`);
  const list = scored.slice(0, 8).map((x) => `  ${x.e.space}/${x.e.name}`).join("\n");
  fail(`'${query}' is ambiguous:\n${list}\nUse space/name, a longer query, or --first.`);
}

function info(root: Root, space: string, name: string): WorkspaceInfo {
  const path = join(root.path, space, name);
  if (!existsSync(path)) fail(`no such workspace: ${space}/${name}`);
  return { space, name, path, mtime: statSync(path).mtime };
}

/** Move a folder that may contain worktrees, then reconnect them with their stores. */
function moveWithRepair(root: Root, from: string, to: string, history: History): void {
  if (existsSync(to)) fail(`${to} already exists`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  for (const c of findWorktrees(to, 2)) if (isLinkedWorktree(c)) repairWorktree(c);
  history.rename(from, to);
  if (hasModel(to)) writeAgentFiles(root, to, loadModel(to));
}

export interface MoveTarget {
  space: string;
  name: string;
}

/** Parse `space[/name]`; the name defaults to the workspace name (with a new prefix when --prefix is given). */
export function parseMoveTarget(root: Root, workspace: WorkspaceInfo, target: string, prefixFlag: string | undefined): MoveTarget {
  const [typed = "", ...rest] = target.split("/");
  if (!typed.trim()) fail("target space missing");
  const space = root.spaceArg(typed);
  if (!root.spaces().includes(space)) root.checkNewSpace(space);
  const explicit = rest.join("/");
  let name = explicit || workspace.name;
  if (prefixFlag !== undefined) name = `${prefixText(prefixFlag)}${explicit || stripDate(workspace.name)}`;
  return { space, name: dashify(name) };
}

/** mv/rename/promote. Returns the new path and where the caller's cwd should go (if it was inside). */
export function moveWorkspace(root: Root, workspace: WorkspaceInfo, target: MoveTarget, history: History, cwd: string): { path: string; cd?: string } {
  const to = join(root.spacePath(target.space), target.name);
  if (real(to) === real(workspace.path)) fail("source and target are the same");
  moveWithRepair(root, workspace.path, to, history);
  return { path: to, cd: followCwd(cwd, workspace.path, to) };
}

export function archiveWorkspace(root: Root, workspace: WorkspaceInfo, history: History, cwd: string): { path: string; cd?: string } {
  const to = join(root.path, workspace.space, ".archive", workspace.name);
  moveWithRepair(root, workspace.path, to, history);
  return { path: to, cd: isInside(cwd, workspace.path) ? join(root.path, workspace.space) : undefined };
}

export function unarchiveWorkspace(root: Root, query: string, history: History): string {
  const [maybeSpace, maybeName] = query.includes("/") ? query.split("/", 2) : [undefined, query];
  const hits = root.archived(maybeSpace).filter((e) => e.name === maybeName || e.name.includes(maybeName!));
  const exact = hits.filter((e) => e.name === maybeName);
  const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : undefined;
  if (!pick) fail(hits.length ? `ambiguous: ${hits.map((h) => `${h.space}/${h.name}`).join(", ")}` : `no archived workspace matches '${query}'`);
  const to = join(root.path, pick.space, pick.name);
  moveWithRepair(root, pick.path, to, history);
  return to;
}

/** `cwd` must be captured before the move (getcwd follows the moved inode). */
function followCwd(cwd: string, from: string, to: string): string | undefined {
  return isInside(cwd, from) ? join(to, relative(from, cwd)) : undefined;
}

/** Delete safety like try: must be a workspace folder inside the root (not a space or the root itself). */
export function assertDeletable(root: Root, path: string): void {
  const loc = root.locate(path);
  if (!loc || loc.rest.length || real(loc.workspacePath) !== real(path)) fail(`Safety check failed: ${path} is not a workspace inside ${root.path}`);
}

export function deleteWorkspaces(root: Root, paths: string[], opts: { force: boolean }): void {
  for (const p of paths) assertDeletable(root, p);
  if (!opts.force) {
    const warnings = paths.flatMap((p) => removalWarnings(p));
    if (warnings.length) fail(`refusing to delete (use --force):\n${warnings.join("\n")}`);
  }
  for (const p of paths) removeTree(root, p);
}

export { basename };
