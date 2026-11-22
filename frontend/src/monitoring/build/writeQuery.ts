// Writing queries from catalog names and label values. This file and promql.ts are the only places
// query text is written from them (F16): values always sit inside double quotes through M2's
// escapeQueryString; a metric name or label name that is not a plain identifier is never written.
// The writers refuse by throwing UnwritableQuery (their signatures return text, not null).
import type { OwnerStreamLabel } from "../catalog/merge";
import type { BrowseMetric } from "../catalog/metrics";
import { escapeQueryString } from "../dashboards/interpolate";
import type { Unit } from "../dashboards/schema";

export const SPLIT_LABELS = ["route", "handler", "path", "endpoint", "uri", "method"];
export const STATUS_LABELS = ["status", "code", "status_code", "http_status", "response_code"];
export const STREAM_LABELS = ["namespace", "app", "service_name", "job", "container"];
export const LEVEL_LABELS = ["level", "detected_level", "severity", "lvl"];

export type Only = Record<string, string>;
export type Extra = { label: string; op: "=" | "!=" | "=~" | "!~"; value: string };

const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPS = new Set(["=", "!=", "=~", "!~"]);

export class UnwritableQuery extends Error {}

const metricName = (n: string) => {
  if (!METRIC_NAME.test(n)) throw new UnwritableQuery("That metric name can't be written into a query.");
  return n;
};
const labelName = (n: string) => {
  if (!LABEL_NAME.test(n)) throw new UnwritableQuery("That label name can't be written into a query.");
  return n;
};

function matchers(only: Only, extra: Extra[]): string {
  const all: Extra[] = [
    ...Object.entries(only).map(([label, value]) => ({ label, op: "=" as const, value })),
    ...extra,
  ];
  for (const m of all) {
    labelName(m.label);
    if (!OPS.has(m.op)) throw new UnwritableQuery("That matcher can't be written into a query.");
  }
  all.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return all.map((m) => `${m.label}${m.op}"${escapeQueryString(m.value)}"`).join(",");
}

/** `metric` or `metric{a="x",b="y"}`, matchers sorted by label. */
export function selectorText(metric: string, only: Only, extra: Extra[] = []): string {
  const body = matchers(only, extra);
  return body ? `${metricName(metric)}{${body}}` : metricName(metric);
}

const sumBy = (labels: string[]) => (labels.length ? `sum by (${labels.join(", ")}) ` : "sum");
const rated = (sel: string) => `rate(${sel}[$__rate_interval])`;

export function writeMetricQuery(
  m: BrowseMetric,
  split: string | null,
  only: Only,
  quantile = 0.95,
  extra: Extra[] = [],
): string {
  const by = split === null ? [] : [labelName(split)];
  const sel = (suffix = "") => selectorText(`${metricName(m.name)}${suffix}`, only, extra);
  if (m.kind === "counter") return `${sumBy(by)}(${rated(sel())})`;
  if (m.kind === "histogram") {
    if (!Number.isFinite(quantile)) throw new UnwritableQuery("That quantile can't be written into a query.");
    return `histogram_quantile(${quantile}, ${sumBy([...by, "le"])}(${rated(sel("_bucket"))}))`;
  }
  if (m.kind === "summary") {
    return `${sumBy(by)}(${rated(sel("_sum"))}) / ${sumBy(by)}(${rated(sel("_count"))})`;
  }
  return split === null ? sel() : `sum by (${by[0]}) (${sel()})`;
}

export function writeLogQuery(only: Only, streams: OwnerStreamLabel[]): string {
  if (Object.keys(only).length > 0) return `{${matchers(only, [])}}`;
  const names = streams.map((s) => s.name);
  const label = STREAM_LABELS.find((l) => names.includes(l)) ?? names[0];
  if (label === undefined) throw new UnwritableQuery("There is no label to select log streams by.");
  return `{${matchers({}, [{ label, op: "=~", value: ".+" }])}}`;
}

export function writeVolumeQuery(logQuery: string, split: string | null): string {
  const by = split === null ? [] : [labelName(split)];
  return `${sumBy(by)}(count_over_time(${logQuery}[$__interval]))`;
}

export function guessUnit(m: BrowseMetric): Unit {
  const n = m.name;
  if (m.kind === "counter") {
    if (n.includes("request")) return "reqps";
    if (n.endsWith("_bytes_total")) return "Bps";
    if (n.endsWith("cpu_seconds_total")) return "cores";
    return "short";
  }
  if ((m.kind === "histogram" || m.kind === "summary") && n.includes("seconds")) return "s";
  if (m.kind === "gauge" && n.endsWith("_bytes")) return "bytes";
  return "short";
}

const KNOWN_TITLES: Record<string, string> = {
  container_cpu_usage_seconds_total: "CPU",
  container_memory_working_set_bytes: "Memory",
  kube_pod_container_status_restarts_total: "Pod restarts",
  node_cpu_seconds_total: "Node CPU",
  node_memory_MemAvailable_bytes: "Node memory available",
  up: "Targets up",
};

export function humanTitle(name: string): string {
  if (Object.hasOwn(KNOWN_TITLES, name)) return KNOWN_TITLES[name];
  let base = name;
  for (let again = true; again; ) {
    again = false;
    for (const suffix of ["_total", "_seconds", "_bytes", "_bucket"]) {
      if (base.endsWith(suffix) && base.length > suffix.length) { base = base.slice(0, -suffix.length); again = true; }
    }
  }
  const words = base.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}
