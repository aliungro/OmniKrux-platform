// What a panel says instead of a chart: waiting, no query, no data, or why it failed.
import s from "./DashboardGrid.module.css";

export const PANEL_COPY = {
  loading: "Loading…",
  noQuery: "This panel has no query yet.",
  empty: "No data in this time range.",
  unreachable: "Source unreachable",
  error: "Query error",
} as const;

/** A quiet one-line state: loading, no query, no data. */
export function PanelNote({ text, busy = false }: { text: string; busy?: boolean }) {
  return (
    <div className={s.note} aria-busy={busy || undefined}>
      <p className={s.noteText}>{text}</p>
    </div>
  );
}

/** A failure: what kind, the first reason in the tool's or OmniKrux's words, and Try again when it may pass. */
export function PanelFailure({ kind, reason, onRetry }: { kind: "unreachable" | "error"; reason: string | undefined; onRetry?(): void }) {
  return (
    <div className={s.failure} data-kind={kind}>
      <h3 className={s.failureTitle}>{PANEL_COPY[kind]}</h3>
      {reason && <p className={s.failureReason}>{reason}</p>}
      {onRetry && <button type="button" className={s.retry} onClick={onRetry}>Try again</button>}
    </div>
  );
}
