/** Kubelet timestamps: RFC 3339 with a fraction of any length (Kubernetes trims trailing zeros). */
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Whole seconds since the epoch in milliseconds, then nanoseconds: compare with `compareTs`. */
export type TsKey = readonly [number, number];

/** A sortable key for an RFC 3339 timestamp, or null if it isn't one. "…13.09Z" and "…13.090Z" are equal. */
export function tsKey(ts: string): TsKey | null {
  const m = TS.exec(ts);
  if (!m) return null;
  const ms = Date.parse(m[1] + m[3]);
  if (Number.isNaN(ms)) return null;
  return [ms, Number((m[2] ?? "").padEnd(9, "0"))];
}

export function compareTs(a: TsKey, b: TsKey): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** The time of day as stamped, to the millisecond: "14:04:13.090". Anything else is shown as it is. */
export function formatTs(ts: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(ts);
  if (!m) return ts;
  return `${m[1]}.${(m[2] ?? "").padEnd(3, "0").slice(0, 3)}`;
}
