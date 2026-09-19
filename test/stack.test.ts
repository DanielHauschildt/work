import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addRepo, createLane } from "../src/lanes.ts";
import { loadModel } from "../src/model.ts";
import { Root } from "../src/root.ts";
import { submit, sync } from "../src/stack.ts";
import { advanceRemote, commit, g, makeRemote, type Sandbox, sandbox } from "./helpers.ts";

let sb: Sandbox;
let root: Root;
let entry: string;
let app: string;
let ghLog: string;
let ghState: string;
const savedEnv = { ...process.env };

/** gh stub: records calls, fakes PR numbers/state from files. */
function installGh(): void {
  ghLog = join(sb.dir, "gh.log");
  ghState = join(sb.dir, "gh-state");
  mkdirSync(ghState, { recursive: true });
  const script = `#!/bin/bash
echo "$*" >> ${JSON.stringify(ghLog)}
S=${JSON.stringify(ghState)}
case "$1 $2" in
  "pr create")
    n=$(( $(cat "$S/counter" 2>/dev/null || echo 0) + 1 )); echo $n > "$S/counter"
    base=""; prev=""; for a in "$@"; do [ "$prev" = "--base" ] && base="$a"; prev="$a"; done
    echo OPEN > "$S/$n.state"; echo "$base" > "$S/$n.base"
    echo "https://github.com/acme/app/pull/$n" ;;
  "pr view")
    n="$3"; st=$(cat "$S/$n.state" 2>/dev/null || echo OPEN); b=$(cat "$S/$n.base" 2>/dev/null)
    if [[ "$*" == *"-q .state"* ]]; then echo "$st"; else echo "{\\"state\\":\\"$st\\",\\"baseRefName\\":\\"$b\\"}"; fi ;;
  "pr edit")
    n="$3"; prev=""; for a in "$@"; do [ "$prev" = "--base" ] && echo "$a" > "$S/$n.base"; prev="$a"; done ;;
  "pr list") echo "" ;;
esac
`;
  const bin = join(sb.dir, "gh");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  process.env.WORK_GH = bin;
}

beforeEach(() => {
  sb = sandbox();
  root = new Root(sb.root);
  entry = join(sb.root, "labs", "feat");
  mkdirSync(entry, { recursive: true });
  app = makeRemote(sb, "app", { "a.txt": "1\n2\n3\n" });
  // make https://github.com/acme/app.git resolve to the local bare repo
  const gitconfig = join(sb.dir, "gitconfig");
  writeFileSync(gitconfig, `[url "${sb.remotes}/"]\n\tinsteadOf = https://github.com/acme/\n`);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  installGh();
});
afterEach(() => {
  process.env = { ...savedEnv };
  sb.cleanup();
});

function setup(): { r: string; ui: string } {
  const r = addRepo(root, entry, { lane: "root", spec: "https://github.com/acme/app.git", cwd: sb.dir });
  commit(r, "core.txt", "core v1");
  createLane(root, entry, { name: "ui", parent: "root", repos: [], cwd: sb.dir });
  const ui = join(entry, "ui", "app");
  commit(ui, "ui.txt", "ui v1");
  return { r, ui };
}

