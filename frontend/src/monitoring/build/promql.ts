// Reading PromQL (and a little LogQL): where the metric selectors are, which are raw counters,
// which ranges are literal windows. One tokenizer feeds every function here (comments are dropped
// once, for all of them); a query that does not balance (quotes or brackets) reads as null and is
// never edited.
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

/**
 * One token: an identifier, a word that touches a `$...` variable (kind `var`, never a metric), a
 * number or duration, a string, or a single punctuation character. Comments are dropped.
 */
type Tok = { k: "id" | "var" | "num" | "str" | "p"; s: string; a: number; b: number };
type Frame = { ch: string; ref: SelectorRef | null; labels: boolean };

/** The index after a string that opens at `i`, or -1 when it never closes. */
function stringEnd(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (q !== "`" && s[j] === "\\") j++;
    else if (s[j] === q) return j + 1;
  }
  return -1;
}

/** The shared tokenizer: null when a string or a `${` never closes. */
function tokenize(expr: string): Tok[] | null {
  const out: Tok[] = [];
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
      out.push({ k: "str", s: expr.slice(i, e), a: i, b: e });
      i = e;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_.]/.test(expr[j])) j++;
      out.push({ k: "num", s: expr.slice(i, j), a: i, b: j });
      i = j;
    } else if (IDENT_START.test(c) || c === "$") {
      // A name that touches a `$...` token (before or after it) is one `var` token, never a metric.
      let j = i;
      let dollar = false;
      for (;;) {
        if (j < expr.length && IDENT_PART.test(expr[j])) j++;
        else if (expr[j] === "$") {
          dollar = true;
          j++;
          if (expr[j] === "{") {
            const close = expr.indexOf("}", j);
            if (close < 0) return null;
            j = close + 1;
          }
        } else break;
      }
      out.push({ k: dollar ? "var" : "id", s: expr.slice(i, j), a: i, b: j });
      i = j;
    } else {
      out.push({ k: "p", s: c, a: i, b: i + 1 });
      i++;
    }
  }
  return out;
}

const isP = (t: Tok | undefined, s: string) => t?.k === "p" && t.s === s;
const isClauseWord = (t: Tok | undefined) => t?.k === "id" && /^(by|without)$/i.test(t.s);

/** The index of the `)` that closes the `(` at `i`, or -1. */
function groupEnd(toks: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (isP(toks[j], "(")) depth++;
    else if (isP(toks[j], ")") && --depth === 0) return j;
  }
  return -1;
}

/** After an optional `by (...)` / `without (...)` at `i`: the index past it; -1 when malformed. */
function skipClause(toks: Tok[], i: number): number {
  if (!isClauseWord(toks[i])) return i;
  if (!isP(toks[i + 1], "(")) return -1;
  const e = groupEnd(toks, i + 1);
  return e < 0 ? -1 : e + 1;
}

function read(expr: string): { toks: Tok[]; refs: SelectorRef[] } | null {
  const toks = tokenize(expr);
  if (toks === null) return null;
  const refs: SelectorRef[] = [];
  const endIdx = new Map<SelectorRef, number>();
  const stack: Frame[] = [];
  const quiet = () => stack.some((f) => f.ch !== "(" || f.labels);
  let prev: SelectorRef | null = null; // the previous token's selector, which a `{` right after extends
  let labelsNext = false; // the next `(` opens a label list
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    const before = prev;
    const labelsHere = labelsNext;
    prev = null;
    labelsNext = false;
    if (t.k === "id") {
      const lower = t.s.toLowerCase();
      if (KEYWORDS.has(lower)) {
        labelsNext = LABEL_LIST_WORDS.has(lower);
      } else if (!quiet()) {
        const next = toks[ti + 1];
        if (!isP(next, "(") && !isClauseWord(next)) {
          const ref: SelectorRef = { metric: t.s, start: t.a, end: t.b, rangeAfter: false, modifierAfter: false };
          refs.push(ref);
          endIdx.set(ref, ti);
          prev = ref;
        }
      }
    } else if (t.k === "p" && (t.s === "(" || t.s === "[" || t.s === "{")) {
      let ref: SelectorRef | null = null;
      if (t.s === "{" && !quiet()) {
        ref = before ?? { metric: null, start: t.a, end: t.a, rangeAfter: false, modifierAfter: false };
        if (!before) refs.push(ref);
      }
      stack.push({ ch: t.s, ref, labels: t.s === "(" && labelsHere });
    } else if (t.k === "p" && CLOSER[t.s] !== undefined) {
      const top = stack.pop();
      if (!top || top.ch !== CLOSER[t.s]) return null;
      if (top.ref) { top.ref.end = t.b; endIdx.set(top.ref, ti); }
    }
  }
  if (stack.length > 0) return null;
  for (const r of refs) {
    const next = toks[(endIdx.get(r) ?? 0) + 1];
    r.rangeAfter = isP(next, "[");
    r.modifierAfter = isP(next, "@") || (next?.k === "id" && next.s.toLowerCase() === "offset");
  }
  return { toks, refs };
}

