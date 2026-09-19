import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fail } from "./errors.ts";
import { spaceName, spaceNameError } from "./naming.ts";

export interface SpaceConfig {
  prefix?: string;
  template?: string;
  post_add?: string;
  cleanup_days?: number;
}

export interface WorkspaceInfo {
  space: string;
  name: string;
  path: string;
  mtime: Date;
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Real path when it exists (macOS: /tmp → /private/tmp), else the resolved path. */
export function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class Root {
  readonly path: string;

  constructor(path: string) {
    this.path = real(expandHome(path));
  }

  /** `--path` > `WORK_ROOT` > `~/Work`. */
  static resolve(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): Root {
    return new Root(flag || env.WORK_ROOT || join(homedir(), "Work"));
  }

  get stateDir(): string {
    return join(this.path, ".work");
  }

  get reposDir(): string {
    return join(this.path, ".repos");
  }

  ensure(): void {
    mkdirSync(this.path, { recursive: true });
  }

  spaces(): string[] {
    if (!isDir(this.path)) return [];
    return readdirSync(this.path)
      .filter((n) => !n.startsWith(".") && isDir(join(this.path, n)))
      .sort();
  }

  spacePath(space: string): string {
    if (!space || space.startsWith(".") || space.includes("/")) fail(`invalid space name: ${space}`);
    return join(this.path, space);
  }

  private configs = new Map<string, SpaceConfig>();

  spaceConfig(space: string): SpaceConfig {
    const cached = this.configs.get(space);
    if (cached) return cached;
    const file = join(this.path, space, ".space.toml");
    let config: SpaceConfig = {};
    if (existsSync(file)) {
      try {
        config = Bun.TOML.parse(readFileSync(file, "utf8")) as SpaceConfig;
      } catch (e) {
        fail(`${file}: ${(e as Error).message}`);
      }
    }
    this.configs.set(space, config);
    return config;
  }

  /** Merge `patch` into `<space>/.space.toml` (flat keys only), creating the space if needed. */
  writeSpaceConfig(space: string, patch: SpaceConfig): void {
    const dir = this.spacePath(space);
    if (!isDir(dir)) this.checkNewSpace(space);
    mkdirSync(dir, { recursive: true });
    this.configs.delete(space);
    const merged: Record<string, unknown> = { ...this.spaceConfig(space), ...patch };
    const lines = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} = ${typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v))}`);
    writeFileSync(join(dir, ".space.toml"), `${lines.join("\n")}\n`);
    this.configs.delete(space);
  }

  /** Create a space folder (optionally with a default prefix); the name is normalized with `spaceName`. */
  addSpace(input: string, prefix?: string): string {
    const space = spaceName(input);
    this.checkNewSpace(space);
    const dir = this.spacePath(space);
    const existing = this.findSpace(space);
    if (existing !== undefined || existsSync(dir)) fail(`space ${existing ?? space} already exists`);
    mkdirSync(dir, { recursive: true });
    if (prefix !== undefined) this.writeSpaceConfig(space, { prefix });
    return dir;
  }

  /** Fail with the reason when `space` can't be created. */
  checkNewSpace(space: string): void {
    const error = spaceNameError(space);
    if (error) fail(error);
  }

  /** Existing space whose name equals `name` ignoring case (exact match first). */
  findSpace(name: string): string | undefined {
    const spaces = this.spaces();
    return spaces.find((s) => s === name) ?? spaces.find((s) => s.toLowerCase() === name.toLowerCase());
  }

  /**
   * A space given on the command line: an existing space (as typed, else normalized; case-insensitive, so the
   * folder's own name is used), else the normalized name for a new space.
   */
  spaceArg(input: string): string {
    const name = spaceName(input);
    return this.findSpace(input) ?? this.findSpace(name) ?? name;
  }

  workspaces(space: string): WorkspaceInfo[] {
    const dir = join(this.path, space);
    if (!isDir(dir)) return [];
    const out: WorkspaceInfo[] = [];
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) out.push({ space, name, path, mtime: st.mtime });
      } catch {
        // vanished or unreadable
      }
    }
    return out;
  }

  allWorkspaces(): WorkspaceInfo[] {
    return this.spaces().flatMap((s) => this.workspaces(s));
  }

  archived(space?: string): WorkspaceInfo[] {
    const spaces = space ? [space] : this.spaces();
    return spaces.flatMap((s) =>
      this.workspaces(join(s, ".archive")).map((e) => ({ ...e, space: s })),
    );
  }

  /** Where a path sits inside the root: space, workspace, and the rest (lane, repo, …). */
  locate(p: string): { space: string; workspace: string; workspacePath: string; rest: string[] } | null {
    const rel = relative(this.path, real(p));
    if (rel === "" || rel.startsWith("..")) return null;
    const parts = rel.split(sep);
    const [space, workspace, ...rest] = parts;
    if (!space || !workspace || space.startsWith(".") || workspace.startsWith(".")) return null;
    return { space, workspace, workspacePath: join(this.path, space, workspace), rest };
  }
}
