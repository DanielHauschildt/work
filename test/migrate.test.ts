import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRepo, createLane, legacyLanes } from "../src/lanes.ts";
import { migrateWorkspace } from "../src/migrate.ts";
import { loadModel, saveModel } from "../src/model.ts";
import { Root } from "../src/root.ts";
import { g, makeRemote, type Sandbox, sandbox, sh } from "./helpers.ts";

let sb: Sandbox;
let root: Root;
let workspace: string;
let app: string;
let docs: string;

/** Put a worktree back into the layout `work` used before: `<workspace>/<lane>/<repo>`. */
function toOldLayout(lane: string, repo: string): string {
  const flat = join(workspace, lane === "root" ? repo : `${repo}@${lane}`);
  const old = join(workspace, lane, repo);
  mkdirSync(join(workspace, lane), { recursive: true });
  sh(["git", "-C", flat, "worktree", "move", flat, old]);
  writeFileSync(join(workspace, lane, "AGENTS.md"), "<!-- work:begin -->\nold lane file\n<!-- work:end -->\n");
  writeFileSync(join(workspace, lane, "CLAUDE.md"), "@AGENTS.md\n");
  return old;
}

beforeEach(() => {
  sb = sandbox();
  root = new Root(sb.root);
  workspace = join(sb.root, "labs", "IMG-1234-autofit");
  mkdirSync(workspace, { recursive: true });
  app = makeRemote(sb, "app");
  docs = makeRemote(sb, "docs");
});
afterEach(() => sb.cleanup());

