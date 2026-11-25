// Time ranges, refresh and query steps for dashboards. Pure; only dashboard code imports it.

import { ABS_TIME, REL_TIME, validUtc } from "./schema";
import type { RefreshSpec, TimeSpec } from "./schema";

export const TIME_PRESETS: readonly { from: string; label: string }[] = [
  { from: "now-5m", label: "Last 5 minutes" },
  { from: "now-15m", label: "Last 15 minutes" },
  { from: "now-1h", label: "Last 1 hour" },
  { from: "now-3h", label: "Last 3 hours" },
  { from: "now-6h", label: "Last 6 hours" },
  { from: "now-12h", label: "Last 12 hours" },
  { from: "now-24h", label: "Last 24 hours" },
  { from: "now-2d", label: "Last 2 days" },
  { from: "now-7d", label: "Last 7 days" },
];

const UNIT: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/** Seconds since the epoch for "now", "now-<n><unit>" or a UTC time; null when it is none. */
export function parseTimeExpr(text: string, nowSeconds: number): number | null {
  const t = text.trim();
  if (t === "now") return nowSeconds;
  const rel = REL_TIME.exec(t);
  if (rel) {
    const v = nowSeconds - Number(rel[1]) * UNIT[rel[2]];
    return Number.isFinite(v) ? v : null;
  }
  const abs = ABS_TIME.exec(t);
  if (abs && validUtc(t)) {
    const [y, mo, d, h, mi, s] = abs.slice(1).map(Number);
    // Date.UTC maps years 0-99 to 19xx; setUTCFullYear does not.
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d);
    date.setUTCHours(h, mi, s, 0);
    const ms = date.getTime();
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  return null;
}

/** The absolute range, or null when either end is unreadable or the range is not forwards. */
export function resolveTime(
  t: TimeSpec,
  nowSeconds: number,
): { start: number; end: number } | null {
  const start = parseTimeExpr(t.from, nowSeconds);
  const end = parseTimeExpr(t.to, nowSeconds);
  if (start === null || end === null || start >= end) return null;
  return { start, end };
}

export function timeLabel(t: TimeSpec): string {
  if (t.to === "now") {
    const preset = TIME_PRESETS.find((p) => p.from === t.from);
    if (preset) return preset.label;
  }
  return `${t.from} to ${t.to}`;
}

export const NICE_STEPS: readonly number[] = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400,
];

/** The smallest nice step that keeps a range to about sixty points per grid column. */
export function stepFor(rangeSeconds: number, widthColumns: number): number {
  const wanted = rangeSeconds / (60 * Math.max(1, widthColumns));
  for (const s of NICE_STEPS) if (s >= wanted) return s;
  return NICE_STEPS[NICE_STEPS.length - 1];
}

export function alignRange(
  start: number,
  end: number,
  step: number,
): { start: number; end: number } {
  return {
    start: Math.floor(start / step) * step,
    end: Math.ceil(end / step) * step,
  };
}

export const REFRESH_LABELS: readonly { value: RefreshSpec; label: string }[] = [
  { value: null, label: "Off" },
  { value: "10s", label: "10 s" },
  { value: "30s", label: "30 s" },
  { value: "1m", label: "1 min" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 h" },
];

const REFRESH_MS: Record<string, number> = {
  "10s": 10_000,
  "30s": 30_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

export function refreshMs(r: RefreshSpec): number | null {
  return r === null ? null : (REFRESH_MS[r] ?? null);
}

/** "30s", "5m", "2h"; a count that does not divide evenly stays in seconds ("90s"). */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}
