import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fail } from "./errors.ts";

export const SPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SpaceConfig {
  prefix?: string;
  template?: string;
  post_add?: string;
  cleanup_days?: number;
}

export interface EntryInfo {
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
    if (!SPACE_NAME.test(space)) fail(`invalid space name: ${space}`);
    mkdirSync(dir, { recursive: true });
    this.configs.delete(space);
    const merged: Record<string, unknown> = { ...this.spaceConfig(space), ...patch };
    const lines = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} = ${typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v))}`);
    writeFileSync(join(dir, ".space.toml"), `${lines.join("\n")}\n`);
    this.configs.delete(space);
  }

  /** Create a space folder (optionally with a default prefix). */
  addSpace(space: string, prefix?: string): string {
    if (!SPACE_NAME.test(space)) fail(`invalid space name: ${space}`);
    const dir = this.spacePath(space);
    if (existsSync(dir)) fail(`space ${space} already exists`);
    mkdirSync(dir, { recursive: true });
    if (prefix !== undefined) this.writeSpaceConfig(space, { prefix });
    return dir;
  }

  entries(space: string): EntryInfo[] {
    const dir = join(this.path, space);
    if (!isDir(dir)) return [];
    const out: EntryInfo[] = [];
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

  allEntries(): EntryInfo[] {
    return this.spaces().flatMap((s) => this.entries(s));
  }

  archived(space?: string): EntryInfo[] {
    const spaces = space ? [space] : this.spaces();
    return spaces.flatMap((s) =>
      this.entries(join(s, ".archive")).map((e) => ({ ...e, space: s })),
    );
  }

  /** Where a path sits inside the root: space, entry, and the rest (lane, repo, …). */
  locate(p: string): { space: string; entry: string; entryPath: string; rest: string[] } | null {
    const rel = relative(this.path, real(p));
    if (rel === "" || rel.startsWith("..")) return null;
    const parts = rel.split(sep);
    const [space, entry, ...rest] = parts;
    if (!space || !entry || space.startsWith(".") || entry.startsWith(".")) return null;
    return { space, entry, entryPath: join(this.path, space, entry), rest };
  }
}
