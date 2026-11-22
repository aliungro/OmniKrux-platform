// One candidate panel with a small live chart of what it would show. The chart is in the lazy
// chart chunk; the words (loading, no data, why it failed) are here so they never wait for it.
// A card is a button, or (`option`) an option of a listbox whose keyboard stays in its search
// field. Its content is phrasing only, and it has no live region of its own: the list it is in
// says what changed, once.

import { lazy, Suspense, type MouseEvent } from "react";
import { usePrefersReducedMotion } from "../dashboards/motion";
import type { Candidate } from "./candidates";
import type { PreviewState } from "./usePreviews";
import styles from "./PreviewCard.module.css";

const MiniChart = lazy(() => import("../charts").then((m) => ({ default: m.MiniChart })));

export interface PreviewCardProps {
  candidate: Candidate;
  preview: PreviewState | undefined;
  active: boolean;
  added?: boolean;
  id?: string;
  /** An option of a listbox (`aria-activedescendant` points at it) rather than a button. */
  option?: boolean;
  onPick(rect: DOMRect): void;
}

const hasData = (p: Extract<PreviewState, { status: "done" }>) => p.data.series.length > 0 || p.data.logs.length > 0;

function Loading({ reduced }: { reduced: boolean }) {
  return (
    <span className={reduced ? styles.loadingStatic : styles.loading}>
      <span className={styles.loadingText}>Loading…</span>
    </span>
  );
}

export default function PreviewCard({ candidate, preview, active, added = false, id, option = false, onPick }: PreviewCardProps) {
  const reduced = usePrefersReducedMotion();
  let body = null;
  if (preview?.status === "loading") body = <Loading reduced={reduced} />;
  else if (preview?.status === "failed") body = <span className={styles.note}>Can't preview: {preview.message}</span>;
  else if (preview?.status === "done") {
    body = hasData(preview) ? (
      <Suspense fallback={<Loading reduced={reduced} />}>
        <MiniChart data={preview.data} panelType={candidate.panelType} unit={candidate.unit} animate={!reduced} />
      </Suspense>
    ) : (
      <span className={styles.note}>No data in this time range.</span>
    );
  }
  const content = (
    <>
      <span className={styles.title} id={id ? `${id}-t` : undefined}>{candidate.title}</span>
      <span className={styles.query} id={id ? `${id}-q` : undefined} title={candidate.expr}>{candidate.expr}</span>
      <span className={styles.preview}>{body}</span>
      {added ? <span className={styles.badge}>Added</span> : active ? <span className={styles.badge}>Enter to add</span> : null}
    </>
  );
  const pick = (e: MouseEvent<HTMLElement>) => onPick(e.currentTarget.getBoundingClientRect());
  if (option) {
    return (
      <div role="option" id={id} aria-selected={active} aria-labelledby={id ? `${id}-t` : undefined}
        aria-describedby={id ? `${id}-q` : undefined} className={styles.card}
        data-active={active ? "true" : undefined} data-added={added ? "true" : undefined}
        // The keyboard stays in the search field; a click only picks.
        onMouseDown={(e) => e.preventDefault()} onClick={pick}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      id={id}
      className={styles.card}
      data-active={active ? "true" : undefined}
      data-added={added ? "true" : undefined}
      onClick={pick}
    >
      {content}
    </button>
  );
}
