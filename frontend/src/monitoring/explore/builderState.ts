// The point-and-click builder (X2): which metric or log stream is picked, how it is split and which
// label values it is narrowed to. The query text comes only from the Task 5 writers (F16); a name
// they refuse is never offered, so a pick that cannot be written leaves the text alone.

import type { OwnerStreamLabel } from "../catalog/merge";
import type { BrowseMetric } from "../catalog/metrics";
import { type Only, selectorText, SPLIT_LABELS, UnwritableQuery, writeLogQuery, writeMetricQuery } from "../build/writeQuery";

export type ExploreBuilder = {
  /** The picked metric's name; `null` when none (or in logs mode). */
  metric: string | null;
  /** Logs mode: the builder writes a stream selector. */
  stream: boolean;
  split: string | null;
  only: Only;
  /** The query was edited by hand after the chips wrote it. */
  detached: boolean;
};

export type BuilderAction =
  | { type: "pickMetric"; metric: BrowseMetric }
  | { type: "pickStream"; label: string; value: string }
  | { type: "split"; label: string | null }
  | { type: "only"; label: string; value: string | null }
  | { type: "typed" }
  | { type: "reset" };

export const EMPTY_BUILDER: ExploreBuilder = { metric: null, stream: false, split: null, only: {}, detached: false };

/** Whether a picked metric or stream is steering the query (the chips show). */
export const builderActive = (b: ExploreBuilder) => b.metric !== null || b.stream;

export function builderReducer(state: ExploreBuilder, action: BuilderAction): ExploreBuilder {
  switch (action.type) {
    case "pickMetric":
      return {
        metric: action.metric.name, stream: false, only: {}, detached: false,
        split: SPLIT_LABELS.find((l) => action.metric.labels.includes(l)) ?? null,
      };
    case "pickStream":
      return { metric: null, stream: true, split: null, only: { [action.label]: action.value }, detached: false };
    case "split": {
      if (action.label === null || action.label === state.split) return { ...state, split: null, detached: false };
      // Logs: the stream the list picked stays chosen, whatever the split.
      if (state.stream) return { ...state, split: action.label, detached: false };
      const { [action.label]: _gone, ...only } = state.only;
      return { ...state, split: action.label, only, detached: false };
    }
    case "only": {
      const { [action.label]: current, ...rest } = state.only;
      const next = action.value === null || action.value === current ? rest : { ...rest, [action.label]: action.value };
      return { ...state, only: next, detached: false };
    }
    case "typed":
      return state.detached ? state : { ...state, detached: true };
    case "reset":
      return EMPTY_BUILDER;
  }
}

/** The query the chips write; `null` when there is nothing to write or the writers refuse. */
export function builderQuery(state: ExploreBuilder, metrics: BrowseMetric[], streams: OwnerStreamLabel[]): string | null {
  try {
    if (state.stream) return writeLogQuery(state.only, streams);
    const m = state.metric === null ? undefined : metrics.find((x) => x.name === state.metric);
    return m ? writeMetricQuery(m, state.split, state.only) : null;
  } catch (err) {
    if (err instanceof UnwritableQuery) return null;
    throw err;
  }
}

/** The selector that finds a metric's label values: a family's series live under a suffix. */
export function metricMatch(m: BrowseMetric): string | null {
  const name = m.kind === "histogram" ? `${m.name}_bucket` : m.kind === "summary" ? `${m.name}_count` : m.name;
  try {
    return selectorText(name, {});
  } catch (err) {
    if (err instanceof UnwritableQuery) return null;
    throw err;
  }
}

/** A stream label the writers accept: anything else is never offered. */
export function writableLabel(name: string): boolean {
  try {
    writeLogQuery({ [name]: "x" }, []);
    return true;
  } catch {
    return false;
  }
}
