// What an alert on a panel is allowed to be, and how its query text is made: the one place the
// document walker (dashboards/schema.ts) and `ruleExpr.ts` both read, mirrored from the server's
// alerts/types.py and alerts/rule_expr.py. Imports `interpolate` and types only, so it stays out
// of the startup bundle with the rest of the dashboard code.

import { VariableError, interpolate, type ResolvedVars } from "../dashboards/interpolate";
import type { PanelType } from "../dashboards/schema";

export const ALERT_PANEL_TYPES: readonly PanelType[] = ["timeseries", "stat", "gauge", "bar"];
export const SEVERITIES = ["critical", "warning", "info"] as const;
export const EVERY_SECONDS: Record<string, number> = { "30s": 30, "1m": 60, "5m": 300 };
export const MAX_FOR_SECONDS = 86400;
export const MAX_NOTIFY = 10;
export const MAX_CHANNEL_LABELS = 10;
export const CONTACT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const DURATION = /^(0|[1-9][0-9]*)(s|m|h)$/;
const DURATION_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600 };

/** A duration like `5m` in seconds, or null when it isn't one (the server's `parse_duration`). */
export function parseDuration(text: string): number | null {
  const m = DURATION.exec(text);
  return m === null ? null : Number(m[1]) * DURATION_UNIT[m[2]];
}

// Python's str.strip(): every character str.isspace() accepts.
const PY_SPACE = String.fromCharCode(
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0x85, 0xa0,
);
const LOG_QUERY = new RegExp(String.raw`^[\t\n\v\f\r\x1c-\x20${PY_SPACE}]*\{`);

/** A log selector (starts with `{`) rather than a metric query. */
export const isLogQuery = (expr: string): boolean => LOG_QUERY.test(expr);

export const RANGE_COPY = "An alert can't use $__range; write the window into the query, like [5m].";
export const LOG_QUERY_COPY =
  'A Loki alert needs a metric query, like sum(count_over_time({app="api"} |= "error" [5m])).';
export const noDefaultCopy = (name: string) =>
  `Uses $${name}, which has no default value. Alerts use each variable's default, so give it one.`;

class Refused extends Error {}

/**
 * The query text an alert runs: the dashboard's own `interpolate` with each variable's default
 * and the built-ins from the alert's interval. Returns `{ text }`, or `{ problem }` in the
 * server's words: `$__range` and a single-value variable without a default stop the scan where
 * they are read, so the first refusal is the same one the server gives.
 */
export function defaultsExpr(
  expr: string,
  variables: readonly unknown[],
  everySeconds: number,
): { text: string } | { problem: string } {
  const vars: ResolvedVars = Object.create(null);
  for (const v of variables) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    const { name, multi: multiRaw, default: def } = v as Record<string, unknown>;
    if (typeof name !== "string" || Object.hasOwn(vars, name)) continue;
    const multi = multiRaw === true;
    const value = def === "all" ? "all" : Array.isArray(def) ? def.filter((d): d is string => typeof d === "string") : [];
    if (!multi && value !== "all" && value.length === 0) {
      Object.defineProperty(vars, name, {
        enumerable: true,
        get() {
          throw new Refused(noDefaultCopy(name));
        },
      });
    } else {
      Object.defineProperty(vars, name, { enumerable: true, value: { multi, value } });
    }
  }
  const builtins = {
    stepSeconds: everySeconds,
    get rangeSeconds(): number {
      throw new Refused(RANGE_COPY);
    },
  };
  try {
    return { text: interpolate(expr, vars, builtins) };
  } catch (err) {
    if (err instanceof Refused || err instanceof VariableError) return { problem: err.message };
    throw err;
  }
}
