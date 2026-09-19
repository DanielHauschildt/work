import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.ts";

export interface RepoRec {
  /** Bare store path, or a local repository (try's `work .`). */
  source: string;
  /** Branch when it differs from the lane branch (e.g. an existing PR branch). */
  branch?: string;
  /** Commit the branch was last based on (fork point for restacking). */
  base: string;
  pr?: number;
  merged?: boolean;
}

export interface LaneRec {
  parent: string | null;
  branch: string;
  repos: Record<string, RepoRec>;
}

export interface SyncState {
  /** Remaining [lane, repo] steps, the first one is the one that stopped. */
  pending: [string, string][];
}

export interface EntryModel {
  version: 1;
  lanes: Record<string, LaneRec>;
  sync: SyncState | null;
}

export const MODEL_FILE = ".work.json";

export function modelPath(entryPath: string): string {
  return join(entryPath, MODEL_FILE);
}

export function hasModel(entryPath: string): boolean {
  return existsSync(modelPath(entryPath));
}

export function loadModel(entryPath: string): EntryModel {
  const file = modelPath(entryPath);
  if (!existsSync(file)) return { version: 1, lanes: {}, sync: null };
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as EntryModel;
    m.lanes ??= {};
    m.sync ??= null;
    return m;
  } catch (e) {
    fail(`${file}: ${(e as Error).message}`);
  }
}

export function saveModel(entryPath: string, model: EntryModel): void {
  const file = modelPath(entryPath);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(model, null, 2)}\n`);
  renameSync(tmp, file);
}

export function repoBranch(lane: LaneRec, repo: string): string {
  return lane.repos[repo]?.branch ?? lane.branch;
}

/** Lanes ordered parents-first (roots sorted by name, then children by name). */
export function topoLanes(model: EntryModel): string[] {
  const names = Object.keys(model.lanes).sort();
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string, stack: Set<string>) => {
    if (seen.has(name)) return;
    if (stack.has(name)) fail(`lane cycle at ${name}`);
    stack.add(name);
    const parent = model.lanes[name]!.parent;
    if (parent && model.lanes[parent]) visit(parent, stack);
    stack.delete(name);
    seen.add(name);
    out.push(name);
  };
  for (const n of names) visit(n, new Set());
  return out;
}

export function childrenOf(model: EntryModel, lane: string): string[] {
  return Object.keys(model.lanes)
    .filter((n) => model.lanes[n]!.parent === lane)
    .sort();
}

/** Nearest ancestor lane (excluding `lane`) that contains `repo`, or null for trunk. */
export function repoParentLane(model: EntryModel, lane: string, repo: string): string | null {
  let p = model.lanes[lane]?.parent ?? null;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    seen.add(p);
    const rec = model.lanes[p];
    if (!rec) return null;
    if (rec.repos[repo] && !rec.repos[repo]!.merged) return p;
    p = rec.parent;
  }
  return null;
}
