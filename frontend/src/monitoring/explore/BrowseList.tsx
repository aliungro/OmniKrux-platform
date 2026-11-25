// The browse list (X2): the metrics of the project's Prometheus-compatible source, or the log
// streams of its Loki source, as one virtualized listbox. The keyboard stays on the listbox:
// Up/Down move the highlight, Enter picks, and a letter goes into the filter. A pick writes the
// query; it never moves the focus.

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { catalogAge, type OwnerStreamLabel } from "../catalog/merge";
import type { BrowseMetric } from "../catalog/metrics";
import type { Only } from "../build/writeQuery";
import HelpTip from "../build/HelpTip";
import s from "./BrowseList.module.css";

const ROW = 30;
const OVERSCAN = 6;
const FILTER_MS = 150;

export interface BrowseListProps {
  mode: "metrics" | "streams";
  projectName: string;
  metrics: BrowseMetric[];
  streams: OwnerStreamLabel[];
  selectedMetric: string | null;
  /** In logs mode: the label values the query selects now. */
  selectedStreams: Only;
  loading: boolean;
  /** The catalog could not be read at all. */
  error: string | null;
  /** Lines about what the sources couldn't list. */
  problems: string[];
  /** Technical notes about the list, kept in a help tip (only the list's own source type). */
  notes: string[];
  /** In logs mode: how far back the streams were read (seconds); null when unknown. */
  streamWindowSeconds?: number | null;
  builtAt: number | null;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh(): void;
  onPickMetric(m: BrowseMetric): void;
  onPickStream(label: string, value: string): void;
}

type Row =
  | { kind: "metric"; key: string; metric: BrowseMetric }
  | { kind: "head"; key: string; label: string }
  | { kind: "stream"; key: string; label: string; value: string };

/** `604800` → `7 days`, `3600` → `1 hour`. */
export function windowWords(seconds: number): string {
  for (const [size, one, many] of [[86400, "day", "days"], [3600, "hour", "hours"], [60, "minute", "minutes"]] as const) {
    if (seconds >= size && seconds % size === 0) { const n = seconds / size; return `${n} ${n === 1 ? one : many}`; }
  }
  return `${seconds} seconds`;
}

const lower = (t: string) => t.toLocaleLowerCase();

function rowsOf(mode: "metrics" | "streams", metrics: BrowseMetric[], streams: OwnerStreamLabel[], text: string): Row[] {
  const needle = lower(text.trim());
  if (mode === "metrics") {
    return metrics
      .filter((m) => needle === "" || lower(m.name).includes(needle))
      .map((metric) => ({ kind: "metric", key: `m:${metric.name}`, metric }));
  }
  const rows: Row[] = [];
  for (const st of streams) {
    const values = st.values.filter((v) => v !== "" && (needle === "" || lower(st.name).includes(needle) || lower(v).includes(needle)));
    if (values.length === 0) continue;
    rows.push({ kind: "head", key: `h:${st.name}`, label: st.name });
    for (const value of values) rows.push({ kind: "stream", key: `s:${st.name}\u0000${value}`, label: st.name, value });
  }
  return rows;
}