describe("sync", () => {
  test("child lane is restacked after the parent lane gets new commits", () => {
    const { r, ui } = setup();
    const newTip = commit(r, "core2.txt", "core v2");
    const reports = sync(root, entry);
    expect(reports.find((x) => x.lane === "ui")!.result).toBe("rebased");
    expect(g(ui, "merge-base", "--is-ancestor", newTip, "HEAD")).toBe("");
    expect(g(ui, "log", "--format=%s", "-3").split("\n")).toEqual(["edit ui.txt", "edit core2.txt", "edit core.txt"]);
    expect(loadModel(entry).lanes.ui!.repos.app!.base).toBe(newTip);
  });

  test("root lane is restacked onto upstream trunk and children follow", () => {
    const { ui } = setup();
    advanceRemote(sb, app, "up.txt", "upstream");
    const reports = sync(root, entry);
    expect(reports.map((x) => `${x.lane}:${x.result}`)).toEqual(["root:rebased", "ui:rebased"]);
    expect(existsSync(join(ui, "up.txt"))).toBe(true);
    expect(g(ui, "log", "--format=%s", "-4").split("\n")).toEqual(["edit ui.txt", "edit core.txt", "upstream up.txt", "init"]);
  });

  test("up-to-date lanes are left alone", () => {
    setup();
    const reports = sync(root, entry);
    expect(reports.map((x) => x.result)).toEqual(["up-to-date", "up-to-date"]);
  });

  test("dirty checkouts are skipped", () => {
    const { r, ui } = setup();
    commit(r, "core2.txt", "v2");
    writeFileSync(join(ui, "wip.txt"), "wip");
    const reports = sync(root, entry);
    expect(reports.find((x) => x.lane === "ui")).toMatchObject({ result: "skipped", detail: "uncommitted changes" });
  });

  test("conflict stops, --continue resumes, state is cleared", () => {
    const { r, ui } = setup();
    commit(ui, "a.txt", "1\nUI\n3\n");
    commit(r, "a.txt", "1\nCORE\n3\n");
    expect(() => sync(root, entry)).toThrow(/conflict while rebasing ui\/app/);
    expect(loadModel(entry).sync!.pending[0]).toEqual(["ui", "app"]);
    expect(() => sync(root, entry)).toThrow(/sync is in progress/);
    expect(() => sync(root, entry, { continue: true })).toThrow(/conflicts remain/);
    writeFileSync(join(ui, "a.txt"), "1\nCORE+UI\n3\n");
    g(ui, "add", "a.txt");
    sync(root, entry, { continue: true });
    expect(loadModel(entry).sync).toBeNull();
    expect(readFileSync(join(ui, "a.txt"), "utf8")).toBe("1\nCORE+UI\n3\n");
    expect(g(ui, "status", "--porcelain")).toBe("");
  });

  test("--abort restores the checkout", () => {
    const { r, ui } = setup();
    const before = commit(ui, "a.txt", "1\nUI\n3\n");
    commit(r, "a.txt", "1\nCORE\n3\n");
    expect(() => sync(root, entry)).toThrow();
    sync(root, entry, { abort: true });
    expect(g(ui, "rev-parse", "HEAD")).toBe(before);
    expect(loadModel(entry).sync).toBeNull();
  });

  test("squash-merged parent: child moves onto trunk without the parent's commits", () => {
    const { ui } = setup();
    submit(root, entry);
    const model = loadModel(entry);
    const rootPr = model.lanes.root!.repos.app!.pr!;
    // simulate a squash merge of the root PR on GitHub
    const tmp = join(sb.dir, "squash");
    g(sb.dir, "clone", "-q", app, tmp);
    writeFileSync(join(tmp, "core.txt"), "core v1");
    g(tmp, "add", ".");
    g(tmp, "commit", "-q", "-m", "squash: core (#1)");
    g(tmp, "push", "-q", "origin", "HEAD:main");
    writeFileSync(join(ghState, `${rootPr}.state`), "MERGED");
    const reports = sync(root, entry);
    expect(reports.find((x) => x.lane === "ui")!.result).toBe("rebased");
    expect(g(ui, "log", "--format=%s", "-3").split("\n")).toEqual(["edit ui.txt", "squash: core (#1)", "init"]);
    const after = loadModel(entry);
    expect(after.lanes.root!.repos.app!.merged).toBe(true);
    expect(after.lanes.ui!.parent).toBeNull();
  });
});

describe("submit", () => {
  test("pushes lanes and opens stacked PRs with the parent branch as base", () => {
    setup();
    const reports = submit(root, entry, { draft: true });
    expect(reports.map((x) => `${x.lane}:${x.result}:${x.pr}`)).toEqual(["root:created:1", "ui:created:2"]);
    const log = readFileSync(ghLog, "utf8");
    expect(log).toContain("pr create -R acme/app --head feat --base main");
    expect(log).toContain("pr create -R acme/app --head feat-ui --base feat");
    expect(log).toContain("--draft");
    expect(log).toContain("Stacked on #1.");
    expect(g(app, "branch", "--list", "feat-ui")).toContain("feat-ui");
  });

  test("resubmit retargets a PR whose parent was merged", () => {
    setup();
    submit(root, entry);
    writeFileSync(join(ghState, "1.state"), "MERGED");
    advanceRemote(sb, app, "core.txt", "core v1");
    sync(root, entry);
    const reports = submit(root, entry);
    expect(reports.find((x) => x.lane === "ui")).toMatchObject({ result: "updated", detail: "base → main", pr: 2 });
    expect(readFileSync(join(ghState, "2.base"), "utf8").trim()).toBe("main");
  });

  test("lanes without commits over their parent are skipped", () => {
    addRepo(root, entry, { lane: "root", spec: "https://github.com/acme/app.git", cwd: sb.dir });
    const reports = submit(root, entry);
    expect(reports[0]!.result).toBe("no-commits");
  });
});
