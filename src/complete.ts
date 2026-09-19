import { basename } from "node:path";
import { hasModel, loadModel } from "./model.ts";
import { listStores, storeLabel } from "./repos.ts";
import type { Root } from "./root.ts";
import { calculateScore } from "./tui/index.ts";

export interface Candidate {
  value: string;
  desc?: string;
}

export const SUBCOMMANDS: Record<string, string> = {
  new: "create a workspace without the picker",
  add: "add a repo worktree to a lane",
  lane: "create a (stacked) lane",
  mv: "move / rename / promote a workspace",
  archive: "move a workspace to <space>/.archive",
  unarchive: "restore an archived workspace",
  rm: "delete a workspace, lane or worktree",
  ls: "list workspaces",
  info: "show lanes, branches and status",
  path: "print the path of a workspace",
  sync: "restack lanes onto their parents",
  submit: "push lanes and open/update PRs",
  clone: "new workspace from a git URL",
  back: "go to the previous workspace",
  init: "print shell integration",
  space: "list, create or configure spaces",
};

const FLAGS: Record<string, string> = {
  "--space": "space to use",
  "--prefix": "auto | none | literal",
  "--lane": "lane to use",
  "--on": "parent lane (or trunk)",
  "--json": "machine-readable output",
  "--yes": "skip confirmation",
  "--force": "ignore dirty/unpushed checks",
  "--first": "take the best match",
  "--path": "root folder",
  "--help": "show help",
};

const VALUE_FLAGS = new Set(["--space", "--prefix", "--lane", "--on", "--path", "--shortcut"]);

function filter(cands: Candidate[], cur: string): Candidate[] {
  if (!cur) return cands;
  const lc = cur.toLowerCase();
  const prefix = cands.filter((c) => c.value.toLowerCase().startsWith(lc));
  if (prefix.length) return prefix;
  const sub = cands.filter((c) => c.value.toLowerCase().includes(lc));
  if (sub.length) return sub;
  return cands
    .map((c) => ({ c, s: calculateScore(basename(c.value), cur, new Date()) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

function workspaceCandidates(root: Root, space: string | undefined): Candidate[] {
  if (space) return root.workspaces(space).map((e) => ({ value: e.name, desc: space }));
  return root.allWorkspaces().map((e) => ({ value: `${e.space}/${e.name}` }));
}

function laneCandidates(root: Root, cwd: string): Candidate[] {
  const loc = root.locate(cwd);
  if (!loc || !hasModel(loc.workspacePath)) return [];
  const model = loadModel(loc.workspacePath);
  return Object.entries(model.lanes).map(([n, l]) => ({ value: n, desc: l.branch }));
}

function storeCandidates(root: Root): Candidate[] {
  const seen = new Map<string, number>();
  const stores = listStores(root);
  for (const s of stores) seen.set(basename(s, ".git"), (seen.get(basename(s, ".git")) ?? 0) + 1);
  return stores.flatMap((s) => {
    const label = storeLabel(root, s);
    const name = basename(s, ".git");
    return seen.get(name) === 1 ? [{ value: name, desc: label }, { value: label }] : [{ value: label }];
  });
}

/**
 * Completion for `cmd words…` (words include the current, possibly empty, word).
 * Returns candidates or "files" to ask the shell for file completion.
 */
export function complete(root: Root, opts: { cmd: string; space?: string; words: string[]; cwd: string }): Candidate[] | "files" {
  const words = opts.words.length ? opts.words : [""];
  const cur = words[words.length - 1]!;
  const prev = words[words.length - 2];
  const shortcutSpace = opts.cmd !== "work" && opts.space ? opts.space : undefined;
  let space = shortcutSpace;

  switch (prev) {
    case "--space":
      return filter(root.spaces().map((s) => ({ value: s })), cur);
    case "--prefix":
      return filter([{ value: "auto", desc: "today's date" }, { value: "none", desc: "no prefix" }], cur);
    case "--lane":
    case "--on":
      return filter([...laneCandidates(root, opts.cwd), ...(prev === "--on" ? [{ value: "trunk", desc: "origin default branch" }] : [])], cur);
    case "--path":
      return "files";
  }
  if (cur.startsWith("-")) return filter(Object.entries(FLAGS).map(([value, desc]) => ({ value, desc })), cur);

  // positional words before the current one, skipping flags and their values
  const positional: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!;
    if (VALUE_FLAGS.has(w)) {
      if (w === "--space") space = words[i + 1];
      i++;
    } else if (!w.startsWith("-")) positional.push(w);
  }
  const sub = positional[0];
  const argIndex = positional.length - 1; // index of the current word among the subcommand's args

  if (!sub) {
    if (cur.startsWith(".") || cur.startsWith("/") || cur.startsWith("~")) return "files";
    const subs = Object.entries(SUBCOMMANDS).map(([value, desc]) => ({ value, desc }));
    if (!space && cur.includes("/")) {
      const [sp] = cur.split("/");
      return filter(root.workspaces(sp!).map((e) => ({ value: `${sp}/${e.name}` })), cur);
    }
    const workspaces = space ? workspaceCandidates(root, space) : root.spaces().map((s) => ({ value: `${s}/`, desc: "space" }));
    return filter([...workspaces, ...subs], cur);
  }

  switch (sub) {
    case "add":
      if (cur.startsWith(".") || cur.startsWith("/") || cur.startsWith("~")) return "files";
      return argIndex === 0 ? filter(storeCandidates(root), cur) : [];
    case "lane":
      return argIndex === 0 ? [] : filter(storeCandidates(root), cur);
    case "mv":
      if (argIndex === 0) return filter(workspaceCandidates(root, space), cur);
      if (argIndex === 1) return filter(root.spaces().map((s) => ({ value: `${s}/`, desc: "space" })), cur);
      return [];
    case "rm":
      return filter([...laneCandidates(root, opts.cwd).map((c) => ({ value: `./${c.value}`, desc: "lane" })), ...workspaceCandidates(root, space)], cur);
    case "archive":
    case "path":
    case "info":
      return argIndex === 0 ? filter(workspaceCandidates(root, space), cur) : sub === "path" ? filter(laneCandidates(root, opts.cwd), cur) : [];
    case "space":
      if (argIndex === 0) return filter([{ value: "ls" }, { value: "new" }, { value: "set" }], cur);
      if (argIndex === 1 && positional[1] === "set") return filter(root.spaces().map((s) => ({ value: s })), cur);
      return [];
    case "unarchive":
      return filter(root.archived().map((e) => ({ value: `${e.space}/${e.name}` })), cur);
    case "ls":
      return filter([{ value: "--json" }, { value: "--stale" }, { value: "--archived" }], cur);
    case "sync":
      return filter([{ value: "--continue" }, { value: "--abort" }, { value: "--json" }], cur);
    case "submit":
      return filter([{ value: "--draft" }, { value: "--json" }], cur);
    case "init":
      return "files";
    default:
      return [];
  }
}

export function formatCandidates(c: Candidate[] | "files", shell: string): string {
  if (c === "files") return ":files\n";
  if (!c.length) return "";
  return (
    c
      .map((x) => (shell === "bash" || !x.desc ? x.value : `${x.value}\t${x.desc}`))
      .join("\n") + "\n"
  );
}
