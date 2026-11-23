// The query text a panel's alert runs, and the message it shows: the browser's twin of the
// server's alerts/rule_expr.py. Both run the shared case files (`alert_expr_cases.json`,
// `alert_message_cases.json`), so the text, the refusals and the words are identical.
//
// Only alert and dashboard code imports this module; it must stay out of the startup bundle.

import type { DashboardSpec, PanelSpec } from "../dashboards/schema";
import { EVERY_SECONDS, defaultsExpr, isLogQuery, parseDuration } from "./limits";

export { isLogQuery, parseDuration };

export type RuleExprResult = { ok: true; expr: string } | { ok: false; problem: string };

export const NO_ALERT_COPY = "This panel has no alert.";
export const NO_QUERY_COPY = "Use the ref of one of this panel's queries, like A.";

/** The panel alert's query text, ready to run at the alert's interval. */
export function ruleExpr(spec: DashboardSpec, panel: PanelSpec): RuleExprResult {
  const alert = panel.alert;
  if (alert === null) return { ok: false, problem: NO_ALERT_COPY };
  const query = panel.queries.find((q) => q.ref === alert.query);
  if (query === undefined) return { ok: false, problem: NO_QUERY_COPY };
  const every = Object.hasOwn(EVERY_SECONDS, alert.every) ? EVERY_SECONDS[alert.every] : 60;
  const out = defaultsExpr(query.expr, spec.variables, every);
  return "problem" in out ? { ok: false, problem: out.problem } : { ok: true, expr: out.text };
}

// --- the message ----------------------------------------------------------------------------

const TEMPLATE = /\{\{(value|[A-Za-z_][A-Za-z0-9_]*)\}\}/y;

type Part = { kind: "name"; name: string } | { kind: "text"; text: string };

/**
 * The message left to right: a placeholder, else its text. A `{{` or `}}` that isn't part of a
 * placeholder is its own text part, so `{{{value}}}` reads the same here and on the server.
 */
function parts(message: string): Part[] {
  const out: Part[] = [];
  let i = 0;
  while (i < message.length) {
    TEMPLATE.lastIndex = i;
    const m = TEMPLATE.exec(message);
    if (m) {
      out.push({ kind: "name", name: m[1] });
      i += m[0].length;
    } else if (message.startsWith("{{", i) || message.startsWith("}}", i)) {
      out.push({ kind: "text", text: message.slice(i, i + 2) });
      i += 2;
    } else {
      out.push({ kind: "text", text: message[i] });
      i += 1;
    }
  }
  return out;
}

/**
 * `value` with three significant digits, written out in full (never an exponent), the way the
 * server writes it: ties round to the even digit (Python's `.3g`), trailing zeros are dropped.
 */
export function threeDigits(value: number): string {
  const negative = value < 0 || Object.is(value, -0);
  // 100 fraction digits are exact for a tie, so a tie is told from a number just above one.
  const [mantissa, exponentText] = Math.abs(value).toExponential(100).split("e");
  const all = mantissa.replace(".", "");
  let exponent = Number(exponentText);
  let digits = all.slice(0, 3);
  const rest = all.slice(3);
  const tie = rest[0] === "5" && /^0*$/.test(rest.slice(1));
  const up = rest[0] > "5" || (rest[0] === "5" && !tie) || (tie && Number(digits[2]) % 2 === 1);
  if (up) {
    digits = String(Number(digits) + 1);
    if (digits.length > 3) {
      digits = digits.slice(0, 3);
      exponent += 1;
    }
  }
  digits = digits.replace(/0+$/, "");
  let text: string;
  if (digits === "") text = "0";
  else if (exponent < 0) text = `0.${"0".repeat(-exponent - 1)}${digits}`;
  else if (digits.length <= exponent + 1) text = digits + "0".repeat(exponent + 1 - digits.length);
  else text = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  return negative ? `-${text}` : text;
}

/** The message with `{{label}}` and `{{value}}` placed, as the notification shows it. */
export function renderMessage(message: string, labels: Readonly<Record<string, string>>, value: number | null): string {
  return parts(message)
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (part.name === "value") return value === null || !Number.isFinite(value) ? "–" : threeDigits(value);
      return Object.hasOwn(labels, part.name) ? labels[part.name] : "";
    })
    .join("");
}
