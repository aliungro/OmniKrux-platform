// Logs panel: lines with their local time, newest first by default, virtualized (wrapped lines are
// measured). Up and Down move between lines; Enter shows a line's labels. The active line is
// tracked by its key, so a refresh that shifts the list keeps focus on the same line.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { ChartLogLine } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import styles from "./Charts.module.css";

type LogsPanel = Extract<PanelSpec, { type: "logs" }>;

const ROW = 22;
const OVERSCAN = 8;
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
  const order = panel.options.order;
  const lines = useMemo(() => {
    const sorted = [...logs].sort(byTime);
    return order === "newest" ? sorted.reverse() : sorted;
  }, [logs, order]);
  if (lines.length === 0) return null;
  // Its own component, so the virtualizer binds to a fresh scroll box after an empty answer.
  return <LogList panel={panel} lines={lines} />;
}

function LogList({ panel, lines }: { panel: LogsPanel; lines: ChartLogLine[] }) {
  const { wrap } = panel.options;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const focusPending = useRef(false);
  const focusWithin = useRef(false);
  const lastIndex = useRef(0);
  const labelsId = useId();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const indexByKey = useMemo(() => new Map(lines.map((l, i) => [l.key, i])), [lines]);
  const found = activeKey === null ? undefined : indexByKey.get(activeKey);
  const activeIndex = found ?? Math.min(lastIndex.current, lines.length - 1);
  const activeLine = lines[activeIndex];
  if (found !== undefined) lastIndex.current = found;

  // The active line is always among the mounted ones.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const base = defaultRangeExtractor(range);
      return base.includes(activeIndex) ? base : [...base, activeIndex].sort((a, b) => a - b);
    },
    [activeIndex],
  );
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    getItemKey: (i) => lines[i].key,
    overscan: OVERSCAN,
    rangeExtractor,
  });
  // Switching wrap changes every row's height: forget the measured ones (not on the first draw).
  const firstWrap = useRef(wrap);
  useEffect(() => {
    if (firstWrap.current !== wrap) {
      firstWrap.current = wrap;
      virtualizer.measure();
    }
  }, [virtualizer, wrap]);

  // The focused line left the list (it rolled off): focus its neighbour, never the page.
  useLayoutEffect(() => {
    if (activeKey !== null && found === undefined && focusWithin.current) {
      setActiveKey(activeLine.key);
      focusPending.current = true;
    }
  }, [activeKey, found, activeLine]);

  useLayoutEffect(() => {
    if (!focusPending.current) return;
    const el = rowRefs.current.get(activeLine.key);
    if (!el) return;
    focusPending.current = false;
    el.focus({ preventScroll: true });
  });

  const move = (to: number) => {
    const next = Math.max(0, Math.min(lines.length - 1, to));
    setActiveKey(lines[next].key);
    focusPending.current = true;
    virtualizer.scrollToIndex(next, { align: "auto" });
  };
  const page = () => Math.max(1, Math.floor((scrollRef.current?.clientHeight || 320) / ROW) - 1);
  const onKey = (i: number, line: ChartLogLine) => (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(i + 1); break;
      case "ArrowUp": e.preventDefault(); move(i - 1); break;
      case "PageDown": e.preventDefault(); move(i + page()); break;
      case "PageUp": e.preventDefault(); move(i - page()); break;
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

  const openLine = open === null ? null : lines.find((l) => l.key === open) ?? null;
  const labels = openLine ? Object.entries(openLine.labels).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <div className={styles.logs}>
      <div
        ref={scrollRef}
        className={styles.logScroll}
        role="list"
        aria-label={panel.title}
        onFocus={() => { focusWithin.current = true; }}
        onBlur={(e) => { if (e.target.isConnected) focusWithin.current = false; }}
      >
        <div className={styles.logSpace} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const line = lines[v.index];
            return (
              <div
                key={v.key}
                role="listitem"
                data-index={v.index}
                ref={(el) => {
                  if (el) rowRefs.current.set(line.key, el);
                  else rowRefs.current.delete(line.key);
                  if (wrap) virtualizer.measureElement(el);
                }}
                tabIndex={v.index === activeIndex ? 0 : -1}
                aria-keyshortcuts="Enter"
                aria-describedby={open === line.key ? labelsId : undefined}
                className={wrap ? `${styles.logLine} ${styles.logWrap}` : styles.logLine}
                data-open={open === line.key ? "true" : undefined}
                style={{ transform: `translateY(${v.start}px)`, height: wrap ? undefined : ROW }}
                onKeyDown={onKey(v.index, line)}
                onFocus={() => setActiveKey(line.key)}
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
      <div id={labelsId} role="status" aria-live="polite" className={openLine ? styles.logLabels : undefined}>
        {openLine
          ? labels.length === 0
            ? <span className={styles.logValue}>No labels on this line.</span>
            : labels.map(([k, val]) => (
              <span key={k} className={styles.logLabel}>
                <span className={styles.logKey}>{k}</span>
                <span className={styles.logValue}>{val}</span>
              </span>
            ))
          : null}
      </div>
    </div>
  );
}
