import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAgentFiles } from "./agents.ts";
import { fail } from "./errors.ts";
import { commonDirOf, isLinkedWorktree, run, worktreeStatus } from "./git.ts";
import { legacyLanes } from "./lanes.ts";
import { withLock } from "./lock.ts";
import { loadModel, saveModel, type WorkspaceModel } from "./model.ts";
import { worktreeDir } from "./naming.ts";
import { commonKey } from "./repos.ts";
import type { Root } from "./root.ts";

interface Move {
  from: string;
  to: string;
  /** a plain repo (legacy `try clone`) is moved with the filesystem, a worktree with git */
  plain: boolean;
}

export interface MigrationReport {
  workspace: string;
  moved: string[];
  keptFolders: string[];
}

/** Files `work` generated inside a lane folder; they are recreated at workspace level. */
const GENERATED = ["AGENTS.md", "CLAUDE.md"];

/**
 * Convert `<workspace>/<lane>/<repo>` folders to `<workspace>/<repo>[@<lane>]`. Everything is checked first
 * (dirty worktrees, collisions), so a refusal leaves the workspace untouched.
 */
export function migrateWorkspace(root: Root, workspacePath: string, opts: { force?: boolean } = {}): MigrationReport {
  const model = loadModel(workspacePath);
  const lanes = legacyLanes(workspacePath, model);
  const report: MigrationReport = { workspace: workspacePath, moved: [], keptFolders: [] };
  if (!lanes.length) return report;

  const moves: Move[] = [];
  for (const lane of lanes) {
    for (const repo of Object.keys(model.lanes[lane]!.repos)) {
      const from = join(workspacePath, lane, repo);
      if (!existsSync(from)) continue; // already moved, or never created
      const to = join(workspacePath, worktreeDir(lane, repo));
      if (existsSync(to)) fail(`${to} already exists`);
      if (!opts.force) {
        const st = worktreeStatus(from);
        if (st.dirty || st.unpushed > 0 || st.rebasing) fail(`${from} has uncommitted or unpushed work (use --force)`);
      }
      moves.push({ from, to, plain: !isLinkedWorktree(from) });
    }
  }

  for (const move of moves) {
    const common = move.plain ? undefined : commonDirOf(move.from);
    if (common) withLock(root.stateDir, commonKey(common), () => run(["git", "--git-dir", common, "worktree", "move", move.from, move.to]));
    else renameSync(move.from, move.to);
    report.moved.push(move.to);
  }

  for (const lane of lanes) {
    const dir = join(workspacePath, lane);
    if (!existsSync(dir)) continue;
    const left = readdirSync(dir).filter((n) => !GENERATED.includes(n));
    if (left.length && !opts.force) {
      report.keptFolders.push(dir);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }

  saveModel(workspacePath, model);
  writeAgentFiles(root, workspacePath, model);
  return report;
}

export function needsMigration(workspacePath: string, model: WorkspaceModel): boolean {
  return legacyLanes(workspacePath, model).length > 0;
}
