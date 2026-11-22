// Linking a metric to its log lines (X3). The selector comes only from the Task 5 writers (F16):
// the Only labels that Loki also has, values in double quotes through their escaping. A line's
// tone comes from its level label when it has one, else from the words in it.

import { LEVEL_LABELS, type Only, UnwritableQuery, writeLogQuery } from "../build/writeQuery";
import type { ChartLogLine } from "../dashboards/runPanel";

export type LineTone = "error" | "warn" | "info";
/** A tick on the time series: one log line's time (seconds) and tone. Mirrors the chart chunk's `ChartMark`. */
export type LineMark = { t: number; tone: LineTone };

/** The most lines one read lists (newest first). */
export const LINES_LIMIT = 1000;

const ERROR_WORDS = /\b(?:error|err|fatal|panic|critical|crit|alert|emerg)\b/i;
const WARN_WORDS = /\b(?:warn|warning)\b/i;

/** `{a="x",b="y"}` from the Only labels Loki has (sorted by the writer); none, or none writable, → `null`. */
export function linkedLogSelector(only: Only, lokiLabels: string[]): string | null {
  const have = new Set(lokiLabels);
  const kept = Object.fromEntries(Object.entries(only).filter(([label, value]) => have.has(label) && value !== ""));
  if (Object.keys(kept).length === 0) return null;
  try {
    return writeLogQuery(kept, []);
  } catch (err) {
    if (err instanceof UnwritableQuery) return null;
    throw err;
  }
}

function toneOf(text: string): LineTone {
  if (ERROR_WORDS.test(text)) return "error";
  if (WARN_WORDS.test(text)) return "warn";
  return "info";
}

/** A level label decides; without one, the words of the line do. */
export function lineTone(line: ChartLogLine): LineTone {
  for (const label of LEVEL_LABELS) {
    const value = line.labels[label];
    if (value !== undefined && value !== "") return toneOf(value);
  }
  return toneOf(line.line);
}

/** A line's time in seconds, from nanoseconds as text (no precision lost to a 19-digit number). */
export function lineSeconds(ts: string): number {
  return ts.length > 6 ? Number(ts.slice(0, -6)) / 1000 : 0;
}

export function logMarks(lines: ChartLogLine[]): LineMark[] {
  return lines.map((l) => ({ t: lineSeconds(l.ts), tone: lineTone(l) }));
}

const two = (n: number) => String(n).padStart(2, "0");
/** `HH:MM:SS` in the browser's time zone, from seconds. */
export function clockTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export const lineCount = (n: number) => `${n} log ${n === 1 ? "line" : "lines"}`;

/** `13:41:00 – 13:49:00 · 14 log lines`. */
export function windowLabel(range: { start: number; end: number }, lines: number): string {
  return `${clockTime(range.start)} – ${clockTime(range.end)} · ${lineCount(lines)}`;
}
