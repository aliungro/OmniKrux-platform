// The label chips under the query bar (X2): Split by (one label) and Only (label values). A click
// rewrites the query through the builder and runs it; the keyboard stays on the chip. Values come
// from the source (`labelValues`, through the project's filter, narrowed by the values chosen so
// far) or, for logs, from the catalog's streams.
//
// The chips stay small and still (C11): at most eight values per label, then "{n} more", which
// opens the rest in place; labels that name one object each (`id`, `uid`, …) or have more than
// fifty values get no chips (they stay in the list). Which labels get a line, and in what order
// (most values first, then by name), is fixed once the values first arrive after a pick: choosing a
// value never moves a line, so the next click lands where it was aimed. The page remounts this
// component for each pick (`key`), which is what starts a new order.

import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { failure } from "../../api/http";
import { LEVEL_LABELS, type Only, SPLIT_LABELS, STATUS_LABELS } from "../build/writeQuery";
import type { BrowseMetric } from "../catalog/metrics";
import { labelValues } from "../dashboards/api";
import { metricMatch, type ExploreBuilder } from "./builderState";
import s from "./LabelChips.module.css";

export const SHOWN_VALUES = 8;
export const MAX_ONLY_LABELS = 6;
/** Past this many values a label is too fine to pick from: no chips. */
export const MAX_CHIP_VALUES = 50;
/** Labels that name one object each: never chips. */
const ID_LABELS = new Set(["id", "uid", "container_id", "image_id"]);
export const DETACHED_LINE = "You edited the query by hand. A chip now starts a new query from that chip.";

/** The labels people narrow by most, in this order, ahead of the alphabet. */
const WELL_KNOWN = ["namespace", "pod", "container", "job", "instance", "service", "node"];
const PREFERRED = [...WELL_KNOWN, ...SPLIT_LABELS, ...STATUS_LABELS, ...LEVEL_LABELS];
/** Chart and Kubernetes object labels (often one value each) go after every other label. */
const LAST = /^(app_kubernetes_io_|helm_sh_|label_)|_kubernetes_io_/;

/** A label that may have chips at all (by its name). */
export const chipLabel = (label: string) => !ID_LABELS.has(label);

/**
 * Which labels are worth reading values of, best first: labels the project's Loki streams also
 * have (they link the log lines), the well-known labels, the split, status and level labels, then
 * the rest alphabetically with chart and object labels last. The split label is left out; a label
 * with a chosen value past the first `max` is kept, so it can be turned off.
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

/** One Only line: its label, and whether it has too many values for chips (only a chosen one shows). */
type Line = { label: string; wide: boolean };

/**
 * The Only lines in their fixed order: most values first, then by name. A label without values
 * has no line; one too fine for chips keeps a line only while a value of it is chosen; one whose
 * values couldn't be read keeps its line (it says so, with Try again) after the others.
 */
