import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fail, WorkError } from "./errors.ts";
import { commonDirOf, git, gitOk, gitTry, revParse, run } from "./git.ts";
import { withLock } from "./lock.ts";
import { isGitUri, parseGitUri } from "./naming.ts";
import { expandHome, real, type Root } from "./root.ts";

export type RepoSource =
  | { kind: "store"; path: string; name: string; url: string }
  | { kind: "local"; path: string; name: string };

const fetched = new Set<string>();

function log(msg: string): void {
  if (!process.env.WORK_QUIET) process.stderr.write(`${msg}\n`);
}

export function storePathFor(root: Root, url: string): string {
  const p = parseGitUri(url);
  if (!p) fail(`Unable to parse git URI: ${url}`);
  return join(root.reposDir, p.host, p.user, `${p.repo}.git`);
}

/** Bare store with a proper fetch refspec (bare clones have none) and no local branches. */
export function ensureStore(root: Root, url: string): RepoSource {
  const path = storePathFor(root, url);
  const name = basename(path, ".git");
  withLock(root.stateDir, path, () => {
    if (!existsSync(join(path, "HEAD"))) {
      log(`Creating store ${path.replace(root.path + "/", "")} from ${url}`);
      mkdirSync(path, { recursive: true });
      try {
        git(path, ["init", "--bare", "--quiet"]);
        git(path, ["remote", "add", "origin", url]);
        git(path, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        git(path, ["fetch", "--quiet", "origin"], { progress: true });
        git(path, ["remote", "set-head", "origin", "--auto"], { allowFail: true });
      } catch (e) {
        rmSync(path, { recursive: true, force: true });
        throw e;
      }
      fetched.add(path);
    }
  });
  fetchStore(root, path);
  return { kind: "store", path, name, url };
}

/** Fetch a store (once per process unless forced). */
export function fetchStore(root: Root, store: string, force = false): void {
  if ((fetched.has(store) && !force) || process.env.WORK_NO_FETCH) return;
  withLock(root.stateDir, store, () => {
    git(store, ["fetch", "--quiet", "--prune", "origin"], { progress: true });
    if (!gitOk(store, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])) {
      git(store, ["remote", "set-head", "origin", "--auto"], { allowFail: true });
    }
  });
  fetched.add(store);
}

export function listStores(root: Root): string[] {
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      if (n.endsWith(".git") && existsSync(join(p, "HEAD"))) out.push(p);
      else if (level < 3 && statSync(p, { throwIfNoEntry: false })?.isDirectory()) walk(p, level + 1);
    }
  };
  walk(root.reposDir, 1);
  return out.sort();
}

/** `owner/repo` shorthand for stores, e.g. `imgly/cesdk-web`. */
export function storeLabel(root: Root, store: string): string {
  const parts = store.slice(root.reposDir.length + 1).split("/");
  return parts.slice(-2).join("/").replace(/\.git$/, "");
}

/**
 * Repo spec → source.
 *  - git URL / path ending in .git → store
 *  - existing local directory inside a git work tree → local repo (worktree from it)
 *  - `owner/repo` → store for https://github.com/owner/repo.git (or an existing store with that label)
 *  - bare name → the unique existing store with that name
 */
export function resolveRepo(root: Root, spec: string, cwd: string): RepoSource {
  const expanded = expandHome(spec);
  const asPath = resolve(cwd, expanded);
  const looksLikePath = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~");
  if (looksLikePath && existsSync(asPath) && real(asPath).startsWith(root.reposDir + "/") && existsSync(join(asPath, "HEAD"))) {
    const store = real(asPath);
    fetchStore(root, store);
    return storeSource(store);
  }
  if (looksLikePath && existsSync(asPath) && !spec.endsWith(".git")) {
    const top = gitTry(asPath, ["rev-parse", "--show-toplevel"]);
    if (!top) fail(`not a git repository: ${spec}`);
    // a worktree of a store (e.g. inside another workspace) → use the store; a worktree of a plain repo → its main repo
    const common = gitTry(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common && real(common).startsWith(root.reposDir + "/")) {
      fetchStore(root, real(common));
      return storeSource(real(common));
    }
    const main = common && basename(common) === ".git" ? dirname(common) : top;
    return { kind: "local", path: real(main), name: basename(real(main)) };
  }
  if (isGitUri(spec)) {
    const url = looksLikePath ? asPath : spec;
    return ensureStore(root, url);
  }
  const stores = listStores(root);
  if (/^[\w.-]+\/[\w.-]+$/.test(spec)) {
    const hit = stores.find((s) => storeLabel(root, s) === spec);
    if (hit) {
      fetchStore(root, hit);
      return storeSource(hit);
    }
    return ensureStore(root, `https://github.com/${spec}.git`);
  }
  const hits = stores.filter((s) => basename(s, ".git") === spec);
  if (hits.length === 1) {
    fetchStore(root, hits[0]!);
    return storeSource(hits[0]!);
  }
  if (hits.length > 1) fail(`'${spec}' is ambiguous: ${hits.map((h) => storeLabel(root, h)).join(", ")}`);
  fail(`unknown repo '${spec}' — use a URL, owner/repo, or a path`);
}

