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
