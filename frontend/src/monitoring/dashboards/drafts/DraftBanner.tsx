// The draft a dashboard left behind, offered back when it opens; and, in edit mode, the line that
// says this browser isn't keeping drafts.
import { useId, type RefObject } from "react";
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

/** Said under the banner once Edit was pressed while the draft is still offered. */
export const CHOOSE_DRAFT = "Restore the draft or discard it before editing.";

export function DraftBanner({ draft, version, onRestore, onDiscard, restoreRef, asked = false }: {
  draft: StoredDraft;
  /** The dashboard's current saved version. */
  version: number;
  onRestore(): void;
  onDiscard(): void;
  restoreRef?: RefObject<HTMLButtonElement | null>;
  /** Edit was pressed: the banner says a choice comes first. */
  asked?: boolean;
}) {
  const askedId = useId();
  return (
    <div role="region" aria-label="Unsaved draft" className={s.banner}>
      <div className={s.bannerText}>
        <p className={s.line}>You have unsaved changes from {draftTime(draft.savedAt)}.</p>
        {draft.baseVersion < version && <p className={s.line}>The dashboard was saved again since then (version {version}).</p>}
        {asked && <p id={askedId} className={s.line}>{CHOOSE_DRAFT}</p>}
      </div>
      <div className={s.bannerActions}>
        <button ref={restoreRef} type="button" className={s.restore} aria-describedby={asked ? askedId : undefined} onClick={onRestore}>Restore draft</button>
        <button type="button" className={s.quiet} onClick={onDiscard}>Discard draft</button>
      </div>
    </div>
  );
}

export function DraftsOffNotice() {
  return <p className={s.off}>This browser isn't keeping drafts, so a reload loses unsaved changes.</p>;
}

/** Edit pressed while another tab in this window edits the same dashboard. */
export function EditedElsewhere({ onGo, buttonRef }: { onGo(): void; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <div role="status" className={s.elsewhere}>
      <p className={s.line}>This dashboard is being edited in another tab.</p>
      <button ref={buttonRef} type="button" className={s.quiet} onClick={onGo}>Go to that tab</button>
    </div>
  );
}
