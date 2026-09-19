import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PickerItem, type PickerOptions, type PickerResult, runPicker } from "../../src/tui/index.ts";

export const TRY_BIN = "/opt/homebrew/bin/try";

export interface Capture {
  stream: NodeJS.WriteStream;
  text(): string;
}

export function capture(isTTY = false): Capture {
  let buf = "";
  const stream = {
    isTTY,
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    },
  };
  return { stream: stream as unknown as NodeJS.WriteStream, text: () => buf };
}

export function tmpRoot(prefix = "work-tui-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const HOUR = 3_600_000;

/** Create workspace folders with mtimes `ageHours` in the past. */
export function makeWorkspaces(dir: string, workspaces: Record<string, number>): void {
  const now = Date.now();
  for (const [name, ageHours] of Object.entries(workspaces)) {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    const t = new Date(now - ageHours * HOUR);
    utimesSync(p, t, t);
  }
}

/** Items the way try lists a directory: non-hidden directories, recency = mtime. */
export function itemsFromDir(dir: string, space: string): PickerItem[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && statSync(join(dir, name)).isDirectory())
    .map((name) => {
      const path = join(dir, name);
      return { basename: name, path, space, recency: statSync(path).mtime };
    });
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface Run {
  result: PickerResult;
  out: string;
}

/** Run the picker with a captured non-TTY stderr. */
export async function pick(opts: Partial<PickerOptions> & Pick<PickerOptions, "items" | "rootPath">): Promise<Run> {
  const err = capture();
  const result = await runPicker({
    scopes: ["*", ...new Set(opts.items.map((i) => i.space))].sort(),
    scope: "*",
    defaultSpace: "tries",
    createOptions: () => [{ prefix: `${today()}-`, label: "" }],
    addSpace: () => {},
    stderr: err.stream,
    ...opts,
  });
  return { result, out: err.text() };
}

/** Strip ANSI escapes for readable assertions. */
export function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
