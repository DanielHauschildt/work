import { writeFileSync } from "node:fs";

export type ShellKind = "sh" | "fish";

/** POSIX single-quote (try's q): ' → '"'"' */
export function q(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

export function qFish(s: string): string {
  return `'${s.replace(/[\\']/g, "\\$&")}'`;
}

export function quote(s: string, shell: ShellKind): string {
  return shell === "fish" ? qFish(s) : q(s);
}

export const SCRIPT_WARNING = "# if you can read this, you didn't launch work from an alias. run work --help.";

/**
 * Collects commands that must run in the caller's shell (only `cd`). How they leave the process depends on
 * how `work` was invoked:
 *  - wrapper: `WORK_EMIT=<file>` → written to that file, the wrapper sources it
 *  - `work exec …`: try-style script on stdout
 *  - direct call (agents): the cd target is printed on stdout
 */
export class Emitter {
  private target: string | undefined;
  readonly mode: "file" | "exec" | "direct";
  readonly shell: ShellKind;

  constructor(opts: { exec: boolean; env?: NodeJS.ProcessEnv }) {
    const env = opts.env ?? process.env;
    this.shell = env.WORK_SHELL === "fish" ? "fish" : "sh";
    this.mode = opts.exec ? "exec" : env.WORK_EMIT ? "file" : "direct";
  }

  cd(path: string): void {
    this.target = path;
  }

  get cdTarget(): string | undefined {
    return this.target;
  }

  script(): string {
    return this.target ? `cd ${quote(this.target, this.shell)}\n` : "";
  }

  /** Returns true when something was emitted. */
  flush(env: NodeJS.ProcessEnv = process.env): boolean {
    if (!this.target) return false;
    if (this.mode === "file") writeFileSync(env.WORK_EMIT!, this.script());
    else if (this.mode === "exec") process.stdout.write(`${SCRIPT_WARNING}\n${this.script()}`);
    else process.stdout.write(`${this.target}\n`);
    return true;
  }
}
