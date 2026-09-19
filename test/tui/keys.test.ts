import { describe, expect, test } from "bun:test";
import { parseTestKeys } from "../../src/tui/index.ts";
import { nextKey, splitKeys } from "../../src/tui/keys.ts";

describe("parseTestKeys", () => {
  test("empty / missing", () => {
    expect(parseTestKeys(undefined)).toBeUndefined();
    expect(parseTestKeys("")).toBeUndefined();
  });

  test("token mode", () => {
    expect(parseTestKeys("UP,DOWN,LEFT,RIGHT,ENTER,ESC,BACKSPACE")).toEqual([
      "\x1b[A",
      "\x1b[B",
      "\x1b[D",
      "\x1b[C",
      "\r",
      "\x1b",
      "\x7f",
    ]);
    expect(parseTestKeys("CTRL-A,CTRLB,ctrl-d, CTRL-E,CTRL-F,CTRL-H,CTRL-K,CTRL-N,CTRL-P,CTRL-T,CTRL-W")).toEqual([
      "\x01",
      "\x02",
      "\x04",
      "\x05",
      "\x06",
      "\x08",
      "\x0b",
      "\x0e",
      "\x10",
      "\x14",
      "\x17",
    ]);
  });

  test("work additions: TAB, SHIFT-TAB, CTRL-R", () => {
    expect(parseTestKeys("TAB,SHIFT-TAB,SHIFTTAB,CTRL-R,CTRLR")).toEqual(["\t", "\x1b[Z", "\x1b[Z", "\x12", "\x12"]);
    expect(parseTestKeys("TAB")).toEqual(["\t"]);
  });

  test("uppercase-only spec without comma is token mode", () => {
    expect(parseTestKeys("ENTER")).toEqual(["\r"]);
    expect(parseTestKeys("CTRL-T")).toEqual(["\x14"]);
  });

  test("TYPE= types the upper-cased text like try", () => {
    expect(parseTestKeys("TYPE=foo bar,ENTER")).toEqual(["F", "O", "O", " ", "B", "A", "R", "\r"]);
  });

  test("single chars pass through, unknown tokens are dropped", () => {
    expect(parseTestKeys("a,Y,E,S,NOPE,\x03")).toEqual(["a", "Y", "E", "S", "\x03"]);
  });

  test("raw mode", () => {
    expect(parseTestKeys("abc")).toEqual(["a", "b", "c"]);
    expect(parseTestKeys("x\x1b[By\x1b[A\r")).toEqual(["x", "\x1b[B", "y", "\x1b[A", "\r"]);
    // a trailing incomplete sequence stays split
    expect(parseTestKeys("a\x1b[")).toEqual(["a", "\x1b", "["]);
    expect(parseTestKeys("é😀")).toEqual(["é", "😀"]);
  });
});

describe("terminal key splitting", () => {
  test("multi-key chunks", () => {
    expect(splitKeys("abc\r")).toEqual(["a", "b", "c", "\r"]);
  });

  test("escape sequences", () => {
    expect(splitKeys("\x1b[A\x1b[B\x1b[Z")).toEqual(["\x1b[A", "\x1b[B", "\x1b[Z"]);
    expect(splitKeys("\x1b[1;5C")).toEqual(["\x1b[1;5C"]);
    expect(splitKeys("\x1bOA")).toEqual(["\x1bOA"]);
    expect(splitKeys("\x1b[3~x")).toEqual(["\x1b[3~", "x"]);
  });

  test("lone and doubled Esc, Alt combos", () => {
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
    expect(splitKeys("\x1b\x1b")).toEqual(["\x1b", "\x1b"]);
    expect(splitKeys("\x1bx")).toEqual(["\x1bx"]);
  });

  test("astral characters are one key", () => {
    expect(nextKey("😀a")).toEqual(["😀", "a"]);
  });
});
