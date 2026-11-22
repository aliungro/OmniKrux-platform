// Reading PromQL (and a little LogQL): where the metric selectors are, which are raw counters,
// which ranges are literal windows. One tokenizer feeds every function here; a query that does not
// balance (quotes or brackets) reads as null and is never edited.
export const UNREADABLE = "The query has an unclosed quote or bracket.";

export type SelectorRef = {
  metric: string | null;
  start: number;
  /** Just after the name, or after its `}`. */
  end: number;
  /** A `[` follows. */
  rangeAfter: boolean;
  /** `offset` or `@` follows. */
  modifierAfter: boolean;
};

const IDENT_START = /[A-Za-z_:]/;
const IDENT_PART = /[A-Za-z0-9_:]/;
const SPACE = /\s/;
const LABEL_LIST_WORDS = new Set(["by", "without", "on", "ignoring", "group_left", "group_right"]);
const KEYWORDS = new Set([...LABEL_LIST_WORDS, "and", "or", "unless", "offset", "bool", "atan2", "inf", "nan"]);
const CLOSER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

type Frame = { ch: string; ref: SelectorRef | null; labels: boolean };

function skipSpace(s: string, i: number): number {
  while (i < s.length && SPACE.test(s[i])) i++;
  return i;
}

/** The index after a string that opens at `i`, or -1 when it never closes. */
function stringEnd(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (q !== "`" && s[j] === "\\") j++;
    else if (s[j] === q) return j + 1;
  }
  return -1;
}

export function scanSelectors(expr: string): SelectorRef[] | null {
  const refs: SelectorRef[] = [];
  const stack: Frame[] = [];
  const quiet = () => stack.some((f) => f.ch !== "(" || f.labels);
  let lastIdent: SelectorRef | null = null; // a name that a `{` right after it would extend
  let labelsNext = false; // the next `(` opens a label list
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (SPACE.test(c)) { i++; continue; }
    if (c === "#") {
      const nl = expr.indexOf("\n", i);
      i = nl < 0 ? expr.length : nl + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const e = stringEnd(expr, i);
      if (e < 0) return null;
      i = e; lastIdent = null; labelsNext = false;
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      if (expr[j] === "{") {
        const close = expr.indexOf("}", j);
        if (close < 0) return null;
        j = close + 1;
      } else while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
      i = j; lastIdent = null; labelsNext = false;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_.]/.test(expr[j])) j++;
      i = j; lastIdent = null; labelsNext = false;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < expr.length && IDENT_PART.test(expr[j])) j++;
      const name = expr.slice(i, j);
      const lower = name.toLowerCase();
      const nextAt = skipSpace(expr, j);
      lastIdent = null;
      labelsNext = false;
      if (KEYWORDS.has(lower)) {
        labelsNext = LABEL_LIST_WORDS.has(lower);
      } else if (!quiet()) {
        const following = /^(by|without)\b/.exec(expr.slice(nextAt, nextAt + 8));
        if (expr[nextAt] !== "(" && !following) {
          const ref: SelectorRef = { metric: name, start: i, end: j, rangeAfter: false, modifierAfter: false };
          refs.push(ref);
          lastIdent = ref;
        }
      }
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      let ref: SelectorRef | null = null;
      if (c === "{" && !quiet()) {
        ref = lastIdent ?? { metric: null, start: i, end: i, rangeAfter: false, modifierAfter: false };
        if (!lastIdent) refs.push(ref);
      }
      stack.push({ ch: c, ref, labels: c === "(" && labelsNext });
      lastIdent = null; labelsNext = false; i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top || top.ch !== CLOSER[c]) return null;
      if (top.ref) top.ref.end = i + 1;
      lastIdent = null; labelsNext = false; i++;
      continue;
    }
    lastIdent = null; labelsNext = false; i++;
  }
  if (stack.length > 0) return null;
  for (const r of refs) {
    const at = skipSpace(expr, r.end);
    r.rangeAfter = expr[at] === "[";
    r.modifierAfter = expr[at] === "@" || /^offset\b/i.test(expr.slice(at, at + 7));
  }
  return refs;
}

/** PromQL and LogQL: strings and the three bracket kinds balance. */
export function quickCheck(expr: string): string | null {
  return scanSelectors(expr) === null ? UNREADABLE : null;
}

export function findRawCounters(expr: string, isCounter: (name: string) => boolean): SelectorRef[] {
  return (scanSelectors(expr) ?? []).filter(
    (r) => r.metric !== null && isCounter(r.metric) && !r.rangeAfter && !r.modifierAfter,
  );
}

