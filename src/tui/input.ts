// Buffered terminal input: keys in raw mode, whole lines in cooked mode.

import { StringDecoder } from "node:string_decoder";
import { nextKey } from "./keys.ts";

export interface InputStream {
  on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  on(event: "end", fn: () => void): unknown;
  off(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  off(event: "end", fn: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export class TerminalInput {
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  private waiter: (() => void) | null = null;
  private attached = false;
  ended = false;

  constructor(private readonly stream: InputStream) {}

  private readonly onData = (chunk: Buffer | string): void => {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.wake();
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake();
  };

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.stream.on("data", this.onData);
    this.stream.on("end", this.onEnd);
    this.stream.resume();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.pause();
  }

  /** Resolve a pending wait() (new data, EOF, resize, async redraw request). */
  wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  wait(): Promise<void> {
    this.attach();
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  takeKey(): string | null {
    if (this.pending === "") return null;
    const [key, rest] = nextKey(this.pending);
    this.pending = rest;
    return key;
  }

  /** Next complete line without its terminator; at EOF whatever is left (or null when nothing). */
  takeLine(): string | null {
    const idx = this.pending.indexOf("\n");
    if (idx >= 0) {
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    if (this.ended && this.pending !== "") {
      const line = this.pending;
      this.pending = "";
      return line;
    }
    return null;
  }

  /** Drop unread input (STDIN.iflush). */
  discard(): void {
    this.pending = "";
  }

  async readLine(): Promise<string | null> {
    this.attach();
    for (;;) {
      const line = this.takeLine();
      if (line !== null) return line;
      if (this.ended) return null;
      await this.wait();
    }
  }
}