describe("migrate", () => {
  test("moves every worktree, drops the lane folders and rewrites AGENTS.md", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    addRepo(root, workspace, { lane: "root", spec: docs, cwd: sb.dir });
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    for (const [lane, repo] of [["root", "app"], ["root", "docs"], ["ui", "app"], ["ui", "docs"]] as const) toOldLayout(lane, repo);

    const report = migrateWorkspace(root, workspace);
    expect(report.moved.map((p) => p.slice(workspace.length + 1)).sort()).toEqual(["app", "app@ui", "docs", "docs@ui"]);
    expect(report.keptFolders).toEqual([]);
    for (const folder of ["app", "docs", "app@ui", "docs@ui"]) expect(existsSync(join(workspace, folder))).toBe(true);
    expect(existsSync(join(workspace, "root"))).toBe(false);
    expect(existsSync(join(workspace, "ui"))).toBe(false);
    // git knows the new paths, and the worktrees still work
    const store = join(sb.root, ".repos", "local", "remotes", "app.git");
    const list = g(store, "worktree", "list");
    expect(list).toContain(join(workspace, "app@ui"));
    expect(list).not.toContain(join(workspace, "ui", "app"));
    expect(g(join(workspace, "app@ui"), "status", "--porcelain")).toBe("");
    expect(g(join(workspace, "app@ui"), "branch", "--show-current")).toBe("IMG-1234-autofit-ui");
    // AGENTS.md is regenerated at workspace level only
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain("| `ui` | `IMG-1234-autofit-ui` | root | `app@ui/`, `docs@ui/` |");
    expect(existsSync(join(workspace, "app@ui", "AGENTS.md"))).toBe(false);
  });

  test("nothing to do is not an error, and migrating twice is a no-op", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    expect(migrateWorkspace(root, workspace).moved).toEqual([]);
    toOldLayout("root", "app");
    expect(migrateWorkspace(root, workspace).moved).toEqual([join(workspace, "app")]);
    expect(migrateWorkspace(root, workspace).moved).toEqual([]);
  });

  test("uncommitted changes refuse the whole workspace; --force migrates it", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    addRepo(root, workspace, { lane: "root", spec: docs, cwd: sb.dir });
    toOldLayout("root", "app");
    const dirty = toOldLayout("root", "docs");
    writeFileSync(join(dirty, "wip.txt"), "wip");

    expect(() => migrateWorkspace(root, workspace)).toThrow(/uncommitted changes/);
    // nothing moved: the refusal happens before the first move
    expect(existsSync(join(workspace, "root", "app"))).toBe(true);
    expect(existsSync(join(workspace, "app"))).toBe(false);

    migrateWorkspace(root, workspace, { force: true });
    expect(existsSync(join(workspace, "app"))).toBe(true);
    expect(readFileSync(join(workspace, "docs", "wip.txt"), "utf8")).toBe("wip");
  });

  test("a lane folder with other files is kept; --force moves them out instead of deleting them", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    toOldLayout("root", "app");
    writeFileSync(join(workspace, "root", "notes.md"), "mine\n");
    mkdirSync(join(workspace, "root", "scratch"));
    writeFileSync(join(workspace, "root", "scratch", "x.txt"), "deep\n");
    writeFileSync(join(workspace, "root-notes.md"), "older\n"); // name already taken

    const report = migrateWorkspace(root, workspace);
    expect(report.keptFolders).toEqual([join(workspace, "root")]);
    expect(report.rescued).toEqual([]);
    expect(readFileSync(join(workspace, "root", "notes.md"), "utf8")).toBe("mine\n");
    expect(existsSync(join(workspace, "root", "AGENTS.md"))).toBe(true); // only removed with the folder
    expect(existsSync(join(workspace, "app"))).toBe(true);

    const forced = migrateWorkspace(root, workspace, { force: true });
    expect(forced.rescued.sort()).toEqual([join(workspace, "root-notes.md-2"), join(workspace, "root-scratch")]);
    expect(existsSync(join(workspace, "root"))).toBe(false);
    expect(readFileSync(join(workspace, "root-notes.md-2"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(workspace, "root-notes.md"), "utf8")).toBe("older\n"); // untouched
    expect(readFileSync(join(workspace, "root-scratch", "x.txt"), "utf8")).toBe("deep\n");
  });

  test("an AGENTS.md the user wrote in is rescued; an untouched one is dropped", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
    toOldLayout("root", "app");
    toOldLayout("ui", "app");
    // the generated files toOldLayout wrote: leave root's alone, add notes to ui's
    writeFileSync(join(workspace, "ui", "AGENTS.md"), `${readFileSync(join(workspace, "ui", "AGENTS.md"), "utf8")}\n## Notes\nkeep me\n`);
    writeFileSync(join(workspace, "ui", "CLAUDE.md"), "@AGENTS.md\n@extra.md\n");

    const report = migrateWorkspace(root, workspace);
    expect(report.keptFolders).toEqual([join(workspace, "ui")]); // its files are not ours to delete
    expect(existsSync(join(workspace, "root"))).toBe(false); // purely generated ones go

    const forced = migrateWorkspace(root, workspace, { force: true });
    expect(forced.rescued.sort()).toEqual([join(workspace, "ui-AGENTS.md"), join(workspace, "ui-CLAUDE.md")]);
    expect(readFileSync(join(workspace, "ui-AGENTS.md"), "utf8")).toContain("keep me");
    expect(readFileSync(join(workspace, "ui-CLAUDE.md"), "utf8")).toContain("@extra.md");
    expect(existsSync(join(workspace, "ui"))).toBe(false);
  });

  test("a worktree the model doesn't know is rescued, not deleted", () => {
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    toOldLayout("root", "app");
    // someone ran `git worktree add` by hand inside the lane folder
    const stray = join(workspace, "root", "stray");
    sh(["git", "-C", join(workspace, "root", "app"), "worktree", "add", "-q", "-b", "stray-branch", stray]);

    const kept = migrateWorkspace(root, workspace);
    expect(kept.keptFolders).toEqual([join(workspace, "root")]);

    const forced = migrateWorkspace(root, workspace, { force: true });
    expect(forced.rescued).toEqual([join(workspace, "root-stray")]);
    expect(g(join(workspace, "root-stray"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("stray-branch");
    expect(g(join(workspace, "root-stray"), "status", "--porcelain")).toBe(""); // repaired, still usable
  });

  test("a repo folder named like a lane is left alone", () => {
    const ui = makeRemote(sb, "ui");
    addRepo(root, workspace, { lane: "root", spec: app, cwd: sb.dir });
    addRepo(root, workspace, { lane: "root", spec: ui, cwd: sb.dir }); // folder <workspace>/ui
    createLane(root, workspace, { name: "ui", parent: "root", repos: [], cwd: sb.dir }); // lane ui

    const report = migrateWorkspace(root, workspace, { force: true });
    expect(report).toMatchObject({ moved: [], keptFolders: [] });
    expect(existsSync(join(workspace, "ui", ".git"))).toBe(true);
    expect(legacyLanes(workspace, loadModel(workspace))).toEqual([]);
  });

  test("a plain repo folder (legacy try clone) is moved with the filesystem", () => {
    const plain = join(workspace, "root", "old-app");
    mkdirSync(plain, { recursive: true });
    g(plain, "init", "--quiet", ".");
    writeFileSync(join(plain, "f.txt"), "x");
    g(plain, "add", ".");
    g(plain, "commit", "--quiet", "-m", "init");
    saveModel(workspace, {
      version: 1,
      lanes: { root: { parent: null, branch: "IMG-1234-autofit", repos: { "old-app": { source: plain, base: g(plain, "rev-parse", "HEAD") } } } },
      sync: null,
    });

    expect(migrateWorkspace(root, workspace).moved).toEqual([join(workspace, "old-app")]);
    expect(existsSync(join(workspace, "old-app", ".git"))).toBe(true);
    expect(loadModel(workspace).lanes.root!.repos["old-app"]).toBeDefined();
  });
});
