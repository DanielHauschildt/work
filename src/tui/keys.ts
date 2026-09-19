// Key specs for tests (try's parse_test_keys) and splitting raw terminal input into keys.

const TOKEN_KEYS: Record<string, string> = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  LEFT: "\x1b[D",
  RIGHT: "\x1b[C",
  ENTER: "\r",
  ESC: "\x1b",
  BACKSPACE: "\x7f",
  TAB: "\t",
  "SHIFT-TAB": "\x1b[Z",
  SHIFTTAB: "\x1b[Z",
  "CTRL-A": "\x01",
  CTRLA: "\x01",
  "CTRL-B": "\x02",
  CTRLB: "\x02",
  "CTRL-D": "\x04",
  CTRLD: "\x04",
  "CTRL-E": "\x05",
  CTRLE: "\x05",
  "CTRL-F": "\x06",
  CTRLF: "\x06",
  "CTRL-H": "\x08",
  CTRLH: "\x08",
  "CTRL-K": "\x0b",
  CTRLK: "\x0b",
  "CTRL-N": "\x0e",
  CTRLN: "\x0e",
  "CTRL-P": "\x10",
  CTRLP: "\x10",
  "CTRL-R": "\x12",
  CTRLR: "\x12",
  "CTRL-T": "\x14",
  CTRLT: "\x14",
  "CTRL-W": "\x17",
  CTRLW: "\x17",
};

/**
 * try's `--and-keys` parser. Token mode (spec contains a comma or is only uppercase letters/hyphens):
 * `UP,DOWN,TYPE=foo,ENTER`; like try, TYPE= types the upper-cased text. Otherwise raw mode: every char is a key,
 * `\e[X` sequences are one key.
 */
export function parseTestKeys(spec: string | undefined): string[] | undefined {
  if (!spec) return undefined;

  const useTokenMode = spec.includes(",") || /^[A-Z-]+$/m.test(spec);

  if (useTokenMode) {
    const keys: string[] = [];
    for (const tok of spec.split(/,\s*/)) {
      const up = tok.toUpperCase();
      if (Object.hasOwn(TOKEN_KEYS, up)) {
        keys.push(TOKEN_KEYS[up]!);
        continue;
      }
      const typed = /^TYPE=(.*)$/m.exec(up);
      if (typed) {
        keys.push(...Array.from(typed[1]!));
      } else if (Array.from(tok).length === 1) {
        keys.push(tok);
      }
    }
    return keys;
  }

  const chars = Array.from(spec);
  const keys: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "\x1b" && i + 2 < chars.length && chars[i + 1] === "[") {
      keys.push(chars.slice(i, i + 3).join(""));
      i += 3;
    } else {
      keys.push(chars[i]!);
      i += 1;
    }
  }
  return keys;
}

/**
 * Take one key off the front of decoded terminal input. Escape sequences (CSI `\e[...X`, SS3 `\eOX`, Alt-x `\ex`)
 * form a single key like try's read_key; a lone `\e` is Esc.
 */
export function nextKey(input: string): [key: string, rest: string] {
  const cp = input.codePointAt(0)!;
  const first = String.fromCodePoint(cp);
  if (first !== "\x1b" || input.length === 1) return [first, input.slice(first.length)];

  const second = input[1]!;
  if (second === "[") {
    let j = 2;
    // parameter (0x30-0x3F) and intermediate (0x20-0x2F) bytes, then one final byte (0x40-0x7E)
    while (j < input.length) {
      const c = input.charCodeAt(j);
      if (c >= 0x20 && c <= 0x3f) {
        j++;
        continue;
      }
      if (c >= 0x40 && c <= 0x7e) j++;
      break;
    }
    return [input.slice(0, j), input.slice(j)];
  }
  if (second === "O" && input.length >= 3) return [input.slice(0, 3), input.slice(3)];
  if (second === "\x1b") return ["\x1b", input.slice(1)];
  const alt = String.fromCodePoint(input.codePointAt(1)!);
  return ["\x1b" + alt, input.slice(1 + alt.length)];
}

export function splitKeys(input: string): string[] {
  const keys: string[] = [];
  let rest = input;
  while (rest.length > 0) {
    const [key, next] = nextKey(rest);
    keys.push(key);
    rest = next;
  }
  return keys;
}
