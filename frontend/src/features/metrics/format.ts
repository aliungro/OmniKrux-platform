const UNITS = [
  ["Gi", 1024 ** 3],
  ["Mi", 1024 ** 2],
  ["Ki", 1024],
] as const;

/** The unit that reads best for `bytes`: 301 Mi, not 0.3 Gi or 308224 Ki. */
function unitFor(bytes: number): readonly [string, number] {
  return UNITS.find(([, size]) => bytes >= size) ?? (["B", 1] as const);
}

function amount(bytes: number, size: number): string {
  const v = bytes / size;
  return v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
}

export function formatCpu(m: number): string {
  return m >= 10_000 ? `${(m / 1000).toFixed(1)} cores` : `${m}m`;
}

/** "154 Mi", or "301 / 256 Mi" against a limit (both in the limit's unit). */
export function formatMemory(bytes: number, against?: number | null): string {
  const [unit, size] = unitFor(against ?? bytes);
  return against ? `${amount(bytes, size)} / ${amount(against, size)} ${unit}` : `${amount(bytes, size)} ${unit}`;
}

export function formatWindow(seconds: number | null): string {
  return seconds === null ? "an unknown window" : `${Math.round(seconds)} s`;
}

/** 0..1+ of `of`; null when there is nothing to measure against. */
export function fraction(used: number, of: number | null | undefined): number | null {
  return of ? used / of : null;
}

/** Hot from 90% of the limit (or of what the node can allocate). */
export const HOT_AT = 0.9;
