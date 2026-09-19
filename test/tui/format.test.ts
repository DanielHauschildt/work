import { describe, expect, test } from "bun:test";
import { calculateScore, formatRelativeTime, formatScore } from "../../src/tui/index.ts";

const NOW_MS = 1789819200123;
const NOW = new Date(NOW_MS);

// Expected values computed by try's calculate_score (copied into a `ruby` script, Time.now replaced by NOW).
// [basename, query, age in ms, score, sprintf("%.1f", score)]
const RUBY_SCORES: Array<[string, string, number, number, string]> = [
  ["2026-09-18-redis-bench", "", 0, 5, "5.0"],
  ["2026-09-18-redis-bench", "redis", 7200000, 3.2945508075688776, "3.3"],
  ["2026-09-18-redis-bench", "rb", 90061000, 0.82484069203742072, "0.8"],
  ["2026-09-18-redis-bench", "2026", 3600000, 6.1838203435596419, "6.2"],
  ["2026-09-18-redis-bench", "zz", 1000, 0, "0.0"],
  ["redis-bench", "redis", 7200000, 8.3987174742355428, "8.4"],
  ["redis-bench", "", 604800000, 0.23076923076923078, "0.2"],
  ["2025-08-13-v", "v", 86400000, 0.75151515151515147, "0.8"],
  ["2025-08-13-vbo-viz", "v", 86400000, 0.71904761904761905, "0.7"],
  ["My_Project.v2", "mp", 12345678, 2.3286425586663086, "2.3"],
  ["My_Project.v2", "p.v", 42000, 3.7169917541522333, "3.7"],
  ["foo bar baz", "fbb", 1000000000, 1.44951814202511, "1.4"],
  ["café-münchen", "cm", 5000000, 2.6825697950861209, "2.7"],
  ["ÉCOLE-test", "école", 60000, 10.475308222082788, "10.5"],
  ["x", "x", 1, 4.818181401515238, "4.8"],
  ["abc", "abcd", 0, 0, "0.0"],
  ["a-b-c-d-e", "ace", 31536000000, 1.4355599808129325, "1.4"],
  ["2026-01-01-", "", 999, 4.9995838366120022, "5.0"],
  ["IMG-1234-autofit", "img1234", 3000000, 9.0858148634266271, "9.1"],
  ["IMG-1234-autofit", "autofit", 3000000, 5.5810314530126046, "5.6"],
  ["emoji-😀-dir", "ed", 777777, 3.2185874774021404, "3.2"],
];

describe("calculateScore", () => {
  for (const [name, query, age, score, shown] of RUBY_SCORES) {
    test(`${name} / "${query}"`, () => {
      const s = calculateScore(name, query, new Date(NOW_MS - age), NOW);
      expect(s).toBe(score);
      expect(formatScore(s)).toBe(shown);
    });
  }

  test("query is matched case-insensitively", () => {
    const r = new Date(NOW_MS - 3_600_000);
    expect(calculateScore("Redis", "REDIS", r, NOW)).toBe(calculateScore("redis", "redis", r, NOW));
  });

  test("invalid recency skips the bonus", () => {
    expect(calculateScore("2026-09-18-x", "", new Date(Number.NaN), NOW)).toBe(2);
  });

  test("far-future recency does not produce NaN", () => {
    expect(Number.isFinite(calculateScore("x", "", new Date(NOW_MS + 10 * 3_600_000), NOW))).toBe(true);
  });
});

// Ruby's format_relative_time for the same ages.
const RUBY_TIMES: Array<[number, string]> = [
  [0, "just now"],
  [59999, "just now"],
  [60000, "1m ago"],
  [119999, "1m ago"],
  [3599999, "59m ago"],
  [3600000, "1h ago"],
  [86399999, "23h ago"],
  [86400000, "1d ago"],
  [604799999, "6d ago"],
  [604800000, "1w ago"],
  [1209600000, "2w ago"],
  [31536000000, "52w ago"],
  [-5000, "just now"],
  [-7200000, "just now"],
];

describe("formatRelativeTime", () => {
  for (const [age, text] of RUBY_TIMES) {
    test(`${age}ms -> ${text}`, () => {
      expect(formatRelativeTime(new Date(NOW_MS - age), NOW)).toBe(text);
    });
  }

  test("invalid date", () => {
    expect(formatRelativeTime(new Date(Number.NaN), NOW)).toBe("?");
  });
});

// Ruby's sprintf("%.1f") rounds near-ties half-even (dtoa fast path), unlike JS toFixed.
const RUBY_FIXED: Array<[number, string]> = [
  [0, "0.0"],
  [0.040000000000000001, "0.0"],
  [0.050000000000000003, "0.1"],
  [0.049999999999999996, "0.0"],
  [0.089999999999999997, "0.1"],
  [0.10000000000000001, "0.1"],
  [0.14999999999999999, "0.2"],
  [0.25, "0.2"],
  [0.34999999999999998, "0.4"],
  [0.45000000000000001, "0.4"],
  [0.55000000000000004, "0.6"],
  [0.65000000000000002, "0.6"],
  [0.75, "0.8"],
  [0.84999999999999998, "0.8"],
  [0.94999999999999996, "1.0"],
  [1.05, "1.0"],
  [1.1499999999999999, "1.2"],
  [1.25, "1.2"],
  [2.25, "2.2"],
  [2.6749999999999998, "2.7"],
  [5.25, "5.2"],
  [9.9499999999999993, "10.0"],
  [9.9600000000000009, "10.0"],
  [10.050000000000001, "10.0"],
  [10.25, "10.2"],
  [99.950000000000003, "100.0"],
  [100.05, "100.0"],
  [0.35000000000000003, "0.4"],
  [0.45000000000000012, "0.4"],
  [0.14999999999999997, "0.2"],
  [1.4499999999999997, "1.4"],
  [12.345000000000001, "12.3"],
  [3.0000000000000004, "3.0"],
  [4.9999999999999991, "5.0"],
  [0.14999999999999991, "0.2"],
];

describe("formatScore", () => {
  for (const [x, text] of RUBY_FIXED) {
    test(`${x} -> ${text}`, () => {
      expect(formatScore(x)).toBe(text);
    });
  }

  const ruby = Bun.which("ruby");
  test.skipIf(!ruby)("matches ruby sprintf on random and near-tie values", () => {
    const script = `
      srand(1)
      vals = []
      (0..4000).each { |k| x = (2*k+1)/20.0; y = x; z = x; 8.times { vals << y << z; y = y.next_float; z = z.prev_float } }
      20000.times { vals << rand * 40 }
      5000.times { h = rand * 50000; vals << 2 + 3.0/Math.sqrt(h+1) << 3.0/Math.sqrt(h+1) }
      vals.each { |v| puts "%.17g %s" % [v, sprintf("%.1f", v)] }`;
    const out = Bun.spawnSync([ruby!, "-e", script]).stdout.toString().trim().split("\n");
    expect(out.length).toBeGreaterThan(50000);
    const bad = out.filter((line) => {
      const [v, expected] = line.split(" ");
      return formatScore(Number.parseFloat(v!)) !== expected;
    });
    expect(bad).toEqual([]);
  });
});
