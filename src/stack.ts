import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeAgentFiles } from "./agents.ts";
import { fail, WorkError } from "./errors.ts";
import { checkoutStatus, git, gitOk, gitTry, isRebasing, revParse, run } from "./git.ts";
import { withLock } from "./lock.ts";
import {
  childrenOf,
  type EntryModel,
  type LaneRec,
  loadModel,
  repoBranch,
  repoParentLane,
  saveModel,
  topoLanes,
} from "./model.ts";
import { parseGitUri } from "./naming.ts";
import { fetchStore, type RepoSource, sourceFromPath, trunkBranchName, trunkRef } from "./repos.ts";
import type { Root } from "./root.ts";

export interface StepReport {
  lane: string;
  repo: string;
  result: "rebased" | "up-to-date" | "skipped" | "conflict" | "merged" | "pushed" | "created" | "updated" | "no-commits";
  detail?: string;
  pr?: number;
}

function say(msg: string): void {
  if (!process.env.WORK_QUIET) process.stderr.write(`${msg}\n`);
}

function ghBin(): string | undefined {
  const bin = process.env.WORK_GH ?? "gh";
  return bin.includes("/") ? (existsSync(bin) ? bin : undefined) : (Bun.which(bin) ?? undefined);
}

function gh(args: string[], cwd?: string): string {
  const bin = ghBin();
  if (!bin) fail("gh (GitHub CLI) not found");
  return run([bin, ...args], { cwd }).stdout.trim();
}

/** `-R` value for gh from a store's origin URL. */
function repoSlug(src: RepoSource): string | undefined {
  if (src.kind !== "store") return undefined;
  const p = parseGitUri(src.url);
  if (!p || p.host === "local") return undefined;
  return p.host === "github.com" ? `${p.user}/${p.repo}` : `${p.host}/${p.user}/${p.repo}`;
}

/** Ref a checkout should sit on: nearest ancestor lane's branch, else the trunk of its source. */
export function parentRefOf(model: EntryModel, lane: string, repo: string): { ref: string; branch: string; lane: string | null } {
  const rec = model.lanes[lane]!.repos[repo]!;
  const src = sourceFromPath(rec.source);
  const parentLane = repoParentLane(model, lane, repo);
  if (parentLane && model.lanes[parentLane]!.repos[repo]!.source === rec.source) {
    const b = repoBranch(model.lanes[parentLane]!, repo);
    return { ref: b, branch: b, lane: parentLane };
  }
  return { ref: trunkRef(src), branch: trunkBranchName(src), lane: null };
}

/** Ask GitHub whether recorded PRs were merged; mark them and lift children of fully merged lanes. */
function refreshMerged(model: EntryModel): string[] {
  const notes: string[] = [];
  if (!ghBin()) return notes;
  for (const [laneName, lane] of Object.entries(model.lanes)) {
    for (const [repo, rec] of Object.entries(lane.repos)) {
      if (!rec.pr || rec.merged) continue;
      const slug = repoSlug(sourceFromPath(rec.source));
      if (!slug) continue;
      const state = gitTryGh(["pr", "view", String(rec.pr), "-R", slug, "--json", "state", "-q", ".state"]);
      if (state === "MERGED") {
        rec.merged = true;
        notes.push(`${laneName}/${repo}: PR #${rec.pr} merged`);
      }
    }
    const repos = Object.values(lane.repos);
    if (repos.length && repos.every((r) => r.merged)) {
      for (const child of childrenOf(model, laneName)) {
        model.lanes[child]!.parent = lane.parent;
        notes.push(`lane ${child} now stacks on ${lane.parent ?? "trunk"} (${laneName} merged; remove it with \`work rm ./${laneName}\`)`);
      }
    }
  }
  return notes;
}

function gitTryGh(args: string[]): string | undefined {
  try {
    return gh(args);
  } catch {
    return undefined;
  }
}

function steps(model: EntryModel): [string, string][] {
  const out: [string, string][] = [];
  for (const lane of topoLanes(model))
    for (const repo of Object.keys(model.lanes[lane]!.repos).sort())
      if (!model.lanes[lane]!.repos[repo]!.merged) out.push([lane, repo]);
  return out;
}

export interface SyncOptions {
  continue?: boolean;
  abort?: boolean;
}

/**
 * Restack every lane checkout onto its parent (parents first). Each rebase runs inside the checkout that has the
 * branch checked out — git's --update-refs would silently skip branches checked out in other worktrees.
 */
