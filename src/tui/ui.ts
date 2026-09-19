// Token-based printer with double buffering (port of try's UI module). Instance per picker instead of globals.

export const TOKEN_MAP: Record<string, string> = {
  // Text formatting
  "{b}": "\x1b[1;33m", // Bold + Yellow (highlighted text, fuzzy match chars)
  "{/b}": "\x1b[22m\x1b[39m", // Reset bold + foreground
  "{dim}": "\x1b[90m", // Gray (bright black) - secondary/de-emphasized text
  "{text}": "\x1b[0m\x1b[39m", // Full reset - normal text
  "{reset}": "\x1b[0m\x1b[39m\x1b[49m", // Complete reset of all formatting
  "{/fg}": "\x1b[39m", // Reset foreground color only
  // Headings
  "{h1}": "\x1b[1;38;5;208m", // Bold + Orange (primary headings)
  "{h2}": "\x1b[1;34m", // Bold + Blue (secondary headings)
  // Selection
  "{section}": "\x1b[1m", // Bold - start of selected/highlighted section
  "{/section}": "\x1b[0m", // Full reset - end of selected section
  // Strikethrough (for deleted items)
  "{strike}": "\x1b[48;5;52m", // Dark red background
  "{/strike}": "\x1b[49m", // Reset background
  // Screen control
  "{clear_screen}": "\x1b[2J",
  "{clear_line}": "\x1b[2K",
  "{home}": "\x1b[H",
  "{clear_below}": "\x1b[0J",
  "{hide_cursor}": "\x1b[?25l",
  "{show_cursor}": "\x1b[?25h",
  // Input cursor
  "{cursor}": "\x1b[7m \x1b[27m", // Reverse video space as cursor block
};

const TOKEN = /\{.*?\}/g;

export interface UIOutput {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  getWindowSize?: () => [number, number];
}

export interface UIOptions {
  expandTokens: boolean;
  forceColors: boolean;
}

function envSize(names: string[]): number {
  for (const name of names) {
    const n = Number.parseInt(process.env[name] ?? "", 10);
    if (n > 0) return n;
  }
  return 0;
}

export class UI {
  private buffer: string[] = [];
  private lastBuffer: string[] = [];
  private currentLine = "";
  private cachedHeight: number | null = null;
  private cachedWidth: number | null = null;
  private readonly expand: boolean;
  private readonly force: boolean;

  constructor(
    private readonly io: UIOutput,
    opts: UIOptions,
  ) {
    this.expand = opts.expandTokens;
    this.force = opts.forceColors;
  }

  get isTTY(): boolean {
    return this.io.isTTY === true;
  }

  print(text: string | null | undefined): void {
    if (text == null) return;
    this.currentLine += text;
  }

  puts(text = ""): void {
    this.currentLine += text;
    this.buffer.push(this.currentLine);
    this.currentLine = "";
  }

  flush(): void {
    // Always finalize the current line into the buffer
    if (this.currentLine !== "") {
      this.buffer.push(this.currentLine);
      this.currentLine = "";
    }

    // In non-TTY contexts (unless force_colors), print plain text without control codes
    if (!this.isTTY && !this.force) {
      const plain = this.buffer.join("\n").replace(TOKEN, "");
      this.io.write(plain.endsWith("\n") ? plain : plain + "\n");
      this.lastBuffer = [];
      this.buffer = [];
      this.currentLine = "";
      return;
    }

    let out = "";
    // Position cursor at home for TTY
    if (this.isTTY) out += "\x1b[H";

    const maxLines = Math.max(this.buffer.length, this.lastBuffer.length);
    const reset = TOKEN_MAP["{reset}"]!;

    for (let i = 0; i < maxLines; i++) {
      const current = this.buffer[i] ?? "";
      const last = this.lastBuffer[i] ?? "";
      if (current !== last || this.force) {
        // Move to line and clear it (only for TTY)
        if (this.isTTY) out += `\x1b[${i + 1};1H\x1b[2K`;
        if (current !== "") {
          out += this.expandTokens(current);
          if (this.expand) out += reset;
          if (this.force && !this.isTTY) out += "\n";
        }
      }
    }

    // Store current buffer as last buffer for next comparison
    this.lastBuffer = this.buffer;
    this.buffer = [];
    this.currentLine = "";
    if (out !== "") this.io.write(out);
  }

  cls(): void {
    this.currentLine = "";
    this.buffer = [];
    this.lastBuffer = [];
    this.io.write("\x1b[2J\x1b[H"); // Clear screen and go home
  }

  hideCursor(): void {
    this.io.write("\x1b[?25l");
  }

  showCursor(): void {
    this.io.write("\x1b[?25h");
  }

  height(): number {
    if (this.cachedHeight === null) {
      const env = envSize(["WORK_HEIGHT", "TRY_HEIGHT"]);
      this.cachedHeight = env > 0 ? env : this.terminalSize()[1] || 24;
    }
    return this.cachedHeight;
  }

  width(): number {
    if (this.cachedWidth === null) {
      const env = envSize(["WORK_WIDTH", "TRY_WIDTH"]);
      this.cachedWidth = env > 0 ? env : this.terminalSize()[0] || 80;
    }
    return this.cachedWidth;
  }

  refreshSize(): void {
    this.cachedHeight = null;
    this.cachedWidth = null;
  }

  /** Expand tokens to ANSI sequences; unknown tokens are left unchanged. */
  expandTokens(str: string): string {
    if (!this.expand) return str;
    return str.replace(TOKEN, (match) => TOKEN_MAP[match] ?? match);
  }

  private terminalSize(): [number, number] {
    if (!this.isTTY) return [0, 0];
    try {
      const size = this.io.getWindowSize?.();
      if (size && size[0] > 0 && size[1] > 0) return size;
    } catch {
      // fall through to cached columns/rows
    }
    return [this.io.columns ?? 0, this.io.rows ?? 0];
  }
}
