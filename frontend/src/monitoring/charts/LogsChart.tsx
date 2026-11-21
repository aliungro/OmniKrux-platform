// Logs panel: lines with their local time, newest first by default. Up and Down move between
// lines (the focused line stays mounted while the list scrolls); Enter shows a line's labels.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ChartLogLine } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { useWindowed } from "./useWindowed";
import styles from "./Charts.module.css";

type LogsPanel = Extract<PanelSpec, { type: "logs" }>;

const ROW = 22;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `HH:MM:SS.mmm` in the browser's time zone, from nanoseconds as text. */
export function logTime(ts: string): string {
  const ms = ts.length > 6 ? Number(ts.slice(0, -6)) : 0;
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function byTime(a: ChartLogLine, b: ChartLogLine): number {
  return a.ts.length - b.ts.length || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
}

export interface LogsChartProps {
  panel: LogsPanel;
  logs: ChartLogLine[];
}

export default function LogsChart({ panel, logs }: LogsChartProps) {
  const { wrap, order } = panel.options;
  const lines = useMemo(() => {
    const sorted = [...logs].sort(byTime);
    return order === "newest" ? sorted.reverse() : sorted;
  }, [logs, order]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const refs = useRef(new Map<number, HTMLElement>());
  const focusNext = useRef(false);
  const win = useWindowed(lines.length, ROW, !wrap);

  const current = Math.min(active, Math.max(0, lines.length - 1));
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    refs.current.get(current)?.focus();
  });

  if (lines.length === 0) return null;

  const move = (to: number) => {
    const next = Math.max(0, Math.min(lines.length - 1, to));
    focusNext.current = true;
    win.reveal(next);
    setActive(next);
  };
  const onKey = (i: number, line: ChartLogLine) => (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(i + 1); break;
      case "ArrowUp": e.preventDefault(); move(i - 1); break;
      case "PageDown": e.preventDefault(); move(i + win.pageRows); break;
      case "PageUp": e.preventDefault(); move(i - win.pageRows); break;
      case "Home": e.preventDefault(); move(0); break;
      case "End": e.preventDefault(); move(lines.length - 1); break;
      case "Enter": e.preventDefault(); setOpen((k) => (k === line.key ? null : line.key)); break;
      case "Escape":
        if (open !== null) {
          e.stopPropagation();
          setOpen(null);
        }
        break;
    }
  };

  const shown: number[] = [];
  for (let i = win.first; i < win.last; i++) shown.push(i);
  // The focused line stays mounted however far the list has scrolled.
  if (!wrap && current < win.first) shown.unshift(current);
  else if (!wrap && current >= win.last) shown.push(current);

  const openLine = open === null ? null : lines.find((l) => l.key === open) ?? null;
  const labels = openLine ? Object.entries(openLine.labels).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <div className={styles.logs}>
      <div ref={win.ref} className={styles.logScroll} onScroll={win.onScroll} role="list" aria-label={panel.title}>
        <div className={wrap ? styles.logFlow : styles.logSpace} style={wrap ? undefined : { height: lines.length * ROW }}>
          {shown.map((i) => {
            const line = lines[i];
            return (
              <div
                key={line.key}
                role="listitem"
                ref={(el) => {
                  if (el) refs.current.set(i, el);
                  else refs.current.delete(i);
                }}
                tabIndex={i === current ? 0 : -1}
                aria-expanded={open === line.key}
                aria-keyshortcuts="Enter"
                className={wrap ? `${styles.logLine} ${styles.logWrap}` : styles.logLine}
                style={wrap ? undefined : { top: i * ROW, height: ROW }}
                onKeyDown={onKey(i, line)}
                onFocus={() => setActive(i)}
              >
                <time className={styles.logTime}>{logTime(line.ts)}</time>
                <span className={styles.logText}>
                  {line.projectName !== null ? <span className={styles.logProject}>{line.projectName} </span> : null}
                  {line.line}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {openLine ? (
        <dl className={styles.logLabels} aria-label="Labels">
          {labels.length === 0 ? <dd>No labels on this line.</dd> : labels.map(([k, v]) => (
            <div key={k} className={styles.logLabel}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
