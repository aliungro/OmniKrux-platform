// The label chips under the query bar (X2): Split by (one label) and Only (label values). A click
// rewrites the query through the builder and runs it; the keyboard stays on the chip. Values come
// from the source (`labelValues`, through the project's filter) or, for logs, from the catalog's
// streams. A label with more than eight values has a "more…" popover to find the rest.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQueries } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { labelValues } from "../dashboards/api";
import { escapeCloses } from "../focus";
import type { ExploreBuilder } from "./builderState";
import s from "./LabelChips.module.css";

export const SHOWN_VALUES = 8;
export const MAX_ONLY_LABELS = 6;
const POPOVER_VALUES = 100;
export const DETACHED_LINE = "You edited the query by hand. Clicking a chip writes it again from the chips.";

export interface LabelChipsProps {
  builder: ExploreBuilder;
  /** The labels to split by (the metric's, or the stream labels), already writable. */
  labels: string[];
  /** Logs: each label's values from the catalog. Metrics: `null`, the values are read from the source. */
  known: Record<string, string[]> | null;
  /** Metrics: where and what to read values of. */
  read: { projectId: string; sourceId: string; match: string; start: number; end: number } | null;
  onSplit(label: string | null): void;
  onOnly(label: string, value: string | null): void;
}

type Values = { values: string[]; loading: boolean; error: string | null };

export function LabelChips({ builder, labels, known, read, onSplit, onOnly }: LabelChipsProps) {
  const onlyLabels = labels.filter((l) => l !== builder.split).slice(0, MAX_ONLY_LABELS);
  const reads = useQueries({
    queries: onlyLabels.map((label) => ({
      queryKey: ["monitoring", "labelValues", read && { ...read, label }],
      queryFn: ({ signal }: { signal: AbortSignal }) => labelValues({ ...(read as NonNullable<typeof read>), label }, signal),
      enabled: known === null && read !== null,
      retry: false,
    })),
  });
  const valuesOf = (label: string, i: number): Values => {
    if (known) return { values: (known[label] ?? []).filter((v) => v !== ""), loading: false, error: null };
    const r = reads[i];
    return {
      values: r?.data?.values ?? [],
      loading: read !== null && (r === undefined || r.isPending),
      error: r?.error ? failure(r.error, "try again") : null,
    };
  };
  const all = onlyLabels.map(valuesOf);
  const loadingAny = all.some((v) => v.loading);

  // The "more…" popover that is open (one at a time), and the chip the keyboard goes back to.
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const chipOf = (label: string) => [...(root.current?.querySelectorAll<HTMLElement>("[data-more]") ?? [])].find((el) => el.dataset.more === label) ?? null;
  const close = (label: string, restore = true) => {
    setOpen(null);
    if (restore) queueMicrotask(() => chipOf(label)?.focus());
  };
  useEffect(() => {
    if (open === null) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(null); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  return (
    <div ref={root} className={s.chips}>
      <div className={s.row} role="group" aria-label="Split by">
        <span className={s.label} aria-hidden="true">Split by</span>
        {labels.map((l) => (
          <button key={l} type="button" className={s.chip} aria-pressed={builder.split === l} onClick={() => onSplit(l)}>{l}</button>
        ))}
      </div>
      {onlyLabels.length > 0 && (
        <div className={s.row} role="group" aria-label="Only">
          <span className={s.label} aria-hidden="true">Only</span>
          {onlyLabels.map((label, i) => {
            const { values, error } = all[i];
            const chosen = builder.only[label];
            const first = values.slice(0, SHOWN_VALUES);
            // A value picked from the popover stays in view as a chip of its own.
            const shown = chosen !== undefined && !first.includes(chosen) ? [...first, chosen] : first;
            return (
              <span key={label} className={s.set} data-label={label}>
                {shown.map((v) => (
                  <button key={v} type="button" className={s.chip} aria-pressed={chosen === v} onClick={() => onOnly(label, v)}>{`${label}=${v}`}</button>
                ))}
                {values.length > SHOWN_VALUES && (
                  <button type="button" className={`${s.chip} ${s.more}`} data-more={label} aria-haspopup="listbox"
                    aria-expanded={open === label} onClick={() => setOpen(open === label ? null : label)}>
                    {`${label}: more…`}
                  </button>
                )}
                {error && <span className={s.muted}>{`${label}: couldn't read its values`}</span>}
                {open === label && (
                  <ValuesPopover label={label} values={values} chosen={chosen}
                    onPick={(v) => { onOnly(label, v); close(label); }} onClose={() => close(label)} />
                )}
              </span>
            );
          })}
          {loadingAny && <span className={s.muted}>Loading values…</span>}
        </div>
      )}
      {builder.detached && <p className={s.detached}>{DETACHED_LINE}</p>}
    </div>
  );
}

function ValuesPopover({ label, values, chosen, onPick, onClose }: {
  label: string; values: string[]; chosen: string | undefined; onPick(v: string): void; onClose(): void;
}) {
  const uid = useId();
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => { field.current?.focus(); }, []);
  const found = useMemo(() => {
    const needle = text.trim().toLocaleLowerCase();
    const hits = needle === "" ? values : values.filter((v) => v.toLocaleLowerCase().includes(needle));
    return hits.slice(0, POPOVER_VALUES);
  }, [values, text]);
  const at = Math.min(active, Math.max(0, found.length - 1));
  const id = (i: number) => `${uid}-v${i}`;
  useEffect(() => { document.getElementById(id(at))?.scrollIntoView?.({ block: "nearest" }); }); // eslint-disable-line react-hooks/exhaustive-deps

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(found.length - 1, at + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, at - 1)); }
    else if (e.key === "Enter" && found[at] !== undefined) { e.preventDefault(); onPick(found[at]); }
  };
  return (
    <div className={s.popover} onKeyDown={escapeCloses(onClose)}>
      <input ref={field} className={s.find} type="text" autoComplete="off" spellCheck={false} role="combobox"
        aria-label="Filter values" aria-expanded="true" aria-controls={`${uid}-list`}
        aria-activedescendant={found.length > 0 ? id(at) : undefined} placeholder="Filter values"
        value={text} onChange={(e) => { setText(e.target.value); setActive(0); }} onKeyDown={onKey} />
      <div ref={list} id={`${uid}-list`} className={s.values} role="listbox" aria-label={`${label} values`}>
        {found.map((v, i) => (
          <div key={v} id={id(i)} role="option" className={s.value} aria-selected={chosen === v}
            data-active={i === at ? "true" : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(v)}>
            {v}
          </div>
        ))}
        {found.length === 0 && <p className={s.muted}>Nothing matches that.</p>}
      </div>
    </div>
  );
}
