// Variable substitution into query text. Values come from label values and the URL, so they
// are untrusted: a value is always escaped for the quoted query string it lands in, and a
// multi value is regex-escaped first. Never relies on the server's project filter.

import { durationText } from "./time";

export type VarValue = string[] | "all";
export type ResolvedVars = Record<string, { multi: boolean; value: VarValue }>;

export const ALL_PATTERN = ".+";

export function escapeQueryString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function escapeRegex(v: string): string {
  return v.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
}

const TOKEN = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export function interpolate(
  text: string,
  vars: ResolvedVars,
  builtins: { stepSeconds: number; rangeSeconds: number },
): string {
  // One pass over the original text: substituted values are never scanned again.
  return text.replace(TOKEN, (whole, braced: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare) as string;
    switch (name) {
      case "__interval":
        return durationText(builtins.stepSeconds);
      case "__rate_interval":
        return durationText(Math.max(4 * builtins.stepSeconds, 60));
      case "__range":
        return durationText(builtins.rangeSeconds);
    }
    if (!Object.hasOwn(vars, name)) return whole;
    const v = vars[name];
    if (v.value === "all") return ALL_PATTERN;
    if (v.multi) {
      if (v.value.length === 0) return ALL_PATTERN;
      return escapeQueryString(v.value.map(escapeRegex).join("|"));
    }
    return escapeQueryString(v.value[0] ?? "");
  });
}
