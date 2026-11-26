// Series names for legends and tooltips. Pure; only dashboard code imports it.

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function quoted(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** `{a="b", c="d"}` sorted by name, without `__name__`; a set with only `__name__` is that name. */
export function formatLabels(labels: Record<string, string>): string {
  const names = Object.keys(labels).filter((k) => k !== "__name__").sort();
  if (names.length === 0 && Object.hasOwn(labels, "__name__")) return labels.__name__;
  return `{${names.map((k) => `${k}="${quoted(labels[k])}"`).join(", ")}}`;
}

/** The template with each `{{label}}` filled in (a missing label is empty); without a template
 * the label set; without labels the fallback (the query, for a scalar or a lone sum). */
export function legendName(template: string, labels: Record<string, string>, fallback: string): string {
  if (template.trim() !== "") return template.replace(PLACEHOLDER, (_, name: string) => (Object.hasOwn(labels, name) ? labels[name] : ""));
  if (Object.keys(labels).length === 0) return fallback;
  return formatLabels(labels);
}

/** Labels people read a series by, in the order they are said; `k8s_*` (OpenTelemetry) follow. */
const WELL_KNOWN = ["__name__", "namespace", "pod", "container", "instance", "job", "node"];
/** Labels that tell series apart but read as noise (cgroup paths, image names, ids): said only when
 * nothing else tells the series apart. */
const NOISY = ["id", "name", "image", "container_id", "uid"];

const valueOf = (l: Record<string, string>, k: string) => (Object.hasOwn(l, k) ? l[k] : undefined);

/** Whether these labels give every series its own name (a label a series lacks counts). */
function tellsApart(labelSets: Record<string, string>[], keys: string[]): boolean {
  const seen = new Set(labelSets.map((l) => JSON.stringify(keys.map((k) => valueOf(l, k) ?? null))));
  return seen.size === labelSets.length;
}

/**
 * Names for the series of one query that has no legend template: each is named by labels whose
 * values differ between the series (`k=v`, joined by `, `; `__name__` only when it differs). The
 * well-known labels (`namespace`, `pod`, `container`, `instance`, `job`, `node`, then `k8s_*`) lead
 * and are enough when they tell the series apart; other labels are added when they don't, and the
 * noisy ones (`id`, `name`, `image`, `container_id`, `uid`) only when nothing else does. A lone
 * series keeps its metric name. "" means nothing tells it apart: the caller's own words stand.
 */
export function seriesNames(labelSets: Record<string, string>[]): string[] {
  if (labelSets.length === 1) return [labelSets[0].__name__ ?? ""];
  const keys = [...new Set(labelSets.flatMap((l) => Object.keys(l)))].sort();
  const differing = keys.filter((k) => new Set(labelSets.map((l) => valueOf(l, k))).size > 1);
  const known = [
    ...WELL_KNOWN.filter((k) => differing.includes(k)),
    ...differing.filter((k) => k.startsWith("k8s_")),
  ];
  const other = differing.filter((k) => !known.includes(k) && !NOISY.includes(k));
  const noisy = NOISY.filter((k) => differing.includes(k));
  const tiers = [known, [...known, ...other], [...known, ...other, ...noisy]];
  const chosen = tiers.find((t) => t.length > 0 && tellsApart(labelSets, t)) ?? tiers[2];
  return labelSets.map((l) => chosen.filter((k) => Object.hasOwn(l, k)).map((k) => `${k}=${l[k]}`).join(", "));
}
