// Variable substitution into query text. Values come from label values and the URL, so they
// are untrusted: each value is escaped for the quote it lands in (found by one left-to-right
// scan of the query) or refused. Never relies on the server's project filter.

import { durationText } from "./time";

export type VarValue = string[] | "all";
export type ResolvedVars = Record<string, { multi: boolean; value: VarValue }>;

export const ALL_PATTERN = ".+";

/** A value that cannot be placed safely where its variable sits. */
export class VariableError extends Error {
  readonly name: string;
  constructor(name: string) {
    super(
      `The value of $${name} can't be used here. Put $${name} inside double quotes in the query.`,
    );
    this.name = name;
  }
}

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
const BARE_SAFE = /^[A-Za-z0-9_:.-]*$/;

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
  while (i < text.length) {
    const c = text[i];
    if (c === "$") {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(text);
      if (m) {
        const name = (m[1] ?? m[2]) as string;
        let rendered: string | null;
        if (name === "__interval") rendered = durationText(builtins.stepSeconds);
        else if (name === "__rate_interval") {
          rendered = durationText(Math.max(4 * builtins.stepSeconds, 60));
        } else if (name === "__range") rendered = durationText(builtins.rangeSeconds);
        else rendered = render(name, vars, quote);
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
  return out;
}