/** Wraps each ref in `rate(…[$__rate_interval])`, from the last to the first; nothing else changes. */
export function wrapRate(expr: string, refs: SelectorRef[]): string {
  let out = expr;
  for (const r of [...refs].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, r.start)}rate(${out.slice(r.start, r.end)}[$__rate_interval])${out.slice(r.end)}`;
  }
  return out;
}

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };

function durationSeconds(text: string): number | null {
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(text)) return null;
  let total = 0;
  for (const m of text.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) total += Number(m[1]) * UNIT_SECONDS[m[2]];
  return total;
}

/** The literal window inside each `[…]` that follows a selector (no subqueries, no variables). */
export function rangeDurations(expr: string): { start: number; end: number; seconds: number }[] {
  const out: { start: number; end: number; seconds: number }[] = [];
  for (const r of scanSelectors(expr) ?? []) {
    if (!r.rangeAfter) continue;
    const open = skipSpace(expr, r.end);
    const close = expr.indexOf("]", open);
    if (close < 0) continue;
    const inner = expr.slice(open + 1, close);
    if (inner.includes(":") || inner.includes("$")) continue;
    const lead = inner.length - inner.trimStart().length;
    const text = inner.trim();
    const seconds = durationSeconds(text);
    if (seconds === null) continue;
    out.push({ start: open + 1 + lead, end: open + 1 + lead + text.length, seconds });
  }
  return out;
}

export function replaceDurations(expr: string, spans: { start: number; end: number }[], text: string): string {
  let out = expr;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + text + out.slice(s.end);
  return out;
}

/** The index after the `)` that closes the `(` at `open`, or -1. */
function parenEnd(expr: string, open: number): number {
  let depth = 0;
  for (let i = open; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === "`") {
      const e = stringEnd(expr, i);
      if (e < 0) return -1;
      i = e - 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

const RATE_FUNCTIONS = new Set(["rate", "irate", "increase"]);

function wordAt(expr: string, i: number): { word: string; end: number } {
  let j = i;
  while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
  return { word: expr.slice(i, j), end: j };
}

/** The outermost call, after an optional `sum` / `sum by (…)` / `sum without (…)`, is rate, irate or increase. */
export function isRateQuery(expr: string): boolean {
  if (scanSelectors(expr) === null) return false;
  const text = expr.trim();
  let at = 0;
  let wrapEnd = -1;
  let first = wordAt(text, at);
  if (first.word === "sum") {
    at = skipSpace(text, first.end);
    const clause = wordAt(text, at);
    if (clause.word === "by" || clause.word === "without") {
      at = skipSpace(text, clause.end);
      if (text[at] !== "(") return false;
      const e = parenEnd(text, at);
      if (e < 0) return false;
      at = skipSpace(text, e);
    }
    if (text[at] !== "(") return false;
    wrapEnd = parenEnd(text, at);
    if (wrapEnd < 0) return false;
    at = skipSpace(text, at + 1);
    first = wordAt(text, at);
  }
  if (!RATE_FUNCTIONS.has(first.word)) return false;
  const open = skipSpace(text, first.end);
  if (text[open] !== "(") return false;
  const callEnd = parenEnd(text, open);
  if (callEnd < 0) return false;
  if (wrapEnd < 0) return text.slice(callEnd).trim() === "";
  return skipSpace(text, callEnd) === wrapEnd - 1 && text.slice(wrapEnd).trim() === "";
}

export function firstMetric(expr: string): string | null {
  return (scanSelectors(expr) ?? []).find((r) => r.metric !== null)?.metric ?? null;
}

/** LogQL metric queries start with a function (optionally `sum by (…)`), log queries with `{`. */
export function isLogQlMetric(expr: string): boolean {
  return /^\s*[A-Za-z_]\w*\s*(?:(?:by|without)\s*\([^)]*\)\s*)?\(/.test(expr);
}

/** The first `{…}` outside strings and comments, braces included. */
export function logSelector(expr: string): string | null {
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "#") {
      const nl = expr.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl;
    } else if (c === '"' || c === "'" || c === "`") {
      const e = stringEnd(expr, i);
      if (e < 0) return null;
      i = e - 1;
    } else if (c === "{") {
      for (let j = i + 1; j < expr.length; j++) {
        const d = expr[j];
        if (d === '"' || d === "'" || d === "`") {
          const e = stringEnd(expr, j);
          if (e < 0) return null;
          j = e - 1;
        } else if (d === "}") return expr.slice(i, j + 1);
      }
      return null;
    }
  }
  return null;
}
