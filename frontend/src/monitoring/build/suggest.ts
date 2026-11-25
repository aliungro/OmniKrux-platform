// The panels worth offering first for a project's or group's catalog: each rule appears only when
// what it needs exists. Every query is written through the query writers (F15, F16); a rule whose
// query can't be written is left out.
import type { OwnerCatalog } from "../catalog/merge";
import { browseMetrics } from "../catalog/metrics";
import type { BrowseMetric } from "../catalog/metrics";
import type { Candidate } from "./candidates";
import {
  LEVEL_LABELS, SPLIT_LABELS, STATUS_LABELS, STREAM_LABELS, UnwritableQuery, selectorText, writeLogQuery,
  writeMetricQuery, writeVolumeQuery,
} from "./writeQuery";

export const MAX_SUGGESTIONS = 8;

const REQUEST_NAME = /(^|_)requests?_total$/;
const SPRING_REQUESTS = "http_server_requests_seconds_count";
const ERROR_LINES = '|~ "(?i)(error|fatal|panic)"';
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function requestRank(name: string): number {
  if (name === "http_requests_total") return 1;
  if (name.endsWith("http_requests_total") || name.endsWith("http_server_requests_total")) return 2;
  return 3;
}

export function pickRequestCounter(metrics: BrowseMetric[]): BrowseMetric | null {
  const found = metrics.filter(
    (m) =>
      (m.kind === "counter" && REQUEST_NAME.test(m.name)) ||
      (m.name === SPRING_REQUESTS && (m.kind === "counter" || m.kind === "unknown")),
  );
  found.sort((a, b) => requestRank(a.name) - requestRank(b.name) || b.series - a.series || byText(a.name, b.name));
  return found[0] ?? null;
}

export function suggestionsHeading(ownerName: string, catalog: OwnerCatalog): string {
  const from =
    catalog.hasPrometheus && catalog.hasLoki ? "Prometheus and Loki"
    : catalog.hasPrometheus ? "Prometheus"
    : catalog.hasLoki ? "Loki"
    : "your sources";
  return `Suggested for ${ownerName} · from what ${from} have`;
}

type Make = (metrics: Map<string, BrowseMetric>, all: BrowseMetric[], catalog: OwnerCatalog) => Candidate | null;

const prom = { sourceType: "prometheus" as const };
const named = (c: Candidate): Candidate => c;

function lokiLabel(catalog: OwnerCatalog) {
  const writable = catalog.streams.filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name));
  const label = STREAM_LABELS.find((l) => writable.some((s) => s.name === l));
  return writable.find((s) => s.name === label) ?? writable[0] ?? null;
}

