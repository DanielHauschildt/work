import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addRepo, createLane, legacyLanes, removeLane, removeRepo, requireFlatLayout } from "../src/lanes.ts";
import { loadModel } from "../src/model.ts";
import { Root } from "../src/root.ts";
import { commit, g, makeRemote, type Sandbox, sandbox, sh } from "./helpers.ts";

let sb: Sandbox;
let root: Root;
let workspace: string;
let app: string;
let docs: string;

beforeEach(() => {
  sb = sandbox();
  root = new Root(sb.root);
  workspace = join(sb.root, "labs", "IMG-1234-autofit");
  app = makeRemote(sb, "app");
  docs = makeRemote(sb, "docs");
  require("node:fs").mkdirSync(workspace, { recursive: true });
});
afterEach(() => sb.cleanup());

describe("repo store", () => {
  test("add creates a bare store with fetch refspec and a worktree in lane root", () => {
    const worktree = addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    expect(worktree).toBe(join(workspace, "app")); // lane root: no @suffix
    const store = join(sb.root, ".repos", "local", "remotes", "app.git");
    expect(g(store, "config", "--get", "core.bare")).toBe("true");
    expect(g(store, "config", "--get", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(g(store, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    expect(g(worktree, "branch", "--show-current")).toBe("IMG-1234-autofit");
    // no stale local copies of remote branches in the store
    expect(g(store, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/IMG-1234-autofit");
    const model = loadModel(workspace);
    expect(model.lanes.root!.parent).toBeNull();
    expect(model.lanes.root!.repos.app!.base).toBe(g(store, "rev-parse", "origin/main"));
  });

  test("bare repo name resolves to the existing store", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    const worktree = addRepo(root, workspace, { lane: "other", spec: "app", cwd: sb.dir, branch: "custom" });
    expect(g(worktree, "branch", "--show-current")).toBe("custom");
    expect(loadModel(workspace).lanes.other!.repos.app!.branch).toBe("custom");
  });

  test("existing remote branch is tracked instead of created", () => {
    const seed = join(sb.dir, "seed-app");
    g(seed, "checkout", "-q", "-b", "feature-x");
    commit(seed, "f.txt", "x");
    g(seed, "push", "-q", "origin", "feature-x");
    const worktree = addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir, branch: "feature-x" });
    expect(g(worktree, "rev-parse", "HEAD")).toBe(g(seed, "rev-parse", "HEAD"));
    expect(g(worktree, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/feature-x");
  });
});

describe("lanes", () => {
  test("stacked lane inherits the parent's repos and branches from the parent branch", () => {
    const rootWorktree = addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    addRepo(root, workspace, { lane: "root", spec: docs, cwd: sb.dir });
    const tip = commit(rootWorktree, "core.txt", "core");
    const paths = createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    expect(paths).toEqual([join(workspace, "app@ui"), join(workspace, "docs@ui")]);
    const ui = join(workspace, "app@ui");
    expect(g(ui, "branch", "--show-current")).toBe("IMG-1234-autofit-ui");
    expect(g(ui, "rev-parse", "HEAD")).toBe(tip);
    expect(existsSync(join(workspace, "docs@ui"))).toBe(true);
    expect(existsSync(join(workspace, "ui"))).toBe(false); // a lane is not a folder
    const model = loadModel(workspace);
    expect(model.lanes.ui!.parent).toBe("root");
    expect(model.lanes.ui!.repos.app!.base).toBe(tip);
  });

  test("repo missing in the parent lane is based on trunk", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    createLane(root, workspace, { name: "guide", parent: "root", repos: [docs], cwd: sb.dir });
    const store = join(sb.root, ".repos", "local", "remotes", "docs.git");
    expect(loadModel(workspace).lanes.guide!.repos.docs!.base).toBe(g(store, "rev-parse", "origin/main"));
  });

  test("the workspace AGENTS.md lists every lane with its folders; worktrees get none", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    const top = readFileSync(join(workspace, "AGENTS.md"), "utf8");
    expect(top).toContain("| `root` | `IMG-1234-autofit` | trunk | `app/` |");
    expect(top).toContain("| `ui` | `IMG-1234-autofit-ui` | root | `app@ui/` |");
    expect(top).toContain("Your folders are the ones whose suffix is your lane (`@ui` for lane `ui`)");
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    // a generated file inside a worktree would be untracked in the user's repo
    expect(existsSync(join(workspace, "app@ui", "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspace, "app@ui", "CLAUDE.md"))).toBe(false);
  });

  test("agent file keeps user content outside the generated block", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    const file = join(workspace, "AGENTS.md");
    require("node:fs").writeFileSync(file, `${readFileSync(file, "utf8")}\n## My notes\nkeep me\n`);
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("keep me");
    expect(text).toContain("`app@ui/`");
    expect(text.match(/work:begin/g)!.length).toBe(1);
  });

  test("removing a lane re-parents its children and keeps the branch", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    createLane(root, workspace, { name: "polish", parent: "ui", repos: [], cwd: sb.dir });
    removeLane(root, workspace, "ui");
    const model = loadModel(workspace);
    expect(model.lanes.ui).toBeUndefined();
    expect(model.lanes.polish!.parent).toBe("root");
    expect(existsSync(join(workspace, "app@ui"))).toBe(false);
    expect(existsSync(join(workspace, "app@polish"))).toBe(true);
    const store = join(sb.root, ".repos", "local", "remotes", "app.git");
    expect(g(store, "branch", "--list", "IMG-1234-autofit-ui")).toContain("IMG-1234-autofit-ui");
    expect(g(store, "worktree", "list")).not.toContain("app@ui");
  });

  test("removing a repo from a lane removes only that worktree", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    addRepo(root, workspace, { lane: "root", spec: docs, cwd: sb.dir });
    removeRepo(root, workspace, "root", "docs");
    expect(existsSync(join(workspace, "docs"))).toBe(false);
    expect(existsSync(join(workspace, "app"))).toBe(true);
    expect(Object.keys(loadModel(workspace).lanes.root!.repos)).toEqual(["app"]);
  });

  test("a repo named like a lane never looks like the old layout", () => {
    // worktree <ws>/ui in lane root, with a subfolder named like the repo of lane ui
    const uiRepo = makeRemote(sb, "ui");
    addRepo(root, workspace, { lane: "root", spec: uiRepo, cwd: sb.dir });
    addRepo(root, workspace, { lane: "ui", spec: app, cwd: sb.dir, parent: "root" });
    mkdirSync(join(workspace, "ui", "app"), { recursive: true });

    expect(legacyLanes(workspace, loadModel(workspace))).toEqual([]);
    expect(() => requireFlatLayout(workspace, loadModel(workspace))).not.toThrow();
    // and a real old-layout folder is still detected: lane root's own worktree back under <ws>/root/
    mkdirSync(join(workspace, "root"), { recursive: true });
    sh(["git", "-C", join(workspace, "ui"), "worktree", "move", join(workspace, "ui"), join(workspace, "root", "ui")]);
    expect(legacyLanes(workspace, loadModel(workspace))).toEqual(["root"]);
    expect(() => requireFlatLayout(workspace, loadModel(workspace))).toThrow(/still uses lane folders \(root\)/);
  });

  test("a lane whose worktrees all fail is rolled back; a partial one says how to go on", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    addRepo(root, workspace, { lane: "root", spec: docs, cwd: sb.dir });
    // the branch of the lane-to-be is already checked out elsewhere, so every addRepo fails
    addRepo(root, workspace, { lane: "blocked", spec: app, cwd: sb.dir, parent: "root", branch: "IMG-1234-autofit-ui" });
    expect(() => createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir })).toThrow(/already checked out/);
    expect(loadModel(workspace).lanes.ui).toBeUndefined(); // nothing created → no lane record
    expect(existsSync(join(workspace, "app@ui"))).toBe(false);

    // now only the second repo fails: the lane keeps the first worktree
    addRepo(root, workspace, { lane: "half", spec: docs, cwd: sb.dir, parent: "root", branch: "IMG-1234-autofit-mixed" });
    expect(() => createLane(root, workspace, { name: "mixed", parent: "root", repos: [], cwd: sb.dir })).toThrow(
      /Lane mixed has 1 of 2 worktrees: add the rest with `work add <repo> --lane mixed`, or drop the lane with `work rm \.\/mixed`/,
    );
    expect(Object.keys(loadModel(workspace).lanes.mixed!.repos)).toEqual(["app"]);
    expect(existsSync(join(workspace, "app@mixed"))).toBe(true);
    // running the same command again says the same two ways out, with the missing repo named
    expect(() => createLane(root, workspace, { name: "mixed", parent: "root", repos: [], cwd: sb.dir })).toThrow(
      "lane mixed already exists with 1 of 2 worktrees: add the rest with `work add docs --lane mixed`, or drop the lane with `work rm ./mixed`",
    );
  });

  test("same branch twice is rejected with a hint", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    expect(() => addRepo(root, workspace, { lane: "b", spec: "app", cwd: sb.dir, branch: "IMG-1234-autofit" })).toThrow(
      /already checked out/,
    );
  });

  test("local repo source (try's `.`) creates a named branch at its HEAD", () => {
    const seed = join(sb.dir, "seed-app");
    const head = g(seed, "rev-parse", "HEAD");
    const worktree = addRepo(root, workspace, { lane: "root", spec: seed, cwd: sb.dir });
    expect(g(worktree, "branch", "--show-current")).toBe("IMG-1234-autofit");
    expect(g(worktree, "rev-parse", "HEAD")).toBe(head);
    expect(loadModel(workspace).lanes.root!.repos["seed-app"]!.source).toBe(seed);
  });
});
