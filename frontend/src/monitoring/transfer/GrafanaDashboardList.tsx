// The dashboards of a Grafana as a checklist. `load` is a plain call (a connection as entered
// carries its token, which never becomes a query key), run again whenever `loadKey` changes. One
// checkbox at a time takes Tab; ↑/↓ move between them, Home/End jump, Space toggles. At most
// MAX_PICK dashboards can be picked for one import (F15).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { failure } from "../../api/http";
import type { GrafanaDashboardOut, GrafanaDashboardsOut } from "./api";
import { MAX_PICK, NO_MATCH, PICK_LIMIT } from "./grafanaLabels";
import s from "./GrafanaDashboardList.module.css";

export interface GrafanaDashboardListProps {
  load: () => Promise<GrafanaDashboardsOut>;
  loadKey: string;
  selected: ReadonlySet<string>;
  onChange(next: Set<string>): void;
  /** The Grafana's name, for the list's label. */
  name: string;
  /** Every dashboard starts selected (none when there are more than MAX_PICK). */
  defaultAll?: boolean;
}

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; data: GrafanaDashboardsOut };

const SHOW_FILTER_ABOVE = 10;

export function GrafanaDashboardList({ load, loadKey, selected, onChange, name, defaultAll = false }: GrafanaDashboardListProps) {
  const ids = useId();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const boxes = useRef(new Map<string, HTMLInputElement>());
  const tryAgain = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLParagraphElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const selectAllButton = useRef<HTMLButtonElement>(null);
  /** The keyboard was in here when a load began (Try again, or a new `loadKey`): it stays in here. */
  const keep = useRef(false);
  // The latest of these without making the load run again when they change.
  const latest = useRef({ load, onChange, selected, defaultAll });
  latest.current = { load, onChange, selected, defaultAll };

  useEffect(() => {
    let current = true;
    const active = document.activeElement;
    if (active && active !== document.body && root.current?.contains(active)) keep.current = true;
    setLoaded({ state: "loading" });
    latest.current.load().then(
      (data) => {
        if (!current) return;
        setLoaded({ state: "ready", data });
        const uids = data.items.map((d) => d.uid);
        const { selected: was, defaultAll: all, onChange: tell } = latest.current;
        if (all) tell(new Set(uids.length <= MAX_PICK ? uids : []));
        else {
          // What was picked and is still there stays picked.
          const kept = new Set(uids.filter((u) => was.has(u)));
          if (kept.size !== was.size) tell(kept);
        }
      },
      (err: unknown) => {
        if (current) setLoaded({ state: "failed", message: failure(err, "try again") });
      },
    );
    return () => { current = false; };
  }, [loadKey, attempt]);

  // A load the keyboard was in keeps it: on the loading note, then the first checkbox shown (or,
  // when a kept filter matches nothing, the filter; or the empty note, or Try again), never on
  // <body>.
  useLayoutEffect(() => {
    if (!keep.current) return;
    if (loaded.state === "loading") return note.current?.focus();
    keep.current = false;
    if (loaded.state === "failed") tryAgain.current?.focus();
    else (boxes.current.values().next().value ?? note.current ?? filterInput.current ?? selectAllButton.current)?.focus();
  }, [loaded.state]);

  const items = loaded.state === "ready" ? loaded.data.items : [];
  // The filter only applies while it is shown (a reload can bring a list too short for one).
  const filtering = items.length > SHOW_FILTER_ABOVE;
  const visible = useMemo(() => {
    const words = filtering ? filter.trim().toLowerCase() : "";
    if (!words) return items;
    return items.filter((d) => d.title.toLowerCase().includes(words) || (d.folder ?? "").toLowerCase().includes(words));
  }, [items, filter, filtering]);

  // The checkbox that takes Tab: the last one moved to, else the first shown.
  const tabStop = active !== null && visible.some((d) => d.uid === active) ? active : (visible[0]?.uid ?? null);

  const toggle = useCallback((uid: string) => {
    const next = new Set(selected);
    if (next.has(uid)) next.delete(uid);
    else if (next.size < MAX_PICK) next.add(uid);
    else return;
    onChange(next);
  }, [selected, onChange]);

  const selectAll = () => {
    const next = new Set(selected);
    for (const d of visible) {
      if (next.size >= MAX_PICK) break;
      next.add(d.uid);
    }
    onChange(next);
  };
  const selectNone = () => {
    const next = new Set(selected);
    for (const d of visible) next.delete(d.uid);
    onChange(next);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    if (visible.length === 0) return;
    e.preventDefault();
    const at = visible.findIndex((d) => boxes.current.get(d.uid) === document.activeElement);
    const last = visible.length - 1;
    const to = e.key === "Home" ? 0 : e.key === "End" ? last
      : e.key === "ArrowDown" ? Math.min(last, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
    const uid = visible[to].uid;
    setActive(uid);
    boxes.current.get(uid)?.focus();
  };

  return <div ref={root} className={s.root}>{body()}</div>;

  function body() {
    if (loaded.state === "loading") return <p ref={note} tabIndex={-1} className={s.note} role="status">Loading dashboards…</p>;
    if (loaded.state === "failed") {
      return (
        <div className={s.failed} role="alert">
          <p>{loaded.message}</p>
          <button ref={tryAgain} type="button" className={s.secondary} onClick={() => { keep.current = true; setAttempt((n) => n + 1); }}>
            Try again
          </button>
        </div>
      );
    }
    if (items.length === 0) return <p ref={note} tabIndex={-1} className={s.note}>This Grafana has no dashboards.</p>;
    return checklist(loaded.data);
  }

  function checklist(data: GrafanaDashboardsOut) {
    const capped = items.length > MAX_PICK;
    return (
      <div className={s.wrap}>
        <div className={s.tools}>
          <button ref={selectAllButton} type="button" className={s.quiet} onClick={selectAll}>Select all</button>
          <button type="button" className={s.quiet} onClick={selectNone}>Select none</button>
          {filtering && (
            <input ref={filterInput} className={s.filter} type="search" aria-label="Filter dashboards" placeholder="Filter dashboards" autoComplete="off"
              spellCheck={false} value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
        </div>
        {data.truncated && <p className={s.hint}>Showing the first 5000 dashboards.</p>}
        {capped && <p className={s.hint}>{PICK_LIMIT}</p>}
        {visible.length === 0 && <p className={s.hint} role="status">{NO_MATCH}</p>}
        <div className={s.list} role="group" aria-label={`Dashboards in ${name}`} onKeyDown={onKey} hidden={visible.length === 0}>
          {visible.map((d: GrafanaDashboardOut) => {
            const on = selected.has(d.uid);
            const full = !on && selected.size >= MAX_PICK;
            const base = `${ids}-${d.uid}`;
            return (
              <label key={d.uid} className={s.item} data-checked={on || undefined}>
                <input ref={(el) => { if (el) boxes.current.set(d.uid, el); else boxes.current.delete(d.uid); }}
                  type="checkbox" checked={on} tabIndex={d.uid === tabStop ? 0 : -1} aria-disabled={full || undefined}
                  aria-labelledby={`${base}-t`} aria-describedby={d.folder ? `${base}-f` : undefined}
                  onFocus={() => setActive(d.uid)} onChange={() => toggle(d.uid)} />
                <span id={`${base}-t`} className={s.title}>{d.title}</span>
                {d.folder && <span id={`${base}-f`} className={s.folder}>{d.folder}</span>}
              </label>
            );
          })}
        </div>
        <p className={s.count} aria-live="polite">{selected.size} selected</p>
      </div>
    );
  }
}
