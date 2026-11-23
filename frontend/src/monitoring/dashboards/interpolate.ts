// Variable substitution into query text. Values come from label values and the URL, so they
// are untrusted: each value is escaped for the quote it lands in (found by one left-to-right
// scan of the query) or refused. Never relies on the server's project filter.

import { durationText } from "./time";

export type VarValue = string[] | "all";
export type ResolvedVars = Record<string, { multi: boolean; value: VarValue }>;

export const ALL_PATTERN = ".+";

/**
 * The shortest `$__rate_interval`, in seconds. Grafana's value is four scrape intervals;
 * Prometheus scrapes every minute by default, so four minutes holds four samples there and
 * survives one missed scrape. A shorter window can hold a single sample, and rate() is empty.
 */
export const RATE_INTERVAL_FLOOR = 240;

/** A value that cannot be placed safely where its variable sits. */
export class VariableError extends Error {
  readonly name: string;
  constructor(
    name: string,
    message = `The value of $${name} can't be used here. Put $${name} inside double quotes in the query.`,
  ) {
    super(message);
    this.name = name;
  }
}

/**
 * Said for a query with a lone carriage return (`\r` not followed by `\n`) outside quotes. PromQL
 * ends a `#` comment there while this scan ends it only at `\n`, so the two could disagree on
 * which quote a value lands in: the value isn't placed.
 */
export const loneReturnWords = (name: string) =>
  `The query has a carriage return outside quotes, so $${name} can't be placed safely. Remove it, or start a new line instead.`;

/** A carriage return not followed by a line feed. */
const LONE_RETURN = /\r(?!\n)/;

export function escapeQueryString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function escapeSingleQuoted(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function escapeRegex(v: string): string {
  return v.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
}

// Sticky, so it matches only at the scan position.
const TOKEN = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/y;
const BARE_SAFE = /^[A-Za-z0-9_:.]*$/;

type Quote = '"' | "'" | "`" | null;

function render(name: string, vars: ResolvedVars, quote: Quote): string | null {
  if (!Object.hasOwn(vars, name)) return null;
  const v = vars[name];
  let text: string;
  let regex = false;
  if (v.value === "all") {
    text = ALL_PATTERN;
    regex = true;
  } else if (v.multi) {
    regex = true;
    text = v.value.length === 0 ? ALL_PATTERN : v.value.map(escapeRegex).join("|");
  } else {
    text = v.value[0] ?? "";
  }
  if (quote === '"') return escapeQueryString(text);
  if (quote === "'") return escapeSingleQuoted(text);
  if (quote === "`") {
    if (text.includes("`")) throw new VariableError(name);
    return text;
  }
  if (regex || !BARE_SAFE.test(text)) throw new VariableError(name);
  return text;
}

export function interpolate(
  text: string,
  vars: ResolvedVars,
  builtins: { stepSeconds: number; rangeSeconds: number },
): string {
  // One pass over the original text: substituted values are never scanned again.
  let out = "";
  let quote: Quote = null;
  let i = 0;
  /** A lone `\r` outside quotes (code or comment), and the first variable placed. */
  let loneReturn = false;
  let placed: string | null = null;
  while (i < text.length) {
    const c = text[i];
    if (quote === null && c === "#") {
      // A line comment: copy to the end of the line untouched, no variables, no quote tracking.
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl;
      const comment = text.slice(i, end);
      // With the line feed that ends it: a Windows line break isn't a lone \r.
      if (LONE_RETURN.test(text.slice(i, end + 1))) loneReturn = true;
      out += comment;
      i = end;
      continue;
    }
    if (quote === null && c === "\r" && text[i + 1] !== "\n") loneReturn = true;
    if (c === "$") {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(text);
      if (m) {
        const name = (m[1] ?? m[2]) as string;
        let rendered: string | null;
        if (name === "__interval") rendered = durationText(builtins.stepSeconds);
        else if (name === "__rate_interval") {
          rendered = durationText(Math.max(4 * builtins.stepSeconds, RATE_INTERVAL_FLOOR));
        } else if (name === "__range") rendered = durationText(builtins.rangeSeconds);
        else {
          rendered = render(name, vars, quote);
          if (rendered !== null) placed ??= name;
        }
        out += rendered ?? m[0];
        i += m[0].length;
        continue;
      }
    }
    if (quote === '"' || quote === "'") {
      if (c === "\\" && i + 1 < text.length) {
        out += c + text[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (quote === "`") {
      if (c === "`") quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
    out += c;
    i++;
  }
  // The text itself is never changed; with nothing placed there is nothing to misplace.
  if (loneReturn && placed !== null) throw new VariableError(placed, loneReturnWords(placed));
  return out;
}
