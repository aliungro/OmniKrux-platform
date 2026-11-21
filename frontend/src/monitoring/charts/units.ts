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

/**
 * The largest unit the value reaches, moved up one when rounding would print the next unit's size
 * (999.7 is "1k", not "1000").
 */
function pick(a: number, factors: number[], decimals: number | null): number {
  let i = 0;
  for (let j = factors.length - 1; j > 0; j--) {
    if (a >= factors[j]) {
      i = j;
      break;
    }
  }
  while (i < factors.length - 1 && Math.abs(Number(number(a / factors[i], decimals))) * factors[i] >= factors[i + 1] * (1 - 1e-9)) i++;
  return i;
}

const SI_FACTORS = [1, 1e3, 1e6, 1e9, 1e12];
const SI_SUFFIX = ["", "k", "M", "G", "T"];
function si(v: number, decimals: number | null): string {
  const i = pick(Math.abs(v), SI_FACTORS, decimals);
  return number(v / SI_FACTORS[i], decimals) + SI_SUFFIX[i];
}

const TIME_FACTORS = [1e-6, 1e-3, 1, 60, 3600, 86400];
const TIME_UNITS = ["µs", "ms", "s", "min", "h", "d"];
function seconds(v: number, decimals: number | null): string {
  if (v === 0) return "0 ms";
  const i = pick(Math.abs(v), TIME_FACTORS, decimals);
  return `${number(v / TIME_FACTORS[i], decimals)} ${TIME_UNITS[i]}`;
}

const BYTE_FACTORS = [1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 5];
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
function bytes(v: number, decimals: number | null): string {
  const i = pick(Math.abs(v), BYTE_FACTORS, decimals);
  return `${number(v / BYTE_FACTORS[i], decimals)} ${BYTE_UNITS[i]}`;
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
      return Math.abs(Number(number(v, decimals))) < 1000 ? `${number(v, decimals)} ms` : seconds(v / 1000, decimals);
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