const RULES: Make[] = [
  // requestRate
  (_by, all) => {
    const r = pickRequestCounter(all);
    if (!r) return null;
    const counter = { ...r, kind: "counter" as const };
    const s = SPLIT_LABELS.find((l) => r.labels.includes(l)) ?? null;
    return named({
      key: "requestRate", title: "Request rate", subtitle: `${r.name} · counter → per second`, panelType: "timeseries",
      expr: writeMetricQuery(counter, s, {}), ...prom, sourceId: r.sourceId, unit: "reqps",
      legend: s === null ? "" : `{{${s}}}`,
    });
  },
  // errorRate
  (_by, all) => {
    const r = pickRequestCounter(all);
    const t = r && STATUS_LABELS.find((l) => r.labels.includes(l));
    if (!r || !t) return null;
    const counter = { ...r, kind: "counter" as const };
    const errors = writeMetricQuery(counter, null, {}, 0.95, [{ label: t, op: "=~", value: "5.." }]);
    return named({
      key: "errorRate", title: "Error rate", subtitle: `${t}=~"5.." ÷ all requests`, panelType: "timeseries",
      expr: `${errors} / ${writeMetricQuery(counter, null, {})}`, ...prom, sourceId: r.sourceId,
      unit: "percentunit", legend: "", options: { max: 1 },
    });
  },
  // latencyP95
  (_by, all) => {
    const hist = all
      .filter((m) => m.kind === "histogram" && m.name.includes("seconds"))
      .sort(
        (a, b) =>
          Number(b.name.includes("http")) - Number(a.name.includes("http")) || b.series - a.series || byText(a.name, b.name),
      )[0];
    if (!hist) return null;
    return named({
      key: "latencyP95", title: "p95 latency", subtitle: `${hist.name} · histogram`, panelType: "timeseries",
      expr: writeMetricQuery(hist, null, {}, 0.95), ...prom, sourceId: hist.sourceId, unit: "s", legend: "",
    });
  },
  // podRestarts
  (by) => {
    const m = by.get("kube_pod_container_status_restarts_total");
    if (!m) return null;
    return named({
      key: "podRestarts", title: "Pod restarts", subtitle: m.name, panelType: "timeseries",
      expr: `topk(5, sum by (namespace, pod) (increase(${selectorText(m.name, {})}[1h])))`,
      ...prom, sourceId: m.sourceId, unit: "short", legend: "{{namespace}}/{{pod}}",
    });
  },
  // logVolume
  (_by, _all, catalog) => {
    const l = lokiLabel(catalog);
    if (!l) return null;
    const level = LEVEL_LABELS.find((x) => catalog.streams.some((s) => s.name === x));
    const v = level ?? l.name;
    return named({
      key: "logVolume", title: level ? "Log volume by level" : `Log volume by ${l.name}`,
      subtitle: level ? `Loki · ${l.name} by level` : `Loki · by ${l.name}`, panelType: "timeseries",
      expr: writeVolumeQuery(writeLogQuery({}, [l]), v), sourceType: "loki", sourceId: l.sourceId, unit: "short",
      legend: "", options: { style: "stacked" },
    });
  },
  // cpuByPod
  (by) => {
    const m = by.get("container_cpu_usage_seconds_total");
    if (!m || !m.labels.includes("pod")) return null;
    const sel = selectorText(m.name, {}, [{ label: "container", op: "!=", value: "" }]);
    return named({
      key: "cpuByPod", title: "CPU by pod", subtitle: m.name, panelType: "timeseries",
      expr: `topk(10, sum by (namespace, pod) (rate(${sel}[$__rate_interval])))`,
      ...prom, sourceId: m.sourceId, unit: "cores", legend: "{{namespace}}/{{pod}}",
    });
  },
  // memoryByPod
  (by) => {
    const m = by.get("container_memory_working_set_bytes");
    if (!m || !m.labels.includes("pod")) return null;
    const sel = selectorText(m.name, {}, [{ label: "container", op: "!=", value: "" }]);
    return named({
      key: "memoryByPod", title: "Memory by pod", subtitle: m.name, panelType: "timeseries",
      expr: `topk(10, sum by (namespace, pod) (${sel}))`,
      ...prom, sourceId: m.sourceId, unit: "bytes", legend: "{{namespace}}/{{pod}}",
    });
  },
  // nodeCpu
  (by) => {
    const m = by.get("node_cpu_seconds_total");
    if (!m || !m.labels.includes("mode")) return null;
    const sel = selectorText(m.name, { mode: "idle" });
    return named({
      key: "nodeCpu", title: "Node CPU busy", subtitle: m.name, panelType: "timeseries",
      expr: `1 - avg by (instance) (rate(${sel}[$__rate_interval]))`,
      ...prom, sourceId: m.sourceId, unit: "percentunit", legend: "{{instance}}", options: { max: 1 },
    });
  },
  // targetsDown
  (by) => {
    const m = by.get("up");
    if (!m) return null;
    return named({
      key: "targetsDown", title: "Targets down", subtitle: "up", panelType: "stat",
      expr: `count(${selectorText(m.name, {})} == 0) or vector(0)`,
      ...prom, sourceId: m.sourceId, unit: "none", legend: "", options: { thresholds: [{ value: 1, color: "bad" }] },
    });
  },
  // errorLogs
  (_by, _all, catalog) => {
    const l = lokiLabel(catalog);
    if (!l) return null;
    return named({
      key: "errorLogs", title: "Error log lines", subtitle: 'Loki · |~ "error"', panelType: "logs",
      expr: `${writeLogQuery({}, [l])} ${ERROR_LINES}`, sourceType: "loki", sourceId: l.sourceId, unit: "none",
      legend: "", options: { limit: 100 },
    });
  },
];

export function suggestPanels(catalog: OwnerCatalog): Candidate[] {
  const all = browseMetrics(catalog);
  const byName = new Map(all.map((m) => [m.name, m]));
  const out: Candidate[] = [];
  for (const rule of RULES) {
    if (out.length >= MAX_SUGGESTIONS) break;
    try {
      const c = rule(byName, all, catalog);
      if (c) out.push(c);
    } catch (err) {
      if (!(err instanceof UnwritableQuery)) throw err;
    }
  }
  return out;
}
