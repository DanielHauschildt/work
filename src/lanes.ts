import { existsSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { writeAgentFiles } from "./agents.ts";
import { fail } from "./errors.ts";
import { findWorktrees, isRepoDir, worktreeStatus } from "./git.ts";
import { withLock } from "./lock.ts";
import { LANE_NAME, laneBranch, laneOfFolder, ROOT_LANE, worktreeDir } from "./naming.ts";
import {
  childrenOf,
  loadModel,
  repoBranch,
  repoParentLane,
  saveModel,
  type WorkspaceModel,
} from "./model.ts";
import {
  addWorktree,
  removeWorktree,
  resolveRepo,
  type RepoSource,
  sourceFromPath,
  trunkRef,
} from "./repos.ts";
import type { Root } from "./root.ts";

export const DEFAULT_LANE = ROOT_LANE;

/** Serialize read-modify-write of a workspace's .work.json across processes (parallel agents). */
export function withWorkspace<T>(root: Root, workspacePath: string, fn: (model: WorkspaceModel) => T): T {
  return withLock(root.stateDir, `workspace:${workspacePath}`, () => {
    const model = loadModel(workspacePath);
    const result = fn(model);
    saveModel(workspacePath, model);
    writeAgentFiles(root, workspacePath, model);
    return result;
  });
}

function runHook(cmd: string, cwd: string): void {
  process.stderr.write(`post_add: ${cmd}\n`);
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.stderr.write(`warning: post_add exited with ${r.exitCode} in ${cwd}\n`);
}

function ensureLaneRec(model: WorkspaceModel, workspacePath: string, lane: string, parent: string | null): void {
  if (!LANE_NAME.test(lane)) fail(`invalid lane name: ${lane}`);
  if (model.lanes[lane]) return;
  if (parent !== null && !model.lanes[parent]) fail(`unknown parent lane: ${parent}`);
  model.lanes[lane] = { parent, branch: laneBranch(basename(workspacePath), lane), repos: {} };
}

/** Ref a new branch in `lane` should start from for this repo: the nearest ancestor lane's branch, else trunk. */
export function baseRefFor(model: WorkspaceModel, lane: string, repo: string, src: RepoSource): string {
  const parentLane = repoParentLane(model, lane, repo);
  if (parentLane) {
    const rec = model.lanes[parentLane]!.repos[repo]!;
    if (rec.source === src.path) return repoBranch(model.lanes[parentLane]!, repo);
  }
  return trunkRef(src);
}

export interface AddOptions {
  lane: string;
  spec: string;
  branch?: string;
  cwd: string;
  postAdd?: string;
  /** Parent for the lane if it has to be created. */
  parent?: string | null;
}

/** Add a worktree of a repo to a lane (creating the lane if needed). Returns the worktree path. */
export function addRepo(root: Root, workspacePath: string, opts: AddOptions): string {
  const src = resolveRepo(root, opts.spec, opts.cwd);
  // `@` separates repo and lane in folder names, so a repo can't carry one
  if (src.name.includes("@")) fail(`repo name must not contain '@': ${src.name}`);
  const path = withWorkspace(root, workspacePath, (model) => {
    ensureLaneRec(model, workspacePath, opts.lane, opts.parent ?? null);
    const lane = model.lanes[opts.lane]!;
    if (lane.repos[src.name]) fail(`${src.name} is already in lane ${opts.lane}`);
    const branch = opts.branch ?? lane.branch;
    const worktree = join(workspacePath, worktreeDir(opts.lane, src.name));
    const baseRef = baseRefFor(model, opts.lane, src.name, src);
    const { base } = addWorktree(root, src, worktree, branch, baseRef);
    lane.repos[src.name] = { source: src.path, base, ...(branch !== lane.branch ? { branch } : {}) };
    return worktree;
  });
  if (opts.postAdd) runHook(opts.postAdd, path);
  return path;
}

export interface LaneOptions {
  name: string;
  parent: string | null;
  repos: string[];
  cwd: string;
  postAdd?: string;
}

/** Create a lane; without explicit repos it inherits the parent lane's repos. Returns the new worktrees. */
export function createLane(root: Root, workspacePath: string, opts: LaneOptions): string[] {
  const specs = withWorkspace(root, workspacePath, (model) => {
    if (model.lanes[opts.name]) fail(`lane ${opts.name} already exists`);
    ensureLaneRec(model, workspacePath, opts.name, opts.parent);
    if (opts.repos.length) return opts.repos;
    const parent = opts.parent ? model.lanes[opts.parent] : undefined;
    return parent ? Object.values(parent.repos).map((r) => r.source) : [];
  });
  return specs.map((spec) => addRepo(root, workspacePath, { lane: opts.name, spec, cwd: opts.cwd, postAdd: opts.postAdd }));
}

/** Worktree folder of a repo: flat `<repo>[@<lane>]`, or the legacy `<lane>/<repo>` folder while it exists. */
export function worktreePath(workspacePath: string, lane: string, repo: string): string {
  const flat = join(workspacePath, worktreeDir(lane, repo));
  if (existsSync(flat)) return flat;
  const legacy = join(workspacePath, lane, repo);
  return existsSync(legacy) ? legacy : flat;
}

/** Lanes whose worktrees still sit in a `<lane>/<repo>` folder (the layout before `<repo>@<lane>`). */
export function legacyLanes(workspacePath: string, model: WorkspaceModel): string[] {
  return Object.keys(model.lanes).filter((lane) =>
    Object.keys(model.lanes[lane]!.repos).some((repo) => existsSync(join(workspacePath, lane, repo))),
  );
}

/** Refuse to touch a workspace that `work migrate` hasn't converted yet. */
export function requireFlatLayout(workspacePath: string, model: WorkspaceModel): void {
  const old = legacyLanes(workspacePath, model);
  if (!old.length) return;
  fail(`${workspacePath} still uses lane folders (${old.join(", ")}): run \`work migrate\` for this workspace, or \`work migrate --all\` for every workspace`);
}

export interface RemovalCheck {
  path: string;
  warnings: string[];
}

/** Dirty / unpushed warnings for `dir` itself (a worktree) or every worktree in it. */
export function removalWarnings(dir: string): string[] {
  const worktrees = existsSync(join(dir, ".git")) ? [dir] : findWorktrees(dir, 2);
  const out: string[] = [];
  for (const c of worktrees) {
    const s = worktreeStatus(c);
    const what = [s.dirty && "uncommitted changes", s.unpushed > 0 && `${s.unpushed} unpushed commit(s)`, s.rebasing && "rebase in progress"].filter(Boolean);
    if (what.length) out.push(`${c}: ${what.join(", ")}`);
  }
  return out;
}

/** Remove worktrees below `dir` properly, then the folder. Branches are kept. */
export function removeTree(root: Root, dir: string): void {
  for (const c of findWorktrees(dir, 2)) {
    // plain repos (legacy try clone) are just deleted with the folder
    if (existsSync(join(c, ".git")) && !isMainRepo(c)) removeWorktree(root, c);
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Remove one worktree of a lane: with git when it is one, else just the folder (legacy plain clone). */
function removeWorktreeDir(root: Root, dir: string): void {
  if (!existsSync(dir)) return;
  if (isRepoDir(dir) && !isMainRepo(dir)) removeWorktree(root, dir);
  else removeTree(root, dir);
}

function isMainRepo(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/** Remove a lane: all its worktrees (the folder of each), then the record. Children inherit its parent. */
export function removeLane(root: Root, workspacePath: string, lane: string): void {
  withWorkspace(root, workspacePath, (model) => {
    const rec = model.lanes[lane];
    if (!rec) fail(`unknown lane: ${lane}`);
    for (const child of childrenOf(model, lane)) model.lanes[child]!.parent = rec.parent;
    for (const repo of Object.keys(rec.repos)) removeWorktreeDir(root, worktreePath(workspacePath, lane, repo));
    delete model.lanes[lane];
  });
}

export function removeRepo(root: Root, workspacePath: string, lane: string, repo: string): void {
  withWorkspace(root, workspacePath, (model) => {
    const rec = model.lanes[lane];
    if (!rec?.repos[repo]) fail(`${repo} is not in lane ${lane}`);
    removeWorktreeDir(root, worktreePath(workspacePath, lane, repo));
    delete rec.repos[repo];
  });
}

/** Lane of the folder the cwd is in (`<repo>@<lane>`), if that lane exists. */
export function laneOfCwd(model: WorkspaceModel, rest: string[]): string | undefined {
  const folder = rest[0];
  if (!folder) return undefined;
  const lane = laneOfFolder(folder);
  return model.lanes[lane] ? lane : undefined;
}

export { sourceFromPath };
