// One candidate panel with a small live chart of what it would show. The chart is in the lazy
// chart chunk; the words (loading, no data, why it failed) are here so they never wait for it.

import { lazy, Suspense } from "react";
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
  onPick(rect: DOMRect): void;
}

const hasData = (p: Extract<PreviewState, { status: "done" }>) => p.data.series.length > 0 || p.data.logs.length > 0;

function Loading({ reduced }: { reduced: boolean }) {
  return (
    <div className={reduced ? styles.loadingStatic : styles.loading} role="status">
      <span className={styles.loadingText}>Loading…</span>
    </div>
  );
}

export default function PreviewCard({ candidate, preview, active, added = false, id, onPick }: PreviewCardProps) {
  const reduced = usePrefersReducedMotion();
  let body = null;
  if (preview?.status === "loading") body = <Loading reduced={reduced} />;
  else if (preview?.status === "failed") body = <p className={styles.note}>Can't preview: {preview.message}</p>;
  else if (preview?.status === "done") {
    body = hasData(preview) ? (
      <Suspense fallback={<Loading reduced={reduced} />}>
        <MiniChart data={preview.data} panelType={candidate.panelType} unit={candidate.unit} animate={!reduced} />
      </Suspense>
    ) : (
      <p className={styles.note}>No data in this time range.</p>
    );
  }
  return (
    <button
      type="button"
      id={id}
      className={styles.card}
      data-active={active ? "true" : undefined}
      data-added={added ? "true" : undefined}
      onClick={(e) => onPick(e.currentTarget.getBoundingClientRect())}
    >
      <span className={styles.title}>{candidate.title}</span>
      <span className={styles.query} title={candidate.expr}>{candidate.expr}</span>
      <span className={styles.preview}>{body}</span>
      {added ? <span className={styles.badge}>Added</span> : active ? <span className={styles.badge}>Enter to add</span> : null}
    </button>
  );
}