export const BrowseList = forwardRef<HTMLDivElement, BrowseListProps>(function BrowseList(props, ref) {
  const { mode, projectName, metrics, streams, selectedMetric, selectedStreams, loading, error, problems, notes, streamWindowSeconds, builtAt, refreshing, refreshError } = props;
  const uid = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => scroller.current as HTMLDivElement);

  // The filter waits 150 ms after the last key.
  const [text, setText] = useState("");
  const [applied, setApplied] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setApplied(text), FILTER_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const rows = useMemo(() => rowsOf(mode, metrics, streams, applied), [mode, metrics, streams, applied]);
  const options = useMemo(() => rows.flatMap((r, i) => (r.kind === "head" ? [] : [i])), [rows]);
  const total = mode === "metrics" ? metrics.length : streams.reduce((n, st) => n + st.values.filter((v) => v !== "").length, 0);
  const [active, setActive] = useState(0);
  const activeAt = options.length === 0 ? -1 : Math.min(active, options.length - 1);
  const activeRow = activeAt < 0 ? -1 : options[activeAt];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: OVERSCAN,
  });
  useEffect(() => { setActive(0); }, [applied, mode]);

  const optionId = (i: number) => `${uid}-o${i}`;
  const move = (to: number) => {
    const next = Math.max(0, Math.min(options.length - 1, to));
    setActive(next);
    virtualizer.scrollToIndex(options[next], { align: "auto" });
  };
  const pickRow = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "metric") props.onPickMetric(row.metric);
    else if (row.kind === "stream") props.onPickStream(row.label, row.value);
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = Math.max(0, activeAt);
    if (e.key === "ArrowDown") { e.preventDefault(); move(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (at === 0) filter.current?.focus(); else move(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(options.length - 1); }
    else if (e.key === "Enter" && activeRow >= 0) { e.preventDefault(); pickRow(activeRow); }
    else if (e.key.length === 1 && e.key !== " " && e.key !== "?") {
      // Typeahead: a letter typed on the list goes into the filter, which takes the keyboard.
      e.preventDefault();
      setText((t) => t + e.key);
      filter.current?.focus();
    }
  };
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // The first Esc clears the words; the next one hands the keyboard to the list.
      if (text !== "") { setText(""); setApplied(""); } else scroller.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      scroller.current?.focus();
    }
  };

  const isSelected = (r: Row) =>
    r.kind === "metric" ? r.metric.name === selectedMetric : r.kind === "stream" ? selectedStreams[r.label] === r.value : false;

  // The visible rows, in runs of one group: a run is the group's own element, so the listbox holds
  // groups of options even though only some of their rows exist.
  const runs: { key: string; group: string | null; start: number; rows: number[] }[] = [];
  for (const v of virtualizer.getVirtualItems()) {
    const row = rows[v.index];
    if (!row) continue;
    const group = row.kind === "metric" ? null : row.label;
    const last = runs[runs.length - 1];
    if (last && group !== null && last.group === group) last.rows.push(v.index);
    else runs.push({ key: `${group ?? "-"}:${v.index}`, group, start: v.start, rows: [v.index] });
  }

  const noun = mode === "metrics" ? "Metrics" : "Log streams";
  const age = catalogAge(builtAt, Date.now());
  // A source that failed proved nothing: its own words (the problem lines) stand, not "none".
  const none = !loading && !error && rows.length === 0 && !(mode === "streams" && !streamWindowSeconds && problems.length > 0 && applied.trim() === "");
  return (
    <div className={s.browse}>
      <div className={s.headRow}>
        <h2 className={s.heading}>{`${noun} in ${projectName} · ${total}`}</h2>
        {notes.length > 0 && <HelpTip label="About this list">{notes.join(" ")}</HelpTip>}
      </div>
      <input ref={filter} className={s.filter} type="text" autoComplete="off" spellCheck={false}
        aria-label="Filter the list" placeholder="Filter" value={text}
        onChange={(e) => setText(e.target.value)} onKeyDown={onFilterKey} />
      {loading && <p className={s.line}>Loading the list…</p>}
      {error && (
        <div className={s.failed}>
          <p className={s.line}>{`Couldn't read the list: ${error}`}</p>
          <button type="button" className={s.action} aria-disabled={refreshing || undefined} onClick={props.onRefresh}>
            {refreshing ? "Trying again…" : "Try again"}
          </button>
        </div>
      )}
      {problems.map((n) => <p key={n} className={s.line}>{n}</p>)}
      {none && (
        <p className={s.line}>
          {applied.trim() !== "" ? "Nothing matches that." : mode === "metrics" ? "This source lists no metrics yet." : streamWindowSeconds ? `No log streams in the last ${windowWords(streamWindowSeconds)}.` : "This source lists no log streams yet."}
        </p>
      )}
      <div ref={scroller} className={s.list} role="listbox" tabIndex={0} aria-label={noun} aria-keyshortcuts="b"
        aria-activedescendant={activeRow >= 0 ? optionId(activeRow) : undefined} data-empty={rows.length === 0 ? "" : undefined}
        onKeyDown={onListKey}>
        <div className={s.space} style={{ height: virtualizer.getTotalSize() }}>
          {runs.map((run) => (
            <div key={run.key} className={s.run} role={run.group === null ? undefined : "group"} aria-label={run.group ?? undefined}
              style={{ transform: `translateY(${run.start}px)` }}>
              {run.rows.map((i) => {
                const row = rows[i];
                if (row.kind === "head") return <div key={row.key} className={s.head} aria-hidden="true">{row.label}</div>;
                return (
                  <div key={row.key} id={optionId(i)} role="option" className={s.option} aria-selected={isSelected(row)}
                    aria-posinset={options.indexOf(i) + 1} aria-setsize={options.length}
                    data-active={i === activeRow ? "true" : undefined}
                    onClick={() => { setActive(options.indexOf(i)); pickRow(i); }}>
                    {row.kind === "metric" ? (
                      <>
                        <span className={s.name} title={row.metric.help ?? undefined}>{row.metric.name}</span>
                        {" "}
                        <span className={s.type}>{row.metric.typeLabel}</span>
                      </>
                    ) : (
                      <span className={s.name}>{`${row.label} = ${row.value}`}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {!loading && !error && (
        <div className={s.footer}>
          {age && <span className={s.age}>{`Known ${mode === "metrics" ? "metrics" : "log streams"} from ${age}`}</span>}
          <button type="button" className={s.action} aria-disabled={refreshing || undefined} onClick={props.onRefresh}>
            {refreshing ? "Refreshing…" : "Refresh list"}
          </button>
          {refreshError && <span className={s.refreshError}>{`Couldn't refresh the list: ${refreshError}`}</span>}
        </div>
      )}
    </div>
  );
});
