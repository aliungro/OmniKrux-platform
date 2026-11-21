// The draft a dashboard left behind, offered back when it opens; and, in edit mode, the line that
// says this browser isn't keeping drafts.
import type { RefObject } from "react";
import type { StoredDraft } from "./draftStore";
import s from "./Drafts.module.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** HH:MM today, else D Mon HH:MM (local time). */
export function draftTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? time : `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

export function DraftBanner({ draft, version, onRestore, onDiscard, restoreRef }: {
  draft: StoredDraft;
  /** The dashboard's current saved version. */
  version: number;
  onRestore(): void;
  onDiscard(): void;
  restoreRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div role="region" aria-label="Unsaved draft" className={s.banner}>
      <div className={s.bannerText}>
        <p className={s.line}>You have unsaved changes from {draftTime(draft.savedAt)}.</p>
        {draft.baseVersion < version && <p className={s.line}>The dashboard was saved again since then (version {version}).</p>}
      </div>
      <div className={s.bannerActions}>
        <button ref={restoreRef} type="button" className={s.restore} onClick={onRestore}>Restore draft</button>
        <button type="button" className={s.quiet} onClick={onDiscard}>Discard draft</button>
      </div>
    </div>
  );
}

export function DraftsOffNotice() {
  return <p className={s.off}>This browser isn't keeping drafts, so a reload loses unsaved changes.</p>;
}
