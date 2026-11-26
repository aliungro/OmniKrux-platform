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

/** What the custom form says before anything is typed, and when a time can't be read. */
export const LOCAL_TIME_COPY = "Use now, now-6h, now-7d, or a local time like 2026-11-25 10:00.";

const LOCAL_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2})$/;

/** Seconds for a local time written `YYYY-MM-DD HH:mm`; null when it isn't one or isn't a real time. */
function parseLocal(text: string): number | null {
  const m = LOCAL_TIME.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(0);
  date.setFullYear(y, mo - 1, d);
  date.setHours(h, mi, 0, 0);
  const real = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi;
  return real ? date.getTime() / 1000 : null;
}

/**
 * What the form stores for a typed time: `now`, `now-6h` and UTC times as they are; a local time
 * as UTC (`2026-11-25T09:00:00Z`). Null when it can't be read.
 */
export function storedTime(text: string): string | null {
  const t = text.trim();
  if (t === "now" || REL_TIME.test(t) || validUtc(t)) return t;
  const local = parseLocal(t);
  return local === null ? null : new Date(local * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const WORDS: Record<string, [string, string]> = { s: ["second", "seconds"], m: ["minute", "minutes"], h: ["hour", "hours"], d: ["day", "days"], w: ["week", "weeks"] };
const howLong = (rel: RegExpExecArray) => `${Number(rel[1])} ${WORDS[rel[2]][Number(rel[1]) === 1 ? 0 : 1]}`;

/**
 * The range in words: a relative one as `Last 365 days`, an absolute one in local time
 * (`25 Nov 10:00 – 12:00`; the year only when it isn't this one).
 */
export function rangeWords(time: TimeSpec, now: number): string {
  const rel = REL_TIME.exec(time.from);
  if (rel && time.to === "now") return `Last ${howLong(rel)}`;
  const toRel = REL_TIME.exec(time.to);
  const end = (): string => (time.to === "now" ? "now" : toRel ? `${howLong(toRel)} ago` : "");
  if (rel && toRel) return `${howLong(rel)} ago – ${howLong(toRel)} ago`;
  const a = parseTimeExpr(time.from, now);
  const b = parseTimeExpr(time.to, now);
  if (a === null || b === null) return timeLabel(time);
  const A = new Date(a * 1000);
  const B = new Date(b * 1000);
  const thisYear = new Date(now * 1000).getFullYear();
  const day = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === thisYear ? "" : ` ${d.getFullYear()}`}`;
  const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const from = `${day(A)} ${clock(A)}`;
  if (time.to === "now") return `${from} – ${end()}`;
  if (rel) return `${howLong(rel)} ago – ${day(B)} ${clock(B)}`;
  return day(A) === day(B) ? `${from} – ${clock(B)}` : `${from} – ${day(B)} ${clock(B)}`;
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
