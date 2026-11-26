import { isCounter } from "../catalog/metrics";
import type { OwnerCatalog } from "../catalog/merge";
import type { PanelData } from "../dashboards/runPanel";
import type { PanelSpec, QuerySpec } from "../dashboards/schema";
import { durationText } from "../dashboards/time";
import { findRawCounters, isRateQuery, quickCheck, rangeDurations, replaceDurations, scanSelectors, wrapRate } from "./promql";

export type RecText = (string | { strong: string })[];

export type RecommendationContext = {
  panel: PanelSpec;
  data: PanelData | null;
  catalog: OwnerCatalog | null;
  /** 0 when the step is not known (the side panel may not have it); widerWindow then does not apply. */
  stepSeconds: number;
  /** Reserved for M4's dry run; M3 never sets it. */
  alert?: unknown;
  /** The last run ended as "the text doesn't read": nothing is suggested about it. */
  invalid?: boolean;
};

export type Recommendation = {
  id: string;
  key: string;
  text: RecText;
  /** The apply button's words when "Apply" says too little (an alert's "Use 0.41"). */
  applyLabel?: string;
  apply(panel: PanelSpec): PanelSpec;
};

export type RecommendationRule = {
  id: string;
  evaluate(ctx: RecommendationContext): Recommendation | null;
};

const keyOf = (id: string, panel: PanelSpec, ref: string | null) => `${id}:${panel.id}:${ref ?? "-"}`;

const visiblePrometheus = (panel: PanelSpec): QuerySpec[] =>
  panel.queries.filter((q) => !q.hidden && q.source.type === "prometheus");

/** Replaces one query's text, only if it still reads as it did when evaluated; nothing else changes. */
function withExpr(panel: PanelSpec, ref: string, seen: string, change: (expr: string) => string): PanelSpec {
  const q = panel.queries.find((x) => x.ref === ref);
  if (!q || q.expr !== seen) return panel;
  return { ...panel, queries: panel.queries.map((x) => (x.ref === ref ? { ...x, expr: change(x.expr) } : x)) } as PanelSpec;
}

const SMOOTHING = new Set(["rate", "irate", "avg_over_time"]);

/** Range windows directly inside rate, irate or avg_over_time: a wider one smooths without changing meaning. */
function smoothingWindows(expr: string) {
  const refs = scanSelectors(expr) ?? [];
  return rangeDurations(expr).filter((d) => {
    const ref = refs.filter((r) => r.end <= d.start).sort((a, b) => b.end - a.end)[0];
    if (!ref) return false;
    const m = /([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/.exec(expr.slice(0, ref.start));
    return m !== null && SMOOTHING.has(m[1]);
  });
}

export function roughness(points: [number, number | null][]): number {
  let sum = 0;
  let n = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const [, y] of points) {
    if (y === null || !Number.isFinite(y)) continue;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  if (!(max > min)) return 0;
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[i - 1][1];
    const b = points[i][1];
    const c = points[i + 1][1];
    if (a === null || b === null || c === null) continue;
    sum += Math.abs(c - 2 * b + a);
    n++;
  }
  return n === 0 ? 0 : sum / n / (max - min);
}

export function durationWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (s >= 3600 && s % 3600 === 0) return unit(s / 3600, "hour");
  if (s >= 60 && s % 60 === 0) return unit(s / 60, "minute");
  return unit(s, "second");
}

const perSecond: RecommendationRule = {
  id: "perSecond",
  evaluate({ panel, catalog }) {
    if (panel.type === "logs") return null;
    const counts = (name: string) => (catalog ? isCounter(catalog, name) : name.endsWith("_total"));
    for (const q of visiblePrometheus(panel)) {
      const refs = findRawCounters(q.expr, counts);
      if (refs.length === 0) continue;
      const names = [...new Set(refs.map((r) => r.metric as string))];
      const named = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
      return {
        id: "perSecond",
        key: keyOf("perSecond", panel, q.ref),
        text: [{ strong: named }, `${names.length === 1 ? " is a counter, so its" : " are counters, so their"} raw value${names.length === 1 ? "" : "s"} only go${names.length === 1 ? "es" : ""} up. Show ${names.length === 1 ? "it" : "them"} per second?`],
        apply: (p) => withExpr(p, q.ref, q.expr, (expr) => wrapRate(expr, findRawCounters(expr, counts))),
      };
    }
    return null;
  },
};

