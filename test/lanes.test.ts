import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addRepo, createLane, removeLane, removeRepo } from "../src/lanes.ts";
import { loadModel } from "../src/model.ts";
import { Root } from "../src/root.ts";
import { commit, g, makeRemote, type Sandbox, sandbox } from "./helpers.ts";

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
    expect(worktree).toBe(join(workspace, "root", "app"));
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
    const lanePath = createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    expect(lanePath).toBe(join(workspace, "ui"));
    const ui = join(lanePath, "app");
    expect(g(ui, "branch", "--show-current")).toBe("IMG-1234-autofit-ui");
    expect(g(ui, "rev-parse", "HEAD")).toBe(tip);
    expect(existsSync(join(lanePath, "docs"))).toBe(true);
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

  test("agent files describe the workspace and each lane", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    const top = readFileSync(join(workspace, "AGENTS.md"), "utf8");
    expect(top).toContain("| `ui/` | `IMG-1234-autofit-ui` | root | app |");
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const lane = readFileSync(join(workspace, "ui", "AGENTS.md"), "utf8");
    expect(lane).toContain("Stacked on: lane `root`");
    expect(lane).toContain("Other lanes (off-limits): root");
  });

  test("agent file keeps user content outside the generated block", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    const file = join(workspace, "AGENTS.md");
    require("node:fs").writeFileSync(file, `${readFileSync(file, "utf8")}\n## My notes\nkeep me\n`);
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("keep me");
    expect(text).toContain("`ui/`");
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
    expect(existsSync(join(workspace, "ui"))).toBe(false);
    const store = join(sb.root, ".repos", "local", "remotes", "app.git");
    expect(g(store, "branch", "--list", "IMG-1234-autofit-ui")).toContain("IMG-1234-autofit-ui");
    expect(g(store, "worktree", "list")).not.toContain("/ui/");
  });

  test("removing a repo from a lane removes only that worktree", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    addRepo(root, workspace, { lane: "root", spec: docs, cwd: sb.dir });
    removeRepo(root, workspace, "root", "docs");
    expect(existsSync(join(workspace, "root", "docs"))).toBe(false);
    expect(existsSync(join(workspace, "root", "app"))).toBe(true);
    expect(Object.keys(loadModel(workspace).lanes.root!.repos)).toEqual(["app"]);
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
