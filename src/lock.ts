import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.ts";

const STALE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.WORK_LOCK_TIMEOUT_MS ?? 60_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Only a lock that still exists and belongs to a dead pid (or is very old) is stale; a vanished one is not. */
function isStale(file: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return false; // released meanwhile: just retry the O_EXCL create
  }
  try {
    const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
    if (!alive(pid)) return true;
  } catch {
    // vanished or half-written: fall back to age
  }
  return Date.now() - mtimeMs > STALE_MS;
}

/**
 * Cross-process mutex (Bun has no flock): O_EXCL lock file holding {pid, t}; stale when the pid is dead or the
 * file is older than 10 minutes. Re-entrant within one process.
 */
const held = new Map<string, number>();

export function withLock<T>(stateDir: string, key: string, fn: () => T): T {
  const dir = join(stateDir, "locks");
  const file = join(dir, `${createHash("sha1").update(key).digest("hex").slice(0, 16)}.lock`);
  const depth = held.get(file) ?? 0;
  if (depth > 0) {
    held.set(file, depth + 1);
    try {
      return fn();
    } finally {
      held.set(file, depth);
    }
  }
  mkdirSync(dir, { recursive: true });
  const start = Date.now();
  let wait = 20;
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now(), key }));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (isStale(file)) {
        try {
          unlinkSync(file);
        } catch {
          // someone else removed it
        }
        continue;
      }
      if (Date.now() - start > TIMEOUT_MS) fail(`timed out waiting for lock on ${key} (${file})`);
      Bun.sleepSync(wait);
      wait = Math.min(wait * 2, 500);
    }
  }
  held.set(file, 1);
  try {
    return fn();
  } finally {
    held.delete(file);
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}