export function sync(root: Root, entryPath: string, opts: SyncOptions = {}): StepReport[] {
  return withLock(root.stateDir, `entry:${entryPath}`, () => {
    const model = loadModel(entryPath);
    const save = () => {
      saveModel(entryPath, model);
      writeAgentFiles(root, entryPath, model);
    };
    if (!Object.keys(model.lanes).length) fail("no lanes in this entry");

    if (opts.abort) {
      const cur = model.sync?.pending[0];
      if (!cur) fail("no sync in progress");
      const checkout = join(entryPath, cur[0], cur[1]);
      if (isRebasing(checkout)) git(checkout, ["rebase", "--abort"]);
      model.sync = null;
      save();
      say(`sync aborted (${cur[0]}/${cur[1]} restored)`);
      return [];
    }

    const reports: StepReport[] = [];
    let queue: [string, string][];
    if (opts.continue) {
      if (!model.sync?.pending.length) fail("no sync in progress");
      queue = model.sync.pending;
      const [lane, repo] = queue[0]!;
      const checkout = join(entryPath, lane, repo);
      if (isRebasing(checkout)) {
        const unmerged = gitTry(checkout, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
        if (unmerged) fail(`conflicts remain in ${checkout}:\n${unmerged}\nResolve them, \`git add\`, then \`work sync --continue\`.`);
        const r = run(["git", "-C", checkout, "rebase", "--continue"], { allowFail: true, env: { GIT_EDITOR: "true" } });
        if (r.code !== 0 && isRebasing(checkout)) fail(`rebase still stopped in ${checkout}:\n${r.stderr.trim()}`);
      }
      const { ref } = parentRefOf(model, lane, repo);
      model.lanes[lane]!.repos[repo]!.base = revParse(checkout, ref)!;
      reports.push({ lane, repo, result: "rebased", detail: "continued" });
      queue = queue.slice(1);
    } else {
      if (model.sync?.pending.length) {
        const [l, r] = model.sync.pending[0]!;
        fail(`a sync is in progress (stopped at ${l}/${r}); use --continue or --abort`);
      }
      for (const rec of Object.values(model.lanes).flatMap((l) => Object.values(l.repos))) {
        const src = sourceFromPath(rec.source);
        if (src.kind === "store") fetchStore(root, src.path, true);
      }
      for (const n of refreshMerged(model)) say(n);
      queue = steps(model);
    }

    while (queue.length) {
      const [lane, repo] = queue[0]!;
      const laneRec = model.lanes[lane]!;
      const rec = laneRec.repos[repo]!;
      const checkout = join(entryPath, lane, repo);
      const branch = repoBranch(laneRec, repo);
      const report = (result: StepReport["result"], detail?: string) => {
        reports.push({ lane, repo, result, detail });
        say(`${lane}/${repo}: ${result}${detail ? ` (${detail})` : ""}`);
        queue = queue.slice(1);
      };
      if (!existsSync(checkout)) {
        report("skipped", "checkout missing");
        continue;
      }
      const st = checkoutStatus(checkout);
      if (st.branch !== branch) {
        report("skipped", `checkout is on ${st.branch ?? "a detached HEAD"}, expected ${branch}`);
        continue;
      }
      if (st.dirty) {
        report("skipped", "uncommitted changes");
        continue;
      }
      const { ref } = parentRefOf(model, lane, repo);
      const onto = revParse(checkout, ref);
      if (!onto) {
        report("skipped", `parent ref ${ref} not found`);
        continue;
      }
      if (gitOk(checkout, ["merge-base", "--is-ancestor", onto, branch])) {
        rec.base = onto;
        report("up-to-date");
        continue;
      }
      let upstream = rec.base;
      if (!revParse(checkout, upstream) || !gitOk(checkout, ["merge-base", "--is-ancestor", upstream, branch])) {
        upstream = gitTry(checkout, ["merge-base", branch, onto]) ?? onto;
      }
      model.sync = { pending: queue };
      save();
      const r = run(["git", "-C", checkout, "rebase", "--onto", onto, upstream, branch], {
        allowFail: true,
        env: { GIT_EDITOR: "true" },
      });
      if (r.code !== 0) {
        if (isRebasing(checkout)) {
          reports.push({ lane, repo, result: "conflict", detail: checkout });
          throw new WorkError(
            `conflict while rebasing ${lane}/${repo} onto ${ref}.\n` +
              `Resolve in ${checkout}, \`git add\` the files, then run \`work sync --continue\` (or \`work sync --abort\`).`,
          );
        }
        model.sync = null;
        save();
        throw new WorkError(`rebase of ${lane}/${repo} failed: ${r.stderr.trim()}`);
      }
      rec.base = onto;
      report("rebased", `onto ${ref}`);
      model.sync = queue.length ? { pending: queue } : null;
      save();
    }
    model.sync = null;
    save();
    return reports;
  });
}

export interface SubmitOptions {
  draft?: boolean;
}

/** Push every lane checkout that has commits over its parent and open/retarget one PR per checkout. */
export function submit(root: Root, entryPath: string, opts: SubmitOptions = {}): StepReport[] {
  return withLock(root.stateDir, `entry:${entryPath}`, () => {
    const model = loadModel(entryPath);
    const save = () => {
      saveModel(entryPath, model);
      writeAgentFiles(root, entryPath, model);
    };
    if (!Object.keys(model.lanes).length) fail("no lanes in this entry");
    if (model.sync?.pending.length) fail("a sync is in progress; finish it first (`work sync --continue`)");
    const reports: StepReport[] = [];
    for (const [lane, repo] of steps(model)) {
      const laneRec: LaneRec = model.lanes[lane]!;
      const rec = laneRec.repos[repo]!;
      const src = sourceFromPath(rec.source);
      const checkout = join(entryPath, lane, repo);
      const branch = repoBranch(laneRec, repo);
      const push = (result: StepReport["result"], detail?: string, pr?: number) => {
        reports.push({ lane, repo, result, detail, pr });
        say(`${lane}/${repo}: ${result}${pr ? ` #${pr}` : ""}${detail ? ` (${detail})` : ""}`);
      };
      const slug = repoSlug(src);
      if (!slug) {
        push("skipped", "not a GitHub store (local repo or non-URL origin)");
        continue;
      }
      if (!existsSync(checkout)) {
        push("skipped", "checkout missing");
        continue;
      }
      const parent = parentRefOf(model, lane, repo);
      const ahead = Number(gitTry(checkout, ["rev-list", "--count", `${parent.ref}..${branch}`]) ?? "0");
      if (!ahead) {
        push("no-commits", `nothing over ${parent.branch}`);
        continue;
      }
      git(checkout, ["push", "--quiet", "--force-with-lease", "-u", "origin", `${branch}:${branch}`], { progress: true });
      if (rec.pr) {
        const view = gitTryGh(["pr", "view", String(rec.pr), "-R", slug, "--json", "state,baseRefName"]);
        const state = view ? (JSON.parse(view) as { state: string; baseRefName: string }) : undefined;
        if (state?.state === "MERGED") {
          rec.merged = true;
          push("merged", undefined, rec.pr);
        } else if (state && state.baseRefName !== parent.branch) {
          gh(["pr", "edit", String(rec.pr), "-R", slug, "--base", parent.branch]);
          push("updated", `base → ${parent.branch}`, rec.pr);
        } else push("pushed", undefined, rec.pr);
        save();
        continue;
      }
      const existing = gitTryGh(["pr", "list", "-R", slug, "--head", branch, "--state", "open", "--json", "number", "-q", ".[0].number"]);
      if (existing) {
        rec.pr = Number(existing);
        if (parent.branch) gitTryGh(["pr", "edit", existing, "-R", slug, "--base", parent.branch]);
        push("updated", "adopted existing PR", rec.pr);
        save();
        continue;
      }
      const title = gitTry(checkout, ["log", "--reverse", "--format=%s", `${parent.ref}..${branch}`])?.split("\n")[0] || branch;
      const parentPr = parent.lane ? model.lanes[parent.lane]!.repos[repo]?.pr : undefined;
      const body = [
        `Lane \`${lane}\` of workspace \`${entryPath.split("/").pop()}\` (managed by \`work\`).`,
        parentPr ? `Stacked on #${parentPr}.` : parent.lane ? `Stacked on branch \`${parent.branch}\`.` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const url = gh(["pr", "create", "-R", slug, "--head", branch, "--base", parent.branch, "--title", title, "--body", body, ...(opts.draft ? ["--draft"] : [])], checkout);
      const num = Number(url.trim().split("/").pop());
      if (!Number.isFinite(num)) fail(`could not parse PR number from: ${url}`);
      rec.pr = num;
      push("created", url.trim(), num);
      save();
    }
    return reports;
  });
}
