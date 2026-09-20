import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/** Local date as YYYY-MM-DD (try uses Time.now). `WORK_TODAY` pins it for tests. */
export function today(): string {
  const pinned = process.env.WORK_TODAY;
  if (pinned) return pinned;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whitespace → "-" like try's gsub(/\s+/, '-'). */
export function dashify(name: string): string {
  return name.replace(/\s+/g, "-");
}

/** Names a new space may have: letters, digits, `.`, `_`, `-`; not starting with `.` or `-`. */
export const SPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Space names follow workspace naming: trimmed, whitespace runs → "-", case kept. */
export function spaceName(input: string): string {
  return dashify(input.trim());
}

/** Why `name` can't be a new space, or undefined when it can. */
export function spaceNameError(name: string): string | undefined {
  return SPACE_NAME.test(name) ? undefined : `Invalid space name "${name}": use letters, digits, . _ - (not starting with . or -)`;
}

/**
 * Prefix setting → literal text placed before a name.
 * `auto` = today's date, `""`/`none` = nothing, anything else is used verbatim.
 */
export function prefixText(prefix: string | undefined): string {
  if (prefix === undefined || prefix === "auto") return `${today()}-`;
  if (prefix === "" || prefix === "none") return "";
  return `${prefix}-`;
}

export function hasDatePrefix(name: string): boolean {
  return DATE_PREFIX.test(name);
}

export function stripDate(name: string): string {
  return name.replace(DATE_PREFIX, "");
}

/** Worktree folder inside a workspace: `<repo>` in lane `root`, `<repo>@<lane>` in any other lane. */
export function worktreeDir(lane: string, repo: string): string {
  return lane === ROOT_LANE ? repo : `${repo}@${lane}`;
}

/** Lane a worktree folder belongs to: the part after its `@`, else lane `root`. */
export function laneOfFolder(folder: string): string {
  const at = folder.lastIndexOf("@");
  return at > 0 ? folder.slice(at + 1) : ROOT_LANE;
}

/** Branch for a lane: workspace name without date; lanes other than root append `-<lane>`. */
export function laneBranch(workspaceName: string, lane: string): string {
  const base = sanitizeRef(stripDate(workspaceName));
  return lane === "root" ? base : `${base}-${sanitizeRef(lane)}`;
}

/** Make a string safe as a git branch name (git check-ref-format rules, conservatively). */
export function sanitizeRef(s: string): string {
  let out = s
    .replace(/[\s~^:?*[\\\x00-\x1f\x7f]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/@\{/g, "-")
    .replace(/\/+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[.]+$/, "")
    .replace(/\.lock$/, "");
  if (out === "" || out === "@") out = "work";
  return out;
}

export const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The base lane; its worktrees have no `@` suffix. */
export const ROOT_LANE = "root";

// --- try compatible helpers -------------------------------------------------

/** try's is_git_uri? heuristic. */
export function isGitUri(arg: string | undefined): boolean {
  if (!arg) return false;
  return (
    /^(https?:\/\/|git@)/.test(arg) ||
    arg.includes("github.com") ||
    arg.includes("gitlab.com") ||
    arg.endsWith(".git") ||
    arg.startsWith("file://")
  );
}

export interface ParsedUri {
  host: string;
  user: string;
  repo: string;
}

/** try's parse_git_uri, plus file:// URLs and local paths ending in .git (host "local"). */
export function parseGitUri(input: string): ParsedUri | null {
  const uri = input.replace(/\.git$/, "").replace(/\/+$/, "");
  let m: RegExpMatchArray | null;
  if ((m = uri.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)/))) return { host: "github.com", user: m[1]!, repo: m[2]! };
  if ((m = uri.match(/^git@github\.com:([^/]+)\/([^/]+)/))) return { host: "github.com", user: m[1]!, repo: m[2]! };
  if ((m = uri.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)/))) return { host: m[1]!, user: m[2]!, repo: m[3]! };
  if ((m = uri.match(/^git@([^:]+):([^/]+)\/([^/]+)/))) return { host: m[1]!, user: m[2]!, repo: m[3]! };
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  if (input.startsWith("file://") || input.endsWith(".git")) {
    const repo = basename(path);
    const user = basename(dirname(path)) || "local";
    if (repo) return { host: "local", user, repo };
  }
  return null;
}

/** try's generate_clone_directory_name: custom name wins verbatim, else `<prefix><user>-<repo>`. */
export function cloneDirName(uri: string, custom: string | undefined, prefix: string): string | null {
  if (custom) return custom;
  const p = parseGitUri(uri);
  return p ? `${prefix}${p.user}-${p.repo}` : null;
}

/** try's unique_dir_name: append -2, -3, … while the folder exists. */
export function uniqueDirName(dir: string, name: string): string {
  let candidate = name;
  let i = 2;
  while (existsSync(join(dir, candidate))) candidate = `${name}-${i++}`;
  return candidate;
}

/**
 * try's resolve_unique_name_with_versioning: when `<prefix><base>` exists, bump a trailing number
 * (`foo1` → `foo2`) or fall back to `-2` style suffixes. Returns the base (without prefix).
 */
export function versionedBase(dir: string, prefix: string, base: string): string {
  if (!existsSync(join(dir, `${prefix}${base}`))) return base;
  const m = base.match(/^(.*?)(\d+)$/);
  if (m) {
    let n = Number(m[2]) + 1;
    while (existsSync(join(dir, `${prefix}${m[1]}${n}`))) n++;
    return `${m[1]}${n}`;
  }
  return uniqueDirName(dir, `${prefix}${base}`).slice(prefix.length);
}
