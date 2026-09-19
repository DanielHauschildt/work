// Interactive picker: port of try's TrySelector with scopes (spaces), badges and move.

import { realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { calculateScore, dashify, formatRelativeTime, formatScore } from "./format.ts";
import { type InputStream, TerminalInput } from "./input.ts";
import { UI, type UIOutput } from "./ui.ts";

export interface PickerItem {
  /** entry folder name (matching + display) */
  basename: string;
  /** absolute path */
  path: string;
  /** space name, e.g. "tries" */
  space: string;
  /** replaces try's mtime for scoring and "2h ago" */
  recency: Date;
  /** plain text, rendered dim after the name when it fits */
  badges?: string;
  /** render a dim "stale" badge */
  stale?: boolean;
  /** optional async check; when it resolves true a "*" badge is added and the list redrawn */
  dirty?: () => Promise<boolean>;
}

export interface PickerOptions {
  /** all items across spaces; the picker filters by scope */
  items: PickerItem[];
  /** e.g. ["*", "labs", "tries"]; "*" means all spaces */
  scopes: string[];
  scope: string;
  /** initial search term (whitespace -> "-") */
  query?: string;
  /** try's --and-type */
  initialInput?: string;
  /** text before the name in "Create new", e.g. "2026-09-19-", "IMG-1234-" or "" */
  prefixFor: (space: string) => string;
  /** space that "Create new" creates in for a scope */
  createSpace: (scope: string) => string;
  /** extra warning lines on the YES confirmation screen */
  deleteWarnings?: (paths: string[]) => string[];
  /** delete safety: every realpath must be inside rootPath */
  rootPath: string;
  now?: Date;
  test?: { renderOnce?: boolean; noCls?: boolean; keys?: string[]; confirm?: string; forceColors?: boolean };
  colors?: boolean;
  expandTokens?: boolean;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
}

export type PickerResult =
  | { type: "cd"; path: string }
  | { type: "mkdir"; space: string; name: string }
  | { type: "delete"; paths: string[] }
  | { type: "move"; from: string; to: string }
  | null;

interface Row {
  item: PickerItem;
  score: number;
}

const DATE_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const PRINTABLE = /^[a-zA-Z0-9\-_. ]$/;
const ALNUM = /[a-zA-Z0-9]/;
const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
const TRY_HELP = "↑↓: Navigate  Enter: Select  Ctrl-T: New  Ctrl-D: Delete  Esc: Cancel";
const HELP = "↑↓: Navigate  Enter: Select  Ctrl-T: New  Ctrl-D: Delete  Tab: Scope  Ctrl-R: Move  Esc: Cancel";

function len(s: string): number {
  return Array.from(s).length;
}

function take(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

function chomp(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n") || s.endsWith("\r")) return s.slice(0, -1);
  return s;
}

function realpathError(e: unknown, path: string): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") return `No such file or directory @ realpath_rec - ${path}`;
  return err?.message ?? String(e);
}

class SafetyError extends Error {}

class Picker {
  private input: string[];
  private inputCursorPos: number;
  private cursorPos = 0;
  private scrollOffset = 0;
  private scope: string;
  private deleteStatus: string | null = null;
  private deleteMode = false;
  private marked: string[] = [];
  private now = new Date();

  private readonly testKeys: string[] | undefined;
  private readonly testHadKeys: boolean;
  private readonly noCls: boolean;
  private readonly ui: UI;
  private readonly stdin: InputStream;
  private readonly stderr: UIOutput;
  private terminal: TerminalInput | null = null;
  private raw = false;
  private running = false;
  private restored = false;
  private needsRedraw = false;
  private needsRepaint = false;
  private readonly dirty = new Map<PickerItem, boolean>();

  constructor(private readonly opts: PickerOptions) {
    const searchTerm = dashify(opts.query ?? "");
    const initial = opts.initialInput !== undefined ? dashify(opts.initialInput) : searchTerm;
    this.input = Array.from(initial);
    this.inputCursorPos = this.input.length;
    this.scope = opts.scope;

    const test = opts.test ?? {};
    this.testKeys = test.keys ? [...test.keys] : undefined;
    this.testHadKeys = (test.keys?.length ?? 0) > 0;
    const testMode = Boolean(test.renderOnce) || test.keys !== undefined;
    this.noCls = test.noCls ?? (Boolean(test.renderOnce) || this.testHadKeys);

    this.stdin = (opts.stdin ?? process.stdin) as unknown as InputStream;
    this.stderr = (opts.stderr ?? process.stderr) as unknown as UIOutput;
    this.ui = new UI(this.stderr, {
      expandTokens: opts.colors !== false && opts.expandTokens !== false,
      forceColors: test.forceColors ?? testMode,
    });
  }

  async run(): Promise<PickerResult> {
    let error: string | null = null;
    this.setupTerminal();
    try {
      // In test mode with no keys, render once and exit without TTY requirements
      if (this.opts.test?.renderOnce && !this.testHadKeys) {
        this.render(this.getTries());
        return null;
      }

      this.running = true;
      if (this.stdin.isTTY !== true || !this.ui.isTTY) {
        if (!this.testHadKeys) {
          error = "Error: work requires an interactive terminal";
          return null;
        }
        return await this.mainLoop();
      }
      this.setRaw(true);
      return await this.mainLoop();
    } finally {
      this.restoreTerminal();
      if (error) this.stderr.write(`${error}\n`);
    }
  }

  // --- terminal ---------------------------------------------------------------------------------

  private readonly onWinch = (): void => {
    this.needsRedraw = true;
    this.terminal?.wake();
  };

  private readonly onExit = (): void => {
    this.restoreTerminal();
  };

  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.restoreTerminal();
    if (process.listenerCount(signal) === 0) process.exit(128 + (osConstants.signals[signal] ?? 0));
  };

  private setupTerminal(): void {
    if (!this.noCls) {
      this.ui.cls();
      this.ui.hideCursor();
    }
    process.on("SIGWINCH", this.onWinch);
    for (const s of EXIT_SIGNALS) process.on(s, this.onSignal);
    process.on("exit", this.onExit);
  }

  private restoreTerminal(): void {
    if (this.restored) return;
    this.restored = true;
    this.running = false;
    this.setRaw(false);
    this.terminal?.detach();
    if (!this.noCls) {
      this.ui.cls();
      this.ui.showCursor();
    }
    process.off("SIGWINCH", this.onWinch);
    for (const s of EXIT_SIGNALS) process.off(s, this.onSignal);
    process.off("exit", this.onExit);
  }

  private setRaw(on: boolean): void {
    if (on === this.raw || this.stdin.isTTY !== true || !this.stdin.setRawMode) return;
    this.stdin.setRawMode(on);
    this.raw = on;
  }

  private getTerminal(): TerminalInput {
    this.terminal ??= new TerminalInput(this.stdin);
    return this.terminal;
  }

  // --- data -------------------------------------------------------------------------------------

  private get query(): string {
    return this.input.join("");
  }

  private getTries(): Row[] {
    this.now = this.opts.now ?? new Date();
    const query = this.query;
    const items = this.scope === "*" ? this.opts.items : this.opts.items.filter((i) => i.space === this.scope);
    const scored = items.map((item) => ({ item, score: calculateScore(item.basename, query, item.recency, this.now) }));
    // Filter only if searching, otherwise show all
    const rows = query === "" ? scored : scored.filter((r) => r.score > 0);
    return rows.sort((a, b) => b.score - a.score);
  }

  private startDirtyCheck(item: PickerItem): void {
    if (!item.dirty || !this.running || this.dirty.has(item)) return;
    this.dirty.set(item, false);
    const onResult = (isDirty: boolean): void => {
      if (!isDirty || !this.running) return;
      this.dirty.set(item, true);
      this.needsRepaint = true;
      this.terminal?.wake();
    };
    try {
      item.dirty().then(onResult, () => {});
    } catch {
      // a failing check just shows no badge
    }
  }

  // --- main loop --------------------------------------------------------------------------------

  private async mainLoop(): Promise<PickerResult> {
    for (;;) {
      const tries = this.getTries();
      const showCreateNew = this.input.length > 0;
      const totalItems = tries.length + (showCreateNew ? 1 : 0);

      // Ensure cursor is within bounds
      this.cursorPos = Math.min(Math.max(this.cursorPos, 0), Math.max(totalItems - 1, 0));

      this.render(tries);

      const key = await this.readKey();
      if (key === null) continue;

      switch (key) {
        case "\r": {
          // Enter
          if (this.deleteMode && this.marked.length > 0) {
            const result = await this.confirmBatchDelete(tries);
            if (result) return result;
          } else if (this.cursorPos < tries.length) {
            return { type: "cd", path: tries[this.cursorPos]!.item.path };
          } else if (showCreateNew) {
            const result = await this.handleCreateNew();
            if (result) return result;
          }
          break;
        }
        case "\x1b[A": // Up arrow
        case "\x10": // Ctrl-P
          this.cursorPos = Math.max(this.cursorPos - 1, 0);
          break;
        case "\x1b[B": // Down arrow
        case "\x0e": // Ctrl-N
          this.cursorPos = Math.min(this.cursorPos + 1, totalItems - 1);
          break;
        case "\x1b[C": // Right arrow - ignore
        case "\x1b[D": // Left arrow - ignore
          break;
        case "\x7f": // Backspace
        case "\b": // Ctrl-H
          if (this.inputCursorPos > 0) {
            this.input.splice(this.inputCursorPos - 1, 1);
            this.inputCursorPos -= 1;
          }
          this.cursorPos = 0; // Reset list selection when typing
          break;
        case "\x01": // Ctrl-A - beginning of line
          this.inputCursorPos = 0;
          break;
        case "\x05": // Ctrl-E - end of line
          this.inputCursorPos = this.input.length;
          break;
        case "\x02": // Ctrl-B - backward char
          this.inputCursorPos = Math.max(this.inputCursorPos - 1, 0);
          break;
        case "\x06": // Ctrl-F - forward char
          this.inputCursorPos = Math.min(this.inputCursorPos + 1, this.input.length);
          break;
        case "\x0b": // Ctrl-K - kill to end of line
          this.input = this.input.slice(0, this.inputCursorPos);
          break;
        case "\x17": {
          // Ctrl-W - delete word backward (alphanumeric)
          if (this.inputCursorPos > 0) {
            let pos = this.inputCursorPos - 1;
            // Skip trailing non-alphanumeric
            while (pos >= 0 && !ALNUM.test(this.input[pos]!)) pos -= 1;
            // Skip backward over alphanumeric chars
            while (pos >= 0 && ALNUM.test(this.input[pos]!)) pos -= 1;
            const newPos = pos + 1;
            this.input.splice(newPos, this.inputCursorPos - newPos);
            this.inputCursorPos = newPos;
          }
          break;
        }
        case "\x04": {
          // Ctrl-D - toggle mark for deletion
          if (this.cursorPos < tries.length) {
            const path = tries[this.cursorPos]!.item.path;
            if (this.marked.includes(path)) {
              this.marked = this.marked.filter((p) => p !== path);
            } else {
              this.marked.push(path);
              this.deleteMode = true;
            }
            // Exit delete mode if no more marks
            if (this.marked.length === 0) this.deleteMode = false;
          }
          break;
        }
        case "\x14": {
          // Ctrl-T - create new (immediate)
          const result = await this.handleCreateNew();
          if (result) return result;
          break;
        }
        case "\x12": {
          // Ctrl-R - move/rename
          if (this.cursorPos < tries.length) {
            const result = await this.handleMove(tries[this.cursorPos]!.item);
            if (result) return result;
          }
          break;
        }
        case "\t": // Tab - next scope
          this.cycleScope(1);
          break;
        case "\x1b[Z": // Shift-Tab - previous scope
          this.cycleScope(-1);
          break;
        case "\x03": // Ctrl-C
        case "\x1b": // ESC
          if (this.deleteMode) {
            // Exit delete mode, clear marks
            this.marked = [];
            this.deleteMode = false;
          } else {
            return null;
          }
          break;
        default:
          // Only accept printable characters, not escape sequences
          if (PRINTABLE.test(key)) {
            this.input.splice(this.inputCursorPos, 0, key);
            this.inputCursorPos += 1;
            this.cursorPos = 0; // Reset list selection when typing
          }
      }
    }
  }

  private cycleScope(step: number): void {
    const scopes = this.opts.scopes;
    if (scopes.length === 0) return;
    const idx = Math.max(scopes.indexOf(this.scope), 0);
    this.scope = scopes[(idx + step + scopes.length) % scopes.length]!;
    this.cursorPos = 0;
  }

  /** Next key, or null when the screen must be redrawn (resize, async badge). */
  private async readKey(): Promise<string | null> {
    if (this.testKeys && this.testKeys.length > 0) return this.testKeys.shift()!;
    // In test mode with no more keys, auto-exit by returning ESC
    if (this.testHadKeys) return "\x1b";

    const term = this.getTerminal();
    for (;;) {
      if (this.needsRedraw) {
        this.needsRedraw = false;
        this.needsRepaint = false;
        this.ui.refreshSize();
        this.ui.cls();
        return null;
      }
      if (this.needsRepaint) {
        this.needsRepaint = false;
        return null;
      }
      const key = term.takeKey();
      if (key !== null) return key;
      if (term.ended) return "\x1b";
      await term.wait();
    }
  }

  /** Read chars from test keys until Enter (try's confirmation handling). */
  private takeTestLine(): string {
    let line = "";
    while (this.testKeys && this.testKeys.length > 0) {
      const ch = this.testKeys.shift()!;
      if (ch === "\r" || ch === "\n") break;
      line += ch;
    }
    return line;
  }

  /** Read a line in cooked mode (echo + line editing by the terminal). */
  private async cookedLine(): Promise<string> {
    const term = this.getTerminal();
    const wasRaw = this.raw;
    this.setRaw(false);
    term.discard();
    try {
      return (await term.readLine()) ?? "";
    } finally {
      if (wasRaw) this.setRaw(true);
    }
  }

  private async promptLine(): Promise<string> {
    if (this.testKeys && this.testKeys.length > 0) return this.takeTestLine();
    if (this.testHadKeys) return "";
    return this.cookedLine();
  }

  // --- rendering --------------------------------------------------------------------------------

  private render(tries: Row[]): void {
    const ui = this.ui;
    const termWidth = ui.width();
    const termHeight = ui.height();
    const query = this.query;

    // Use actual terminal width for separator lines
    const separator = "─".repeat(Math.max(termWidth - 1, 0));

    // Header
    ui.puts(`{h1}📁 Work Selector · ${this.scope === "*" ? "all" : this.scope}{reset}`);
    ui.puts(`{dim}${separator}{/fg}`);

    // Search input with cursor at correct position
    const beforeCursor = this.input.slice(0, this.inputCursorPos).join("");
    const charAtCursor = this.input[this.inputCursorPos] ?? " ";
    const afterCursor = this.input.slice(this.inputCursorPos + 1).join("");
    ui.puts(`{dim}Search:{/fg} {b}${beforeCursor}\x1b[7m${charAtCursor}\x1b[27m${afterCursor}{/b}`);
    ui.puts(`{dim}${separator}{/fg}`);

    // Calculate visible window based on actual terminal height
    const maxVisible = Math.max(termHeight - 8, 3);
    const showCreateNew = query !== "";
    const totalItems = tries.length + (showCreateNew ? 1 : 0);

    // Adjust scroll window
    if (this.cursorPos < this.scrollOffset) {
      this.scrollOffset = this.cursorPos;
    } else if (this.cursorPos >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.cursorPos - maxVisible + 1;
    }

    const visibleEnd = Math.min(this.scrollOffset + maxVisible, totalItems);

    for (let idx = this.scrollOffset; idx < visibleEnd; idx++) {
      // Add blank line before "Create new"
      if (idx === tries.length && tries.length > 0 && idx >= this.scrollOffset) ui.puts();

      const isSelected = idx === this.cursorPos;
      ui.print(isSelected ? "{b}→ {/b}" : "  ");

      if (idx < tries.length) {
        this.renderRow(tries[idx]!, isSelected, termWidth, query);
      } else {
        // "Create new" option
        if (isSelected) ui.print("{section}");
        const prefix = this.opts.prefixFor(this.opts.createSpace(this.scope));
        const displayText = `📂 Create new: ${prefix}${query}`;
        ui.print(displayText);
        // Pad to full width
        const paddingNeeded = termWidth - 3 - len(displayText); // -3 for arrow + space
        ui.print(" ".repeat(Math.max(paddingNeeded, 1)));
      }

      // End selection and reset all formatting
      ui.puts();
    }

    // Scroll indicator if needed
    if (totalItems > maxVisible) {
      ui.puts(`{dim}${separator}{/fg}`);
      ui.puts(`{dim}[${this.scrollOffset + 1}-${visibleEnd}/${totalItems}]{/fg}`);
    }

    // Instructions at bottom
    ui.puts(`{dim}${separator}{/fg}`);

    if (this.deleteStatus) {
      ui.puts(`{b}${this.deleteStatus}{/b}`);
      this.deleteStatus = null; // Clear after showing
    } else if (this.deleteMode) {
      const count = this.marked.length;
      ui.puts(`{strike} DELETE MODE {/strike} ${count} marked  |  Ctrl-D: Toggle  Enter: Confirm  Esc: Cancel`);
    } else {
      // The extra hints only when they fit: a wrapped footer would leave stale rows behind the differential redraw.
      ui.puts(`{dim}${len(HELP) < termWidth ? HELP : TRY_HELP}{/fg}`);
    }

    ui.flush();
  }

  private renderRow(row: Row, isSelected: boolean, termWidth: number, query: string): void {
    const ui = this.ui;
    const { item } = row;
    this.startDirtyCheck(item);
    const isMarked = this.marked.includes(item.path);
    const spacePrefix = this.scope === "*" ? `${item.space}/` : "";

    const timeText = formatRelativeTime(item.recency, this.now);
    const metaText = `${timeText}, ${formatScore(row.score)}`;
    const metaWidth = len(metaText) + 1; // +1 for leading space

    // Layout: "→ 📁 name                    meta"; metadata is right-aligned and hidden if the name overlaps.
    const prefixWidth = 5;
    const metaStart = termWidth - metaWidth;
    const maxNameForMeta = metaStart - prefixWidth - 1; // -1 for min gap
    // Max name width before truncation (leave 1 char at end)
    const maxNameWidth = termWidth - prefixWidth - 1 - len(spacePrefix);

    if (isMarked) ui.print("{strike}");
    ui.print(isMarked ? "🗑️  " : "📁 ");
    if (isSelected) ui.print("{section}");
    if (spacePrefix) ui.print(`{dim}${spacePrefix}{/fg}`);

    let displayText: string;
    const m = DATE_NAME.exec(item.basename);
    if (m) {
      const datePart = m[1]!;
      let namePart = m[2]!;
      let fullName = `${datePart}-${namePart}`;

      // Truncate only if exceeds terminal width
      if (len(fullName) > maxNameWidth && maxNameWidth > 14) {
        const availableForName = maxNameWidth - 11 - 1 - 1; // date + dash + ellipsis
        if (len(namePart) > availableForName + 1) namePart = `${take(namePart, availableForName)}…`;
        fullName = `${datePart}-${namePart}`;
      }

      // Render the date part (faint)
      ui.print(`{dim}${datePart}{/fg}`);
      const separatorMatches = query !== "" && query.includes("-");
      ui.print(separatorMatches ? "{b}-{/b}" : "{dim}-{/fg}");
      ui.print(query !== "" ? highlightMatches(namePart, query) : namePart);
      displayText = fullName;
    } else {
      let name = item.basename;
      if (len(name) > maxNameWidth && maxNameWidth > 2) name = `${take(name, maxNameWidth - 1)}…`;
      ui.print(query !== "" ? highlightMatches(name, query) : name);
      displayText = name;
    }

    if (isSelected) ui.print("{/section}");

    let shownWidth = len(spacePrefix) + len(displayText);
    const badges = this.badgeText(item);
    if (badges && shownWidth + 2 + len(badges) <= maxNameForMeta) {
      ui.print(`  {dim}${badges}{/fg}`);
      shownWidth += 2 + len(badges);
    }

    // Show metadata if name doesn't overlap its position
    if (shownWidth <= maxNameForMeta) {
      ui.print(" ".repeat(metaStart - prefixWidth - shownWidth));
      ui.print(`{dim}${metaText}{/fg}`);
    }

    if (isMarked) ui.print("{/strike}");
  }

  private badgeText(item: PickerItem): string {
    const parts: string[] = [];
    if (item.badges) parts.push(item.badges);
    if (this.dirty.get(item) === true) parts.push("*");
    if (item.stale) parts.push("stale");
    return parts.join(" ");
  }

  // --- actions ----------------------------------------------------------------------------------

  private async handleCreateNew(): Promise<PickerResult> {
    const space = this.opts.createSpace(this.scope);
    const prefix = this.opts.prefixFor(space);

    // If user already typed a name, use it directly
    if (this.input.length > 0) return { type: "mkdir", space, name: dashify(`${prefix}${this.query}`) };

    // No name typed, prompt for one
    this.ui.cls();
    this.ui.puts("{h2}Enter new name");
    this.ui.puts();
    this.ui.puts(`> {dim}${prefix}{/fg}`);
    this.ui.flush();
    this.stderr.write("\x1b[?25h");

    const entry = await this.promptLine();
    if (entry === "") {
      this.stderr.write("\x1b[?25l");
      return null;
    }
    return { type: "mkdir", space, name: dashify(`${prefix}${entry}`) };
  }

  private async handleMove(item: PickerItem): Promise<PickerResult> {
    this.ui.cls();
    this.ui.puts("{h2}Move to (space/name):");
    this.ui.puts();
    this.ui.puts(`{dim}current: ${item.space}/${item.basename}{/fg}`);
    this.ui.puts(`> `);
    this.ui.flush();
    this.stderr.write("\x1b[?25h");

    const to = await this.promptLine();
    if (to === "") {
      this.stderr.write("\x1b[?25l");
      return null;
    }
    return { type: "move", from: item.path, to };
  }

  private async confirmBatchDelete(tries: Row[]): Promise<PickerResult> {
    // Find marked items with their info
    const markedItems = tries.filter((t) => this.marked.includes(t.item.path)).map((t) => t.item);
    if (markedItems.length === 0) return null;

    const ui = this.ui;
    const n = markedItems.length;
    ui.cls();
    ui.puts(`{h2}Delete ${n} Director${n === 1 ? "y" : "ies"}{reset}`);
    ui.puts();
    for (const item of markedItems) {
      const spacePrefix = this.scope === "*" ? `{dim}${item.space}/{/fg}` : "";
      ui.puts(`  {strike}📁 ${spacePrefix}${item.basename}{/strike}`);
    }
    const warnings = this.opts.deleteWarnings?.(markedItems.map((i) => i.path)) ?? [];
    if (warnings.length > 0) {
      ui.puts();
      for (const w of warnings) ui.puts(`  {b}${w}{/b}`);
    }
    ui.puts();
    ui.puts("{b}Type {/b}YES{b} to confirm deletion: {/b}");
    ui.flush();
    this.stderr.write("\x1b[?25h"); // Show cursor after flushing

    // Confirmation input: in tests, read from test keys; otherwise read from the terminal
    let confirmation: string;
    const testConfirm = this.opts.test?.confirm;
    if (this.testKeys && this.testKeys.length > 0) {
      confirmation = this.takeTestLine();
    } else if (testConfirm !== undefined || !this.ui.isTTY) {
      confirmation = chomp(testConfirm ?? (await this.getTerminal().readLine()) ?? "");
    } else {
      confirmation = await this.cookedLine();
    }

    let result: PickerResult = null;
    if (confirmation === "YES") {
      try {
        let baseReal: string;
        try {
          baseReal = realpathSync(this.opts.rootPath);
        } catch (e) {
          throw new SafetyError(realpathError(e, this.opts.rootPath));
        }
        // Validate all paths first
        const validated: string[] = [];
        for (const item of markedItems) {
          let targetReal: string;
          try {
            targetReal = realpathSync(item.path);
          } catch (e) {
            throw new SafetyError(realpathError(e, item.path));
          }
          if (!targetReal.startsWith(`${baseReal}/`)) {
            throw new SafetyError(`Safety check failed: ${targetReal} is not inside ${baseReal}`);
          }
          validated.push(targetReal);
        }
        result = { type: "delete", paths: validated };
        this.marked = [];
        this.deleteMode = false;
      } catch (e) {
        if (!(e instanceof SafetyError)) throw e;
        this.deleteStatus = `Error: ${e.message}`;
      }
    } else {
      this.deleteStatus = "Delete cancelled";
      this.marked = [];
      this.deleteMode = false;
    }

    // Hide cursor again for main UI
    this.stderr.write("\x1b[?25l");
    return result;
  }
}

function highlightMatches(text: string, query: string): string {
  if (query === "") return text;
  const chars = Array.from(text);
  const textLower = Array.from(text.toLowerCase());
  const queryChars = Array.from(query.toLowerCase());
  let queryIndex = 0;
  let result = "";
  chars.forEach((char, i) => {
    if (queryIndex < queryChars.length && textLower[i] === queryChars[queryIndex]) {
      result += `{b}${char}{/b}`; // Bold yellow for matches
      queryIndex += 1;
    } else {
      result += char;
    }
  });
  return result;
}

export function runPicker(opts: PickerOptions): Promise<PickerResult> {
  return new Picker(opts).run();
}