export function arrangeLines(candidates: string[], counts: Map<string, number | null>, only: Only): Line[] {
  const lines: (Line & { n: number })[] = [];
  for (const label of candidates) {
    const n = counts.get(label) ?? null;
    const chosen = Object.hasOwn(only, label);
    const wide = !chipLabel(label) || (n !== null && n > MAX_CHIP_VALUES);
    if (n === 0 && !chosen) continue;
    if (wide && !chosen) continue;
    lines.push({ label, wide, n: n ?? -1 });
  }
  lines.sort((a, b) => b.n - a.n || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return lines.map(({ label, wide }) => ({ label, wide }));
}

const without = (only: Only, label: string): Only => {
  const { [label]: _own, ...rest } = only;
  return rest;
};

export interface LabelChipsProps {
  builder: ExploreBuilder;
  /** The labels to split by (the metric's, or the stream labels), already writable. */
  labels: string[];
  /** The labels the project's Loki streams have: they come first among the labels read. */
  loki: string[];
  /** Logs: each label's values from the catalog. Metrics: `null`, the values are read from the source. */
  known: Record<string, string[]> | null;
  /** Metrics: where and for which metric to read values. */
  read: { projectId: string; sourceId: string; metric: BrowseMetric; start: number; end: number } | null;
  /** `keyed`: picked with the keyboard (Enter or Space), an explicit run; a mouse click isn't. */
  onSplit(label: string | null, keyed?: boolean): void;
  onOnly(label: string, value: string | null, keyed?: boolean): void;
}

type Values = { values: string[]; loading: boolean; error: string | null };

export function LabelChips({ builder, labels, loki, known, read, onSplit, onOnly }: LabelChipsProps) {
  // The labels worth reading, fixed at the pick (a label chosen in the list is always one of them).
  const [candidates] = useState(() => rankOnlyLabels(
    labels.filter((l) => chipLabel(l) || Object.hasOwn(builder.only, l)),
    { only: builder.only, split: null, loki },
  ));
  // Each label's values are read under the other labels' chosen values (never its own, so its
  // other values stay offered); the last values stay while a new read is on its way.
  const reads = useQueries({
    queries: known !== null || read === null ? [] : candidates.map((label) => {
      const match = metricMatch(read.metric, without(builder.only, label)) ?? metricMatch(read.metric) ?? read.metric.name;
      const key = { projectId: read.projectId, sourceId: read.sourceId, match, start: read.start, end: read.end, label };
      return {
        queryKey: ["monitoring", "labelValues", key],
        queryFn: ({ signal }: { signal: AbortSignal }) => labelValues(key, signal),
        retry: false,
        placeholderData: keepPreviousData,
      };
    }),
  });
  const valuesOf = (label: string): Values => {
    if (known) return { values: (known[label] ?? []).filter((v) => v !== ""), loading: false, error: null };
    const r = reads[candidates.indexOf(label)];
    return {
      values: r?.data?.values ?? [],
      loading: read !== null && (r === undefined || r.isFetching),
      error: r?.error ? failure(r.error, "try again") : null,
    };
  };
  const retry = (label: string) => { void reads[candidates.indexOf(label)]?.refetch(); };

  // The order, fixed once every first read has answered, and the labels found too fine for chips.
  const [fixed, setFixed] = useState<{ lines: Line[]; wide: ReadonlySet<string> } | null>(null);
  const settled = known !== null || read === null || reads.every((r) => !r.isPending);
  if (fixed === null && settled) {
    const counts = new Map(candidates.map((l) => {
      const v = valuesOf(l);
      return [l, v.error ? null : v.values.length] as const;
    }));
    setFixed({
      lines: arrangeLines(candidates, counts, builder.only),
      wide: new Set(candidates.filter((l) => (counts.get(l) ?? 0) > MAX_CHIP_VALUES)),
    });
  }
  const lines = fixed?.lines ?? null;
  const tooWide = fixed?.wide ?? new Set<string>();

  // Lines (and the Split row) opened past their first eight values, and where the keyboard goes next.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const focusNext = useRef<{ set: string; at: number } | null>(null);
  useLayoutEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const set = [...(root.current?.querySelectorAll<HTMLElement>("[data-set]") ?? [])].find((el) => el.dataset.set === want.set);
    set?.querySelectorAll<HTMLElement>("button")[want.at]?.focus();
  });
  const open = (set: string) => {
    focusNext.current = { set, at: SHOWN_VALUES };
    setOpened((o) => new Set(o).add(set));
  };
  // A chip that goes away with the keyboard on it hands it to its line's "more", else to another
  // chip of its line. A line that goes with it (a label too fine for chips, kept only while a value
  // of it was chosen) hands it to the next line's first chip, else the one before, else the first
  // chip left: never to <body>.
  const keepFocusIn = (set: string, lineGoes: boolean) => {
    const sets = [...(root.current?.querySelectorAll<HTMLElement>("[data-set]") ?? [])];
    const at = sets.findIndex((x) => x.dataset.set === set);
    const el = sets[at];
    const firstOf = (x: HTMLElement | undefined) => x?.querySelector<HTMLElement>("button") ?? null;
    if (!lineGoes) {
      (el?.querySelector<HTMLElement>("[data-more]") ?? firstOf(el))?.focus();
      return;
    }
    const others = [...sets.slice(at + 1), ...sets.slice(0, Math.max(0, at)).reverse()];
    for (const x of others) {
      const b = firstOf(x);
      if (b) { b.focus(); return; }
    }
  };

  // A hand-edited query isn't what the chips say: none shows as pressed.
  const live = !builder.detached;
  // In logs the label picked from the list is the stream: splitting by it is not offered.
  const splitLabels = (builder.stream ? labels.filter((l) => !Object.hasOwn(builder.only, l)) : labels)
    .filter((l) => chipLabel(l) && !tooWide.has(l));
  const splitOpen = opened.has("\u0000split");
  const splitFirst = splitLabels.slice(0, SHOWN_VALUES);
  const splitShown = splitOpen ? splitLabels
    : builder.split !== null && splitLabels.includes(builder.split) && !splitFirst.includes(builder.split) ? [...splitFirst, builder.split] : splitFirst;
  // A label too fine for chips has a line only while a value of it is chosen.
  const onlyLines = (lines ?? []).filter((l) => l.label !== builder.split && (!l.wide || Object.hasOwn(builder.only, l.label)));
  const loadingAny = lines === null || candidates.some((l) => valuesOf(l).loading);

  return (
    <div ref={root} className={s.chips}>
      {/* Log lines aren't split: a log query lists its lines and has no chart to split. */}
      {!builder.stream && splitLabels.length > 0 && (
        <div className={s.row} role="group" aria-label="Split by">
          <span className={s.label} aria-hidden="true">Split by</span>
          <span className={s.set} data-set={"\u0000split"}>
            {splitShown.map((l) => (
              <button key={l} type="button" className={s.chip} title={l} aria-pressed={live && builder.split === l} onClick={(e) => onSplit(l, e.detail === 0)}>{l}</button>
            ))}
            {!splitOpen && splitLabels.length > SHOWN_VALUES && (
              <button type="button" className={`${s.chip} ${s.more}`} data-more="" aria-expanded="false" onClick={() => open("\u0000split")}>
                {`${splitLabels.length - SHOWN_VALUES} more`}
              </button>
            )}
          </span>
        </div>
      )}
      {lines === null && candidates.length > 0 && <p className={s.muted}>Loading values…</p>}
      {onlyLines.length > 0 && (
        <div className={s.row} role="group" aria-label="Only">
          <span className={s.label} aria-hidden="true">Only</span>
          <span className={s.sets}>
            {onlyLines.map(({ label, wide }) => {
              const { values, error } = valuesOf(label);
              const chosen = Object.hasOwn(builder.only, label) ? builder.only[label] : undefined;
              const all = opened.has(label);
              const first = wide ? [] : all ? values : values.slice(0, SHOWN_VALUES);
              // A chosen value outside the ones shown stays in view as a chip of its own.
              const shown = chosen !== undefined && !first.includes(chosen) ? [...first, chosen] : first;
              return (
                <span key={label} className={s.set} data-label={label} data-set={label}>
                  {shown.map((v) => (
                    <button key={v} type="button" className={s.chip} title={`${label}=${v}`} aria-pressed={live && chosen === v}
                      onClick={(e) => {
                        // A value shown only because it was chosen has no chip once it is off.
                        if (live && chosen === v && !first.includes(v)) keepFocusIn(label, wide);
                        onOnly(label, v, e.detail === 0);
                      }}>{`${label}=${v}`}</button>
                  ))}
                  {!wide && !all && values.length > SHOWN_VALUES && (
                    <button type="button" className={`${s.chip} ${s.more}`} data-more="" aria-expanded="false"
                      title={`${label}: ${values.length - SHOWN_VALUES} more values`}
                      onClick={() => open(label)}>
                      {`${values.length - SHOWN_VALUES} more`}
                    </button>
                  )}
                  {error && (
                    <span className={s.muted}>
                      {`${label}: couldn't read its values: ${error} `}
                      <button type="button" className={s.chip} onClick={() => retry(label)}>Try again</button>
                    </span>
                  )}
                </span>
              );
            })}
            {lines !== null && loadingAny && <span className={s.muted}>Loading values…</span>}
          </span>
        </div>
      )}
      {builder.detached && <p className={s.detached}>{DETACHED_LINE}</p>}
    </div>
  );
}