export function storeSource(path: string): RepoSource {
  // raw config value: `remote get-url` would apply url.insteadOf rewrites
  const url = gitTry(path, ["config", "--get", "remote.origin.url"]) ?? "";
  return { kind: "store", path, name: basename(path, ".git"), url };
}

export function sourceFromPath(path: string): RepoSource {
  return existsSync(join(path, "HEAD")) && !existsSync(join(path, ".git"))
    ? storeSource(path)
    : { kind: "local", path, name: basename(path) };
}

/** Trunk ref of a source: `origin/<default>` for stores, the current HEAD commit for local repos. */
export function trunkRef(src: RepoSource): string {
  if (src.kind === "local") {
    const sha = revParse(src.path, "HEAD");
    if (!sha) fail(`${src.path} has no commits`);
    return sha;
  }
  const head = gitTry(src.path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head && revParse(src.path, head)) return head;
  for (const b of ["origin/main", "origin/master", "origin/trunk"]) if (revParse(src.path, b)) return b;
  fail(`cannot determine the default branch of ${src.path}`);
}

export function trunkBranchName(src: RepoSource): string {
  if (src.kind === "local") return gitTry(src.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "HEAD";
  return trunkRef(src).replace(/^origin\//, "");
}

export interface AddWorktreeResult {
  base: string;
  created: boolean;
}

/**
 * Create a worktree at `path` on `branch`:
 * existing local branch → check it out; `origin/<branch>` → track it; else new branch from `baseRef`.
 */
export function addWorktree(
  root: Root,
  src: RepoSource,
  path: string,
  branch: string,
  baseRef: string,
): AddWorktreeResult {
  if (existsSync(path)) fail(`${path} already exists`);
  mkdirSync(dirname(path), { recursive: true });
  return withLock(root.stateDir, src.path, () => {
    const local = revParse(src.path, `refs/heads/${branch}`);
    const remote = src.kind === "store" ? revParse(src.path, `refs/remotes/origin/${branch}`) : undefined;
    let args: string[];
    if (local) args = ["worktree", "add", "--quiet", path, branch];
    else if (remote) args = ["worktree", "add", "--quiet", "--track", "-b", branch, path, `origin/${branch}`];
    else args = ["worktree", "add", "--quiet", "-b", branch, path, baseRef];
    const r = run(["git", "-C", src.path, ...args], { allowFail: true });
    if (r.code !== 0) {
      const msg = r.stderr.trim();
      if (/already (checked out|used by worktree)/.test(msg))
        fail(`branch '${branch}' is already checked out in another worktree:\n${msg}\nPick another lane or pass a branch.`);
      throw new WorkError(`git worktree add failed: ${msg}`);
    }
    const baseSha = revParse(src.path, baseRef) ?? baseRef;
    const base = local || remote ? (gitTry(src.path, ["merge-base", branch, baseSha]) ?? baseSha) : baseSha;
    return { base, created: !local && !remote };
  });
}

/** Remove a worktree cleanly (branch is kept); falls back to deleting the folder and pruning. */
export function removeWorktree(root: Root, worktree: string): void {
  const common = commonDirOf(worktree);
  if (!common) {
    rmSync(worktree, { recursive: true, force: true });
    return;
  }
  withLock(root.stateDir, commonKey(common), () => {
    run(["git", "--git-dir", common, "worktree", "remove", "--force", "--force", worktree], { allowFail: true });
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
    run(["git", "--git-dir", common, "worktree", "prune"], { allowFail: true });
  });
}

/** Lock key for a common git dir: the store path itself, or the repo toplevel for local repos. */
export function commonKey(common: string): string {
  return basename(common) === ".git" ? dirname(common) : common;
}

/** After a worktree moved on disk, reconnect it with its store. */
export function repairWorktree(worktree: string): void {
  run(["git", "-C", worktree, "worktree", "repair"], { allowFail: true });
}
