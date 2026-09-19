// Interactive picker: port of try's TrySelector with a space bar (scopes), create rows per prefix, badges and move.

import { realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { spaceName, spaceNameError } from "../naming.ts";
import { calculateScore, dashify, formatRelativeTime, formatScore } from "./format.ts";
import { type InputStream, TerminalInput } from "./input.ts";
import { UI, type UIOutput } from "./ui.ts";

export interface PickerItem {
  /** workspace folder name (matching + display) */
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

export interface CreateOption {
  /** literal text before the name: "2026-09-19-", "IMG-1-", "" */
  prefix: string;
  /** dim hint: "", "no date", "date" */
  label: string;
}

export interface PickerOptions {
  /** all items across spaces; the picker filters by scope */
  items: PickerItem[];
  /** ["*", ...existing spaces sorted]; "*" means all spaces */
  scopes: string[];
  scope: string;
  /** initial search term (whitespace -> "-") */
  query?: string;
  /** try's --and-type */
  initialInput?: string;
  /** where creation goes in scope "*" */
  defaultSpace: string;
  /** create rows for a space (also for spaces that don't exist yet); first = default (Ctrl-T) */
  createOptions: (space: string) => CreateOption[];
  /** create a space; may throw (message is shown, picker stays open) */
  addSpace: (name: string, prefix: "auto" | "") => void;
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

interface CreateRow {
  space: string;
  option: CreateOption;
  isNewSpace: boolean;
}

/** What the list shows for the current scope and query. */
interface View {
  rows: Row[];
  creates: CreateRow[];
  /** space new workspaces go to */
  target: string;
  /** query without a leading `space/` */
  rest: string;
  /** rows show a dim `space/` before the name */
  showSpace: boolean;
}

/** Pseudo scope for the "+ new" tab. Contains a space, so it can never be a space name. */
const NEW_TAB = "+ new";
const DATE_NAME = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const PRINTABLE = /^[a-zA-Z0-9\-_. /]$/;
const ALNUM = /[a-zA-Z0-9]/;
const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
const HELP = "↑↓ Enter  ^T New  ^D Delete  ^R Move  Tab Space  Esc";
const HEADER = "📁 work";
const HEADER_WIDTH = 7; // 📁 is two columns wide

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

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  private scopes: string[];
  private status: string | null = null;
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
  private readonly createOptionsCache = new Map<string, CreateOption[]>();

  constructor(private readonly opts: PickerOptions) {
    const searchTerm = dashify(opts.query ?? "");
    const initial = opts.initialInput !== undefined ? dashify(opts.initialInput) : searchTerm;
    this.input = Array.from(initial);
    this.inputCursorPos = this.input.length;
    this.scope = opts.scope;
    this.scopes = [...opts.scopes];

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
        this.render(this.view());
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

  private spaceExists(space: string): boolean {
    return space !== "*" && this.scopes.includes(space);
  }

  /** Space named by typed text: an existing space as typed, else normalized like a new space name. */
  private typedSpace(text: string): string {
    return this.spaceExists(text) ? text : spaceName(text);
  }

  /** Why `name` (normalized) can't become a new space, or undefined. */
  private newSpaceProblem(name: string): string | undefined {
    if (this.scopes.some((s) => s !== "*" && s.toLowerCase() === name.toLowerCase())) return `Space ${name} already exists`;
    return spaceNameError(name);
  }

  private createOptions(space: string): CreateOption[] {
    let options = this.createOptionsCache.get(space);
    if (!options) {
      options = this.opts.createOptions(space);
      this.createOptionsCache.set(space, options);
    }
    return options;
  }

  private view(): View {
    this.now = this.opts.now ?? new Date();
    if (this.scope === NEW_TAB) return { rows: [], creates: [], target: "", rest: this.query, showSpace: false };

    // `space/rest` narrows the list to that space and creates there
    const query = this.query;
    let listSpace: string | null = this.scope === "*" ? null : this.scope;
    let target = this.scope === "*" ? this.opts.defaultSpace : this.scope;
    let rest = query;
    const slash = query.indexOf("/");
    const querySpace = slash >= 0 ? this.typedSpace(query.slice(0, slash)) : "";
    if (slash >= 0 && (this.spaceExists(querySpace) || !spaceNameError(querySpace))) {
      listSpace = querySpace;
      target = querySpace;
      rest = query.slice(slash + 1);
    }

    const items = listSpace === null ? this.opts.items : this.opts.items.filter((i) => i.space === listSpace);
    const scored = items.map((item) => ({ item, score: calculateScore(item.basename, rest, item.recency, this.now) }));
    // Filter only if searching, otherwise show all
    const rows = (rest === "" ? scored : scored.filter((r) => r.score > 0)).sort((a, b) => b.score - a.score);

    const isNewSpace = !this.spaceExists(target);
    const creates =
      rest === "" || rest.includes("/")
        ? []
        : this.createOptions(target).map((option) => ({ space: target, option, isNewSpace }));

    return { rows, creates, target, rest, showSpace: listSpace !== this.scope };
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
      const view = this.view();
      const tries = view.rows;
      const totalItems = tries.length + view.creates.length;

      // Ensure cursor is within bounds
      this.cursorPos = Math.min(Math.max(this.cursorPos, 0), Math.max(totalItems - 1, 0));

      this.render(view);

      const key = await this.readKey();
      if (key === null) continue;

      switch (key) {
        case "\r": {
          // Enter
          if (this.scope === NEW_TAB) {
            await this.handleNewSpace();
          } else if (this.deleteMode && this.marked.length > 0) {
            const result = await this.confirmBatchDelete(view);
            if (result) return result;
          } else if (this.cursorPos < tries.length) {
            return { type: "cd", path: tries[this.cursorPos]!.item.path };
          } else if (this.cursorPos - tries.length < view.creates.length) {
            const row = view.creates[this.cursorPos - tries.length]!;
            const result = await this.createWorkspace(row.space, row.option, view.rest);
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
          // Ctrl-T - create new (immediate, first create option)
          if (this.scope === NEW_TAB) {
            await this.handleNewSpace();
          } else {
            const result = await this.handleCreateNew(view);
            if (result) return result;
          }
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

  /** Tabs: the given scopes, then "+ new". */
  private get tabs(): string[] {
    return [...this.scopes, NEW_TAB];
  }

  private cycleScope(step: number): void {
    const tabs = this.tabs;
    const idx = Math.max(tabs.indexOf(this.scope), 0);
    this.scope = tabs[(idx + step + tabs.length) % tabs.length]!;
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

  private render(view: View): void {
    const ui = this.ui;
    const termWidth = ui.width();
    const termHeight = ui.height();
    const tries = view.rows;
    const matchQuery = view.rest;

    // Use actual terminal width for separator lines
    const separator = "─".repeat(Math.max(termWidth - 1, 0));

    // Header: space bar
    ui.puts(this.spaceBar(termWidth - 1));
    ui.puts(`{dim}${separator}{/fg}`);

    // Search input with cursor at correct position
    const beforeCursor = this.input.slice(0, this.inputCursorPos).join("");
    const charAtCursor = this.input[this.inputCursorPos] ?? " ";
    const afterCursor = this.input.slice(this.inputCursorPos + 1).join("");
    const label = this.scope === NEW_TAB ? "New space:" : "Search:";
    ui.puts(`{dim}${label}{/fg} {b}${beforeCursor}\x1b[7m${charAtCursor}\x1b[27m${afterCursor}{/b}`);
    ui.puts(`{dim}${separator}{/fg}`);

    // Calculate visible window based on actual terminal height
    const maxVisible = Math.max(termHeight - 8, 3);
    const totalItems = tries.length + view.creates.length;

    // Adjust scroll window
    if (this.cursorPos < this.scrollOffset) {
      this.scrollOffset = this.cursorPos;
    } else if (this.cursorPos >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.cursorPos - maxVisible + 1;
    }

    const visibleEnd = Math.min(this.scrollOffset + maxVisible, totalItems);

    if (this.scope === NEW_TAB) ui.puts(`  {dim}${this.newSpaceHint()}{/fg}`);

    for (let idx = this.scrollOffset; idx < visibleEnd; idx++) {
      // Add blank line before the create rows
      if (idx === tries.length && tries.length > 0 && idx >= this.scrollOffset) ui.puts();

      const isSelected = idx === this.cursorPos;
      ui.print(isSelected ? "{b}→ {/b}" : "  ");

      if (idx < tries.length) {
        this.renderRow(tries[idx]!, isSelected, termWidth, matchQuery, view.showSpace);
      } else {
        this.renderCreateRow(view.creates[idx - tries.length]!, isSelected, termWidth, view.rest);
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

    if (this.status) {
      ui.puts(`{b}${this.status}{/b}`);
      this.status = null; // Clear after showing
    } else if (this.deleteMode) {
      const count = this.marked.length;
      ui.puts(`{strike} DELETE MODE {/strike} ${count} marked  |  Ctrl-D: Toggle  Enter: Confirm  Esc: Cancel`);
    } else {
      ui.puts(`{dim}${HELP}{/fg}`);
    }

    ui.flush();
  }

  /**
   * `📁 work   all  [tries]  labs  + new`: tabs are ` name ` / `[name]` so labels don't shift when the active tab
   * changes. When too wide, tabs around the active one are kept and the rest elided with `…`.
   */
  private spaceBar(maxWidth: number): string {
    const labels = this.tabs.map((t) => (t === "*" ? "all" : t));
    const widths = labels.map((l) => len(l) + 2);
    const active = this.tabs.indexOf(this.scope);
    const n = labels.length;
    const fits = (lo: number, hi: number): boolean => {
      let w = HEADER_WIDTH + 2;
      for (let i = lo; i <= hi; i++) w += widths[i]!;
      if (lo > 0) w += 3;
      if (hi < n - 1) w += 3;
      return w <= maxWidth;
    };

    let lo = 0;
    let hi = n - 1;
    if (!fits(lo, hi)) {
      lo = hi = Math.max(active, 0);
      for (let grew = true; grew; ) {
        grew = false;
        if (hi < n - 1 && fits(lo, hi + 1)) {
          hi++;
          grew = true;
        }
        if (lo > 0 && fits(lo - 1, hi)) {
          lo--;
          grew = true;
        }
      }
    }

    let bar = `{h1}${HEADER}{reset}  `;
    if (lo > 0) bar += "{dim} … {/fg}";
    for (let i = lo; i <= hi; i++) {
      bar += i === active ? `{section}[${labels[i]}]{/section}` : `{dim} ${labels[i]} {/fg}`;
    }
    if (hi < n - 1) bar += "{dim} … {/fg}";
    return bar;
  }

  private renderRow(row: Row, isSelected: boolean, termWidth: number, query: string, showSpace: boolean): void {
    const ui = this.ui;
    const { item } = row;
    this.startDirtyCheck(item);
    const isMarked = this.marked.includes(item.path);
    const spacePrefix = showSpace ? `${item.space}/` : "";

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

  /** `📂 New tries/2026-09-19-query` with a right-aligned dim label / `(new space)`. */
  private renderCreateRow(row: CreateRow, isSelected: boolean, termWidth: number, rest: string): void {
    const ui = this.ui;
    const prefixWidth = 5; // "→ 📂 "
    const hint = [row.isNewSpace ? "(new space)" : "", row.option.label].filter(Boolean).join("  ");
    const metaStart = termWidth - (len(hint) + 1);
    let text = `New ${row.space}/${row.option.prefix}${rest}`;

    const maxText = hint ? metaStart - prefixWidth - 1 : termWidth - prefixWidth - 1;
    if (len(text) > maxText && maxText > 2) text = `${take(text, maxText - 1)}…`;

    ui.print("📂 ");
    if (isSelected) ui.print("{section}");
    ui.print(text);
    if (isSelected) ui.print("{/section}");
    if (hint && len(text) <= metaStart - prefixWidth - 1) {
      ui.print(" ".repeat(metaStart - prefixWidth - len(text)));
      ui.print(`{dim}${hint}{/fg}`);
    }
  }

  private badgeText(item: PickerItem): string {
    const parts: string[] = [];
    if (item.badges) parts.push(item.badges);
    if (this.dirty.get(item) === true) parts.push("*");
    if (item.stale) parts.push("stale");
    return parts.join(" ");
  }

  // --- actions ----------------------------------------------------------------------------------

  /** Ctrl-T: first create option for the target space; prompts for a name when there is none. */
  private async handleCreateNew(view: View): Promise<PickerResult> {
    const space = view.target;
    const option = this.createOptions(space)[0];
    if (!option) return null;
    if (view.rest !== "") {
      if (view.rest.includes("/")) {
        this.status = `Invalid name: ${view.rest}`;
        return null;
      }
      return this.createWorkspace(space, option, view.rest);
    }

    // No name typed, prompt for one
    this.ui.cls();
    this.ui.puts("{h2}Enter new name");
    this.ui.puts();
    this.ui.puts(`> {dim}${space}/${option.prefix}{/fg}`);
    this.ui.flush();
    this.stderr.write("\x1b[?25h");

    const rest = await this.promptLine();
    this.stderr.write("\x1b[?25l");
    if (rest === "") return null;
    return this.createWorkspace(space, option, rest);
  }

  /** mkdir result; a space that doesn't exist yet is created first (after asking for its default prefix). */
  private async createWorkspace(space: string, option: CreateOption, rest: string): Promise<PickerResult> {
    if (!this.spaceExists(space)) {
      const variant = await this.chooseSpaceDefault(space, option.prefix === "" ? "" : "auto");
      if (variant === null || !this.addSpace(space, variant)) return null;
    }
    return { type: "mkdir", space, name: dashify(`${option.prefix}${rest}`) };
  }

  /** "+ new" tab hint: what Enter would create (the normalized name), or why it can't. */
  private newSpaceHint(): string {
    const name = spaceName(this.query);
    if (name === "") return "Type a name, Enter to create · Tab to leave";
    return this.newSpaceProblem(name) ?? `Enter creates ${name} · Tab to leave`;
  }

  /** "+ new" tab: Enter / Ctrl-T creates the typed space and switches to it. */
  private async handleNewSpace(): Promise<void> {
    const name = spaceName(this.query);
    if (name === "") return;
    const problem = this.newSpaceProblem(name);
    if (problem) {
      this.status = problem;
      return;
    }
    const variant = await this.chooseSpaceDefault(name, "auto");
    if (variant === null || !this.addSpace(name, variant)) return;
    this.scope = name;
    this.input = [];
    this.inputCursorPos = 0;
    this.cursorPos = 0;
  }

  private addSpace(name: string, variant: "auto" | ""): boolean {
    try {
      this.opts.addSpace(name, variant);
    } catch (e) {
      this.status = `Error: ${errorMessage(e)}`;
      return false;
    }
    const spaces = [...this.scopes.filter((s) => s !== "*"), name].sort();
    this.scopes = this.scopes.includes("*") ? ["*", ...spaces] : spaces;
    this.createOptionsCache.delete(name);
    return true;
  }

  /** Choice screen for a new space's default prefix. null = back to the list. */
  private async chooseSpaceDefault(name: string, preselect: "auto" | ""): Promise<"auto" | "" | null> {
    const choices: Array<["auto" | "", string, string]> = [
      ["auto", "date", `(${localDate(this.opts.now ?? new Date())}-name)`],
      ["", "no date", "(name)"],
    ];
    let selected = preselect === "" ? 1 : 0;
    const ui = this.ui;
    ui.cls();
    for (;;) {
      ui.puts(`{h2}New space "${name}" — default for new workspaces:{reset}`);
      ui.puts();
      choices.forEach(([, label, example], i) => {
        const isSelected = i === selected;
        ui.print(isSelected ? "{b}→ {/b}" : "  ");
        ui.print(isSelected ? `{section}${label.padEnd(7)}{/section}` : label.padEnd(7));
        ui.puts(`   {dim}${example}{/fg}`);
      });
      ui.puts();
      ui.puts("{dim}↑↓ Enter  Esc Back{/fg}");
      ui.flush();

      const key = await this.readKey();
      switch (key) {
        case "\x1b[A":
        case "\x10":
          selected = Math.max(selected - 1, 0);
          break;
        case "\x1b[B":
        case "\x0e":
          selected = Math.min(selected + 1, choices.length - 1);
          break;
        case "\r":
          return choices[selected]![0];
        case "\x1b":
        case "\x03":
          return null;
      }
    }
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

  private async confirmBatchDelete(view: View): Promise<PickerResult> {
    // Find marked items with their info
    const markedItems = view.rows.filter((t) => this.marked.includes(t.item.path)).map((t) => t.item);
    if (markedItems.length === 0) return null;

    const ui = this.ui;
    const n = markedItems.length;
    ui.cls();
    ui.puts(`{h2}Delete ${n} Director${n === 1 ? "y" : "ies"}{reset}`);
    ui.puts();
    for (const item of markedItems) {
      const spacePrefix = view.showSpace ? `{dim}${item.space}/{/fg}` : "";
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
        this.status = `Error: ${e.message}`;
      }
    } else {
      this.status = "Delete cancelled";
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
