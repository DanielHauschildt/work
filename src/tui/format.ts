// Scoring and formatting ported from try's TrySelector (calculate_score, format_relative_time, sprintf "%.1f").

const DATE_PREFIX = /^\d\d\d\d-\d\d-\d\d-/;

/** Ruby's `\s+` (ASCII whitespace only; JS `\s` also matches Unicode spaces). */
export const RUBY_WS = /[ \t\r\n\f\v]+/g;

export function dashify(s: string): string {
  return s.replace(RUBY_WS, "-");
}

/**
 * try's fuzzy score: date-prefix bonus, in-order char matches with word-boundary and proximity bonuses,
 * density and length penalties, recency bonus. Same operation order as the Ruby code so results are bit-identical.
 */
export function calculateScore(basename: string, query: string, recency: Date, now: Date = new Date()): number {
  const text = Array.from(basename);
  const textLower = Array.from(basename.toLowerCase());
  const queryChars = Array.from(query.toLowerCase());

  let score = 0.0;

  // generally we are looking for default date-prefixed directories
  if (DATE_PREFIX.test(basename)) score += 2.0;

  if (queryChars.length > 0) {
    const queryLen = queryChars.length;
    const textLen = textLower.length;

    let lastPos = -1;
    let queryIdx = 0;

    for (let i = 0; i < textLen; i++) {
      if (queryIdx >= queryLen) break;
      if (textLower[i] === queryChars[queryIdx]) {
        // Base point + word boundary bonus
        score += 1.0;
        const isBoundary = i === 0 || /\W/.test(textLower[i - 1]!);
        if (isBoundary) score += 1.0;

        // Proximity bonus: 2/sqrt(gap+1)
        if (lastPos >= 0) {
          const gap = i - lastPos - 1;
          score += 2.0 / Math.sqrt(gap + 1);
        }

        lastPos = i;
        queryIdx += 1;
      }
    }

    // Not all query chars matched
    if (queryIdx < queryLen) return 0.0;

    // Prefer shorter matches (density bonus)
    if (lastPos >= 0) score *= queryLen / (lastPos + 1);

    // Length penalty - shorter text scores higher for same match
    score *= 10.0 / (text.length + 10.0);
  }

  // Recency bonus (hours since last visit / mtime)
  const t = recency.getTime();
  if (!Number.isNaN(t)) {
    let hours = (now.getTime() - t) / 1000 / 3600.0;
    // Ruby raises Math::DomainError for sqrt of a negative; treat far-future timestamps as "now".
    if (hours + 1 <= 0) hours = 0;
    score += 3.0 / Math.sqrt(hours + 1);
  }

  return score;
}

export function formatRelativeTime(t: Date, now: Date = new Date()): string {
  const ms = t.getTime();
  if (Number.isNaN(ms)) return "?";

  const seconds = (now.getTime() - ms) / 1000;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${Math.trunc(minutes)}m ago`;
  if (hours < 24) return `${Math.trunc(hours)}h ago`;
  if (days < 7) return `${Math.trunc(days)}d ago`;
  return `${Math.trunc(days / 7)}w ago`;
}

const TENS = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];
const EPS_SCALE = 2 ** -52;

/**
 * Ruby's `sprintf("%.1f", x)`. Ruby's dtoa takes a floating-point fast path that rounds near-ties half-even
 * (0.15 -> "0.2", 0.45 -> "0.4"), unlike JS toFixed. This replays that fast path for 0 <= x < 1e13.
 */
export function formatScore(x: number): string {
  if (!Number.isFinite(x) || x < 0 || x >= 1e13) return x.toFixed(1);
  // ilim <= 0: dtoa compares exactly against 0.05; the double 0.05 lies just above the real 0.05.
  if (x < 0.1) return x >= 0.05 ? "0.1" : "0.0";

  let k = -1;
  if (x >= 1) {
    k = 0;
    while (x >= TENS[k + 1]!) k++;
  }
  const ndigits = k + 2;
  let ilim = ndigits;
  let d = k > 0 ? x / TENS[k]! : k < 0 ? x * TENS[-k]! : x;
  const eps = (2 * d + 7) * EPS_SCALE * TENS[ilim - 1]!;

  let n = 0;
  let i = 1;
  for (; ; i++, d *= 10) {
    const digit = Math.trunc(d);
    d -= digit;
    if (d === 0) ilim = i;
    n = n * 10 + digit;
    if (i === ilim) {
      if (d > 0.5 + eps) n += 1;
      else if (d < 0.5 - eps) {
        // round down
      } else if (digit % 2 === 1) n += 1;
      break;
    }
  }
  n *= 10 ** (ndigits - i);
  return `${Math.floor(n / 10)}.${n % 10}`;
}
