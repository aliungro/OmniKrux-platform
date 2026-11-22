// The metrics a catalog lists, as the browse view shows them: one line per metric, one per family
// (a histogram's `_bucket`, `_sum` and `_count` are one entry), with a kind to read at a glance.
import type { OwnerCatalog, OwnerMetric } from "./merge";

export type MetricKind = "counter" | "gauge" | "histogram" | "summary" | "unknown";

export type BrowseMetric = {
  name: string;
  kind: MetricKind;
  typeLabel: string;
  help: string | null;
  labels: string[];
  series: number;
  sourceId: string | null;
};

// Names are written into queries only when they are plain identifiers (never offered otherwise).
const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUCKET_LABELS = new Set(["le", "quantile"]);

const HISTOGRAM_TYPES = new Set(["histogram", "gaugehistogram"]);

function kindOf(m: OwnerMetric): MetricKind {
  if (m.type === "counter" || (m.type === null && m.name.endsWith("_total"))) return "counter";
  if (m.type === "gauge") return "gauge";
  if (m.type === "summary") return "summary";
  if (m.type !== null && HISTOGRAM_TYPES.has(m.type)) return "histogram";
  return "unknown";
}

const labelsOf = (labels: string[]) => labels.filter((l) => LABEL_NAME.test(l));

function familyEntry(family: string, parts: OwnerMetric[]): BrowseMetric {
  const typed = parts.find((p) => p.type === "summary" || (p.type !== null && HISTOGRAM_TYPES.has(p.type)));
  const kind: MetricKind = typed
    ? typed.type === "summary" ? "summary" : "histogram"
    : parts.some((p) => p.labels.includes("quantile")) ? "summary" : "histogram";
  const count = parts.find((p) => p.name === `${family}_count`);
  const labels = [...new Set(parts.flatMap((p) => p.labels))].filter((l) => !BUCKET_LABELS.has(l));
  const own = parts.find((p) => p.name === family);
  return {
    name: family, kind, typeLabel: kind,
    help: own?.help ?? parts.find((p) => p.help !== null)?.help ?? null,
    labels: labelsOf(labels.sort()),
    series: count ? count.series : Math.max(...parts.map((p) => p.series)),
    sourceId: parts[0].sourceId,
  };
}

export function browseMetrics(catalog: OwnerCatalog): BrowseMetric[] {
  const families = new Map<string, OwnerMetric[]>();
  const out: BrowseMetric[] = [];
  for (const m of catalog.metrics) {
    if (m.family !== null) {
      families.set(m.family, [...(families.get(m.family) ?? []), m]);
    } else if (METRIC_NAME.test(m.name)) {
      const kind = kindOf(m);
      out.push({
        name: m.name, kind, typeLabel: kind === "unknown" ? "—" : kind, help: m.help,
        labels: labelsOf(m.labels), series: m.series, sourceId: m.sourceId,
      });
    }
  }
  for (const [family, parts] of families) if (METRIC_NAME.test(family)) out.push(familyEntry(family, parts));
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A counter by its type; with no known type, by a `_total` name. */
export function isCounter(catalog: OwnerCatalog, name: string): boolean {
  const m = catalog.metrics.find((x) => x.name === name);
  return m?.type != null ? m.type === "counter" : name.endsWith("_total");
}
