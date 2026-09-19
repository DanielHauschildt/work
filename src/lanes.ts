import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { writeAgentFiles } from "./agents.ts";
import { fail } from "./errors.ts";
import { checkoutStatus, findCheckouts } from "./git.ts";
import { withLock } from "./lock.ts";
import { LANE_NAME, laneBranch } from "./naming.ts";
import {
  childrenOf,
  type EntryModel,
  loadModel,
  repoBranch,
  repoParentLane,
  saveModel,
} from "./model.ts";
import {
  addCheckout,
  removeCheckout,
  resolveRepo,
  type RepoSource,
  sourceFromPath,
  trunkRef,
} from "./repos.ts";
import type { Root } from "./root.ts";

export const DEFAULT_LANE = "root";

/** Serialize read-modify-write of an entry's .work.json across processes (parallel agents). */
export function withEntry<T>(root: Root, entryPath: string, fn: (model: EntryModel) => T): T {
  return withLock(root.stateDir, `entry:${entryPath}`, () => {
    const model = loadModel(entryPath);
    const result = fn(model);
    saveModel(entryPath, model);
    writeAgentFiles(root, entryPath, model);
    return result;
  });
}

function runHook(cmd: string, cwd: string): void {
  process.stderr.write(`post_add: ${cmd}\n`);
  const r = Bun.spawnSync(["sh", "-c", cmd], { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.stderr.write(`warning: post_add exited with ${r.exitCode} in ${cwd}\n`);
}

function ensureLaneRec(model: EntryModel, entryPath: string, lane: string, parent: string | null): void {
  if (!LANE_NAME.test(lane)) fail(`invalid lane name: ${lane}`);
  if (!model.lanes[lane]) {
    if (parent !== null && !model.lanes[parent]) fail(`unknown parent lane: ${parent}`);
    model.lanes[lane] = { parent, branch: laneBranch(basename(entryPath), lane), repos: {} };
  }
  mkdirSync(join(entryPath, lane), { recursive: true });
}

/** Ref a new branch in `lane` should start from for this repo: the nearest ancestor lane's branch, else trunk. */
export function baseRefFor(model: EntryModel, lane: string, repo: string, src: RepoSource): string {
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

/** Add a checkout of a repo to a lane (creating the lane if needed). Returns the checkout path. */
export function addRepo(root: Root, entryPath: string, opts: AddOptions): string {
  const src = resolveRepo(root, opts.spec, opts.cwd);
  const path = withEntry(root, entryPath, (model) => {
    ensureLaneRec(model, entryPath, opts.lane, opts.parent ?? null);
    const lane = model.lanes[opts.lane]!;
    if (lane.repos[src.name]) fail(`${src.name} is already in lane ${opts.lane}`);
    const branch = opts.branch ?? lane.branch;
    const checkout = join(entryPath, opts.lane, src.name);
    const baseRef = baseRefFor(model, opts.lane, src.name, src);
    const { base } = addCheckout(root, src, checkout, branch, baseRef);
    lane.repos[src.name] = { source: src.path, base, ...(branch !== lane.branch ? { branch } : {}) };
    return checkout;
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

/** Create a lane; without explicit repos it inherits the parent lane's repos. */
export function createLane(root: Root, entryPath: string, opts: LaneOptions): string {
  const specs = withEntry(root, entryPath, (model) => {
    if (model.lanes[opts.name]) fail(`lane ${opts.name} already exists`);
    if (existsSync(join(entryPath, opts.name))) fail(`${join(entryPath, opts.name)} already exists`);
    ensureLaneRec(model, entryPath, opts.name, opts.parent);
    if (opts.repos.length) return opts.repos;
    const parent = opts.parent ? model.lanes[opts.parent] : undefined;
    return parent ? Object.values(parent.repos).map((r) => r.source) : [];
  });
  for (const spec of specs) addRepo(root, entryPath, { lane: opts.name, spec, cwd: opts.cwd, postAdd: opts.postAdd });
  return join(entryPath, opts.name);
}

export interface RemovalCheck {
  path: string;
  warnings: string[];
}

/** Dirty / unpushed warnings for every checkout below `dir`. */
export function removalWarnings(dir: string): string[] {
  const checkouts = existsSync(join(dir, ".git")) ? [dir] : findCheckouts(dir, 2);
  const out: string[] = [];
  for (const c of checkouts) {
    const s = checkoutStatus(c);
    const what = [s.dirty && "uncommitted changes", s.unpushed > 0 && `${s.unpushed} unpushed commit(s)`, s.rebasing && "rebase in progress"].filter(Boolean);
    if (what.length) out.push(`${c}: ${what.join(", ")}`);
  }
  return out;
}

/** Remove worktrees below `dir` properly, then the folder. Branches are kept. */
export function removeTree(root: Root, dir: string): void {
  for (const c of findCheckouts(dir, 2)) {
    // plain repos (legacy try clone) are just deleted with the folder
    if (existsSync(join(c, ".git")) && !isMainRepo(c)) removeCheckout(root, c);
  }
  rmSync(dir, { recursive: true, force: true });
}

function isMainRepo(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

export function removeLane(root: Root, entryPath: string, lane: string): void {
  withEntry(root, entryPath, (model) => {
    if (!model.lanes[lane]) fail(`unknown lane: ${lane}`);
    const rec = model.lanes[lane]!;
    for (const child of childrenOf(model, lane)) model.lanes[child]!.parent = rec.parent;
    removeTree(root, join(entryPath, lane));
    delete model.lanes[lane];
  });
}

export function removeRepo(root: Root, entryPath: string, lane: string, repo: string): void {
  withEntry(root, entryPath, (model) => {
    const rec = model.lanes[lane];
    if (!rec?.repos[repo]) fail(`${repo} is not in lane ${lane}`);
    removeCheckout(root, join(entryPath, lane, repo));
    delete rec.repos[repo];
  });
}

export function laneOfCwd(model: EntryModel, rest: string[]): string | undefined {
  const lane = rest[0];
  return lane && model.lanes[lane] ? lane : undefined;
}

export { sourceFromPath };