export function scanSelectors(expr: string): SelectorRef[] | null {
  return read(expr)?.refs ?? null;
}

/** PromQL and LogQL: strings and the three bracket kinds balance. */
export function quickCheck(expr: string): string | null {
  return read(expr) === null ? UNREADABLE : null;
}

export function findRawCounters(expr: string, isCounter: (name: string) => boolean): SelectorRef[] {
  return (scanSelectors(expr) ?? []).filter(
    (r) => r.metric !== null && isCounter(r.metric) && !r.rangeAfter && !r.modifierAfter,
  );
}

/** Wraps each ref in `rate(...[$__rate_interval])`, from the last to the first; nothing else changes. */
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

/** The literal window inside each `[...]` that follows a selector (no subqueries, no variables). */
export function rangeDurations(expr: string): { start: number; end: number; seconds: number }[] {
  const out: { start: number; end: number; seconds: number }[] = [];
  const r = read(expr);
  if (!r) return out;
  for (const ref of r.refs) {
    if (!ref.rangeAfter) continue;
    const open = r.toks.find((t) => t.a >= ref.end && isP(t, "["));
    const close = open && r.toks.find((t) => t.a > open.a && isP(t, "]"));
    if (!open || !close) continue;
    const inner = expr.slice(open.b, close.a);
    if (inner.includes(":") || inner.includes("$")) continue;
    const lead = inner.length - inner.trimStart().length;
    const text = inner.trim();
    const seconds = durationSeconds(text);
    if (seconds === null) continue;
    out.push({ start: open.b + lead, end: open.b + lead + text.length, seconds });
  }
  return out;
}

export function replaceDurations(expr: string, spans: { start: number; end: number }[], text: string): string {
  let out = expr;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + text + out.slice(s.end);
  return out;
}

const RATE_FUNCTIONS = new Set(["rate", "irate", "increase"]);

/**
 * The outermost call, after an optional `sum` (with `by (...)` / `without (...)` before or after
 * its arguments), is rate, irate or increase.
 */
export function isRateQuery(expr: string): boolean {
  const r = read(expr);
  if (!r) return false;
  const t = r.toks;
  let i = 0;
  let wrapClose = -1;
  if (t[0]?.k === "id" && t[0].s === "sum") {
    i = skipClause(t, 1);
    if (i < 0 || !isP(t[i], "(")) return false;
    wrapClose = groupEnd(t, i);
    if (wrapClose < 0) return false;
    i++;
  }
  if (!(t[i]?.k === "id" && RATE_FUNCTIONS.has(t[i].s) && isP(t[i + 1], "("))) return false;
  const close = groupEnd(t, i + 1);
  if (close < 0) return false;
  if (wrapClose < 0) return close + 1 === t.length;
  return close + 1 === wrapClose && skipClause(t, wrapClose + 1) === t.length;
}

export function firstMetric(expr: string): string | null {
  return (scanSelectors(expr) ?? []).find((r) => r.metric !== null)?.metric ?? null;
}

/** LogQL metric queries start with a function (optionally `sum by (...)`), log queries with `{`. */
export function isLogQlMetric(expr: string): boolean {
  const t = tokenize(expr);
  if (!t || t[0]?.k !== "id") return false;
  const i = skipClause(t, 1);
  return i >= 0 && isP(t[i], "(");
}

/** The first `{...}` outside strings and comments, braces included. */
export function logSelector(expr: string): string | null {
  const t = tokenize(expr);
  const open = t ? t.findIndex((x) => isP(x, "{")) : -1;
  if (!t || open < 0) return null;
  for (let j = open + 1; j < t.length; j++) if (isP(t[j], "}")) return expr.slice(t[open].a, t[j].b);
  return null;
}
