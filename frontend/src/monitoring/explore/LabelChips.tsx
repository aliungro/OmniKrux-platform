// The label chips under the query bar (X2): Split by (one label) and Only (label values). A click
// rewrites the query through the builder and runs it; the keyboard stays on the chip. Values come
// from the source (`labelValues`, through the project's filter) or, for logs, from the catalog's
// streams. A label with more than eight values has a "more…" popover to find the rest.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQueries } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { LEVEL_LABELS, type Only, SPLIT_LABELS, STATUS_LABELS } from "../build/writeQuery";
import { labelValues } from "../dashboards/api";
import { escapeCloses } from "../focus";
import type { ExploreBuilder } from "./builderState";
import s from "./LabelChips.module.css";

export const SHOWN_VALUES = 8;
export const MAX_ONLY_LABELS = 6;
const POPOVER_VALUES = 100;
export const DETACHED_LINE = "You edited the query by hand. Clicking a chip writes it again from the chips.";

/** The labels people narrow by most, in this order, ahead of the alphabet. */
const WELL_KNOWN = ["namespace", "pod", "container", "job", "instance", "service", "node"];
const PREFERRED = [...WELL_KNOWN, ...SPLIT_LABELS, ...STATUS_LABELS, ...LEVEL_LABELS];
/** Chart and Kubernetes object labels (often one value each) go after every other label. */
const LAST = /^(app_kubernetes_io_|helm_sh_|label_)|_kubernetes_io_/;

/**
 * Which labels get Only chips, best first: labels the project's Loki streams also have (they link
 * the log lines), the well-known labels, the split, status and level labels, then the rest
 * alphabetically with chart and object labels last. The split label is never an Only chip.
 * Choosing a value never reorders the rows (a moved row would drop the keyboard): a label with a
 * chosen value past the first `max` is shown too, in its place after them, so it can be turned off.
 */
export function rankOnlyLabels(
  labels: string[],
  { only, split, loki }: { only: Only; split: string | null; loki: string[] },
  max = MAX_ONLY_LABELS,
): string[] {
  const inLoki = new Set(loki);
  const base = (l: string) => {
    const at = PREFERRED.indexOf(l);
    return at !== -1 ? at : PREFERRED.length + (LAST.test(l) ? 1 : 0);
  };
  const tier = (l: string) => (inLoki.has(l) ? 0 : 1);
  const order = (a: string, b: string) =>
    tier(a) - tier(b) || base(a) - base(b) || (a < b ? -1 : a > b ? 1 : 0);
  return labels
    .filter((l) => l !== split)
    .sort(order)
    .filter((l, i) => i < max || Object.hasOwn(only, l));
}

export interface LabelChipsProps {
  builder: ExploreBuilder;
  /** The labels to split by (the metric's, or the stream labels), already writable. */
  labels: string[];
  /** The labels the project's Loki streams have: they come first under Only. */
  loki: string[];
  /** Logs: each label's values from the catalog. Metrics: `null`, the values are read from the source. */
  known: Record<string, string[]> | null;
  /** Metrics: where and what to read values of. */
  read: { projectId: string; sourceId: string; match: string; start: number; end: number } | null;
  onSplit(label: string | null): void;
  onOnly(label: string, value: string | null): void;
}

type Values = { values: string[]; loading: boolean; error: string | null };

export function LabelChips({ builder, labels, loki, known, read, onSplit, onOnly }: LabelChipsProps) {
  const onlyLabels = rankOnlyLabels(labels, { only: builder.only, split: builder.split, loki });
  // In logs the label picked from the list is the stream: splitting by it is not offered.
  const splitLabels = builder.stream ? labels.filter((l) => !Object.hasOwn(builder.only, l)) : labels;
  // Logs know their values from the catalog and read nothing; a metric reads one label per query.
  const reads = useQueries({
    queries: known !== null || read === null ? [] : onlyLabels.map((label) => ({
      queryKey: ["monitoring", "labelValues", { ...read, label }],
      queryFn: ({ signal }: { signal: AbortSignal }) => labelValues({ ...read, label }, signal),
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
  const retry = (i: number) => { void reads[i]?.refetch(); };
  // A chip that goes away with the keyboard on it hands it to its row's "more…", else its first chip.
  const keepFocusIn = (label: string) => {
    const mine = [...(root.current?.querySelectorAll<HTMLElement>("[data-label]") ?? [])].find((el) => el.dataset.label === label);
    (chipOf(label) ?? mine?.querySelector<HTMLElement>("button"))?.focus();
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
      {/* Log lines aren't split: a log query lists its lines and has no chart to split. */}
      {!builder.stream && (
        <div className={s.row} role="group" aria-label="Split by">
          <span className={s.label} aria-hidden="true">Split by</span>
          {splitLabels.map((l) => (
            <button key={l} type="button" className={s.chip} aria-pressed={builder.split === l} onClick={() => onSplit(l)}>{l}</button>
          ))}
        </div>
      )}
      {onlyLabels.length > 0 && (
        <div className={s.row} role="group" aria-label="Only">
          <span className={s.label} aria-hidden="true">Only</span>
          {onlyLabels.map((label, i) => {
            const { values, error } = all[i];
            const chosen = Object.hasOwn(builder.only, label) ? builder.only[label] : undefined;
            const first = values.slice(0, SHOWN_VALUES);
            // A value picked from the popover stays in view as a chip of its own.
            const shown = chosen !== undefined && !first.includes(chosen) ? [...first, chosen] : first;
            return (
              <span key={label} className={s.set} data-label={label}>
                {shown.map((v) => (
                  <button key={v} type="button" className={s.chip} aria-pressed={chosen === v}
                    onClick={() => {
                      // A value picked from the popover has no chip once it is off.
                      if (chosen === v && !first.includes(v)) keepFocusIn(label);
                      onOnly(label, v);
                    }}>{`${label}=${v}`}</button>
                ))}
                {values.length > SHOWN_VALUES && (
                  <button type="button" className={`${s.chip} ${s.more}`} data-more={label} aria-haspopup="listbox"
                    aria-expanded={open === label} onClick={() => setOpen(open === label ? null : label)}>
                    {`${label}: more…`}
                  </button>
                )}
                {error && (
                  <span className={s.muted}>
                    {`${label}: couldn't read its values: ${error} `}
                    <button type="button" className={s.chip} onClick={() => retry(i)}>Try again</button>
                  </span>
                )}
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
  useEffect(() => { document.getElementById(`${uid}-v${at}`)?.scrollIntoView?.({ block: "nearest" }); });

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
