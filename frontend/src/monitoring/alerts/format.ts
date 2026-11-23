// Alerts in words: states, where a rule runs, durations, the one-line sentence of a condition and
// the dry run's answer. Pure; imports types only (the chart chunk's unit table stays out, so the
// unit words are kept here).

import type { Unit } from "../dashboards/schema";
import type { DryRunOut, Engine, PeriodOut, TargetOut, TargetState, ToolKind } from "./api";
import type { PanelAlert } from "../dashboards/schema";
import { parseDuration } from "./limits";

export const STATE_LABEL: Record<TargetState, string> = {
  ok: "OK",
  pending: "Pending",
  firing: "Firing",
  no_data: "No data",
  unreachable: "Can't check",
  error: "Query error",
  paused: "Paused",
  waiting: "Loading",
  not_applied: "Not applied",
};

export type Tone = "ok" | "warn" | "bad" | "muted";

const TONE: Record<TargetState, Tone> = {
  ok: "ok",
  pending: "warn",
  firing: "bad",
  no_data: "muted",
  unreachable: "warn",
  // A query that fails isn't an alert firing: warn, never Firing's rose.
  error: "warn",
  paused: "muted",
  waiting: "muted",
  not_applied: "warn",
};

export const stateTone = (state: TargetState): Tone => TONE[state];

const WHERE: Record<ToolKind, string> = { prometheus_rule: "in Prometheus", loki_ruler: "in Loki" };

/** Where a target runs, in words: "checked by OmniKrux", "in Prometheus" or "in Loki". */
export function whereLabel(t: Pick<TargetOut, "engine" | "tool"> | { engine: Engine; tool: ToolKind | null }): string {
  return t.engine === "tool" && t.tool !== null ? WHERE[t.tool] : "checked by OmniKrux";
}

/** `45 s`, `12 min`, `3 h 5 min`, `2 d`: the two largest units that aren't zero. */
export function durationWords(seconds: number): string {
  let rest = Math.max(0, Math.round(seconds));
  const parts: string[] = [];
  for (const [size, word] of [[86400, "d"], [3600, "h"], [60, "min"], [1, "s"]] as const) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 && parts.length < 2) parts.push(`${n} ${word}`);
  }
  return parts.length ? parts.join(" ") : "0 s";
}

/** `45s`, `12m`, `3h`, `2d`: the largest whole unit, for a list. */
export function sinceShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

// Written after the number; no word for a plain count or a fraction written as one.
const SUFFIX: Record<Unit, string> = {
  none: "",
  short: "",
  percent: "%",
  percentunit: "",
  s: " s",
  ms: " ms",
  bytes: " B",
  Bps: " B/s",
  reqps: " req/s",
  cores: " cores",
};

/** What is written after a threshold in `unit`: ` s`, `%`, ` req/s`; "" for a plain count. */
export const unitSuffix = (unit: Unit): string => SUFFIX[unit];

/** `Alert when any route is above 0.3 s for 5 min`; `the total` when it adds the series up; no
 * wait (`for` 0s) reads `right away`. */
export function sentence(
  alert: Pick<PanelAlert, "of" | "op" | "threshold" | "for">,
  opts: { seriesWord: string; unit: Unit },
): string {
  const subject = alert.of === "total" ? "the total" : `any ${opts.seriesWord}`;
  const seconds = parseDuration(alert.for) ?? 0;
  const wait = seconds === 0 ? "right away" : `for ${durationWords(seconds)}`;
  return `Alert when ${subject} is ${alert.op} ${alert.threshold}${SUFFIX[opts.unit]} ${wait}`;
}

const LEGEND_LABEL = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/;

/** The first `{{label}}` of a legend, else `series`. */
export function seriesWord(legend: string): string {
  return LEGEND_LABEL.exec(legend)?.[1] ?? "series";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` today, `yesterday HH:MM`, else `D Mon HH:MM`, in local time. Seconds since the epoch. */
function whenWords(at: number, now: number): string {
  const d = new Date(at * 1000);
  const today = new Date(now * 1000);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const dayOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayOf(today) - dayOf(d)) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`;
}

function periodWords(p: PeriodOut): string {
  return p.ongoing ? "still going" : durationWords(p.end - p.start);
}

/** What the dry run found, in a sentence. `now` is seconds since the epoch, like `out.start`. */
export function dryRunSentence(out: DryRunOut, now: number, windowLabel = "6 hours"): string {
  const lead = `Over the last ${windowLabel} this would`;
  const firingNow = out.firing_now ? " It is firing now." : "";
  if (out.fired === 0 || out.periods.length === 0) return `${lead} not have fired.${firingNow}`;
  const last = out.periods.reduce((a, b) => (b.start > a.start ? b : a));
  const detail = `${whenWords(last.start, now)}, ${periodWords(last)}`;
  if (out.fired === 1) return `${lead} have fired once (${detail}).${firingNow}`;
  return `${lead} have fired ${out.fired} times (last ${detail}).${firingNow}`;
}