const usable = (data: PanelData | null): data is PanelData =>
  data !== null && (data.state === "ready" || data.state === "partial");

const widerWindow: RecommendationRule = {
  id: "widerWindow",
  evaluate({ panel, data, stepSeconds }) {
    if (panel.type !== "timeseries" || !usable(data) || !(stepSeconds > 0)) return null;
    const visibleRefs = new Set(panel.queries.filter((q) => !q.hidden).map((q) => q.ref));
    const rough = data.series
      .filter((s) => visibleRefs.has(s.queryRef))
      .filter((s) => s.points.filter(([, y]) => y !== null).length >= 20)
      .map((s) => roughness(s.points))
      .sort((a, b) => a - b);
    if (rough.length === 0) return null;
    const mid = rough.length >> 1;
    const median = rough.length % 2 ? rough[mid] : (rough[mid - 1] + rough[mid]) / 2;
    if (!(median > 0.3)) return null;
    const target = Math.max(300, 4 * stepSeconds);
    const shorter = (expr: string) => smoothingWindows(expr).filter((d) => d.seconds < target);
    const q = visiblePrometheus(panel).find((x) => shorter(x.expr).length > 0);
    if (!q) return null;
    return {
      id: "widerWindow",
      key: keyOf("widerWindow", panel, q.ref),
      text: ["The line is noisy at this window. ", { strong: durationWords(target) }, " is smoother and still shows spikes."],
      apply: (p) => withExpr(p, q.ref, q.expr, (expr) => replaceDurations(expr, shorter(expr), durationText(target))),
    };
  },
};

const stackedArea: RecommendationRule = {
  id: "stackedArea",
  evaluate({ panel, data }) {
    if (panel.type !== "timeseries" || panel.options.style !== "lines" || !usable(data)) return null;
    const visibleRefs = new Set(panel.queries.filter((q) => !q.hidden).map((q) => q.ref));
    const shown = data.series.filter((s) => visibleRefs.has(s.queryRef));
    const n = shown.length;
    if (n < 2 || n > 10) return null;
    if (shown.some((s) => s.points.some(([, y]) => y !== null && y < 0))) return null;
    const visible = panel.queries.filter((q) => !q.hidden);
    if (visible.length === 0 || !visible.every((q) => isRateQuery(q.expr))) return null;
    return {
      id: "stackedArea",
      key: keyOf("stackedArea", panel, null),
      text: [{ strong: `${n} rates` }, " read better stacked. Show as stacked area?"],
      apply: (p) => (p.type === "timeseries" ? { ...p, options: { ...p.options, style: "stacked" } } : p),
    };
  },
};

export const RULES: RecommendationRule[] = [perSecond, widerWindow, stackedArea];

export function registerRecommendationRule(rule: RecommendationRule): () => void {
  RULES.push(rule);
  return () => {
    const i = RULES.indexOf(rule);
    if (i >= 0) RULES.splice(i, 1);
  };
}

/** The first rule's result whose key has not been dismissed. */
export function recommendFor(ctx: RecommendationContext, dismissed: ReadonlySet<string>): Recommendation | null {
  // A query that doesn't read, or whose last run was refused as such, gets no advice.
  if (ctx.invalid || ctx.panel.queries.some((q) => !q.hidden && quickCheck(q.expr) !== null)) return null;
  for (const rule of RULES) {
    const rec = rule.evaluate(ctx);
    if (rec && !dismissed.has(rec.key)) return rec;
  }
  return null;
}
