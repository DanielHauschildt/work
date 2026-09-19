import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Root } from "./root.ts";

interface Visit {
  p: string; // entry path relative to root
  t: number; // epoch ms
}

const MAX_LINES = 2000;

/** Visit log in `<root>/.work/history.jsonl`; replaces try's `touch` for recency and powers `work -`. */
export class History {
  private readonly file: string;

  constructor(private readonly root: Root) {
    this.file = join(root.stateDir, "history.jsonl");
  }

  private read(): Visit[] {
    if (!existsSync(this.file)) return [];
    const visits: Visit[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const v = JSON.parse(line) as Visit;
        if (typeof v.p === "string" && typeof v.t === "number") visits.push(v);
      } catch {
        // skip corrupt line
      }
    }
    return visits;
  }

  private rel(entryPath: string): string {
    return relative(this.root.path, entryPath).split(sep).join("/");
  }

  record(entryPath: string, t = Date.now()): void {
    mkdirSync(this.root.stateDir, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ p: this.rel(entryPath), t })}\n`);
    const visits = this.read();
    if (visits.length > MAX_LINES) this.write(compact(visits));
  }

  /** Last visit per entry path (absolute). */
  lastVisits(): Map<string, Date> {
    const map = new Map<string, Date>();
    for (const v of this.read()) map.set(join(this.root.path, v.p), new Date(v.t));
    return map;
  }

  /** Most recent visited entry other than `current` that still exists. */
  previous(current: string | undefined): string | undefined {
    const visits = this.read();
    for (let i = visits.length - 1; i >= 0; i--) {
      const abs = join(this.root.path, visits[i]!.p);
      if (abs !== current && existsSync(abs)) return abs;
    }
    return undefined;
  }

  /** Keep recency when an entry moves. */
  rename(from: string, to: string): void {
    const a = this.rel(from);
    const b = this.rel(to);
    const visits = this.read();
    if (!visits.some((v) => v.p === a)) return;
    this.write(visits.map((v) => (v.p === a ? { ...v, p: b } : v)));
  }

  private write(visits: Visit[]): void {
    mkdirSync(this.root.stateDir, { recursive: true });
    writeFileSync(this.file, visits.map((v) => JSON.stringify(v)).join("\n") + (visits.length ? "\n" : ""));
  }
}

function compact(visits: Visit[]): Visit[] {
  const last = new Map<string, number>();
  for (const v of visits) last.set(v.p, Math.max(last.get(v.p) ?? 0, v.t));
  return [...last].map(([p, t]) => ({ p, t })).sort((a, b) => a.t - b.t);
}
