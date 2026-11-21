// Values in words people read: `213 ms`, `1.5 KiB`, `28.3%`, `1.4k req/s`. Three significant digits
// unless the panel asks for a number of decimals.

import type { Unit } from "../dashboards/schema";

export const NO_VALUE = "–";

/** Three significant digits (whole numbers from 100 up), or `decimals` places when given. */
function number(v: number, decimals: number | null): string {
  if (decimals !== null) return v.toFixed(decimals);
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 100) return String(Math.round(v));
  return String(Number(v.toPrecision(3)));
}

function si(v: number, decimals: number | null): string {
  const a = Math.abs(v);
  const steps: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of steps) {
    if (a >= size) return number(v / size, decimals) + suffix;
  }
  return number(v, decimals);
}

function seconds(v: number, decimals: number | null): string {
  const a = Math.abs(v);
  if (a === 0) return "0 ms";
  if (a < 1e-3) return `${number(v * 1e6, decimals)} µs`;
  if (a < 1) return `${number(v * 1e3, decimals)} ms`;
  if (a < 60) return `${number(v, decimals)} s`;
  if (a < 3600) return `${number(v / 60, decimals)} min`;
  if (a < 86400) return `${number(v / 3600, decimals)} h`;
  return `${number(v / 86400, decimals)} d`;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
function bytes(v: number, decimals: number | null): string {
  let n = Math.abs(v);
  let i = 0;
  while (n >= 1024 && i < BYTE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${number(v < 0 ? -n : n, decimals)} ${BYTE_UNITS[i]}`;
}

export function formatValue(v: number | null, unit: Unit, decimals: number | null): string {
  if (v === null || !Number.isFinite(v)) return NO_VALUE;
  switch (unit) {
    case "none":
    case "short":
      return si(v, decimals);
    case "percent":
      return `${number(v, decimals)}%`;
    case "percentunit":
      return `${number(v * 100, decimals)}%`;
    case "s":
      return seconds(v, decimals);
    case "ms":
      return Math.abs(v) < 1000 ? `${number(v, decimals)} ms` : seconds(v / 1000, decimals);
    case "bytes":
      return bytes(v, decimals);
    case "Bps":
      return `${bytes(v, decimals)}/s`;
    case "reqps":
      return `${si(v, decimals)} req/s`;
    case "cores": {
      const text = number(v, decimals);
      return `${text} ${text === "1" ? "core" : "cores"}`;
    }
  }
}
