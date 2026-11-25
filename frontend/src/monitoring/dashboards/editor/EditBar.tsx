// The header in edit mode: the Editing pill, Undo, Variables, Suggestions, Discard and Save dashboard; under it,
// why a save didn't go through and what a removal took away; and the question before discarding changes.
import { useId, useRef, type RefObject } from "react";
import { failure } from "../../../api/http";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import type { DashboardRequestError } from "../api";
import s from "./EditBar.module.css";

export function EditingPill() {
  return <span className={s.pill}>Editing</span>;
}

export function EditControls({ saving, onDiscard, onSave, discardRef, saveRef, suggestions, suggestionsRef, undo, variables }: {
  saving: boolean;
  onDiscard(): void;
  onSave(): void;
  discardRef: RefObject<HTMLButtonElement | null>;
  saveRef: RefObject<HTMLButtonElement | null>;
  /** Shows or hides the suggestions column (not a draft edit, so it works while saving too). */
  suggestions?: { open: boolean; onToggle(): void };
  suggestionsRef?: RefObject<HTMLButtonElement | null>;
  /** Undo: `can` is false when nothing in the session is left to undo (it says so, and stays). */
  undo?: { can: boolean; onUndo(): void };
  /** Opens the variables editor. */
  variables?: { onOpen(): void; buttonRef: RefObject<HTMLButtonElement | null> };
}) {
  return (
    <>
      {undo && (
        <button type="button" className={s.undo} aria-keyshortcuts="Control+Z" aria-disabled={!undo.can || undefined}
          onClick={undo.onUndo}>
          Undo
        </button>
      )}
      {variables && (
        <button ref={variables.buttonRef} type="button" className={s.toggle} aria-haspopup="dialog" onClick={variables.onOpen}>
          Variables
        </button>
      )}
      {suggestions && (
        <button ref={suggestionsRef} type="button" className={s.toggle} aria-pressed={suggestions.open}
          aria-keyshortcuts="s" onClick={suggestions.onToggle}>
          Suggestions
        </button>
      )}
      <button ref={discardRef} type="button" className={s.discard} aria-disabled={saving || undefined}
        onClick={() => { if (!saving) onDiscard(); }}>
        Discard
      </button>
      <button ref={saveRef} type="button" className={s.save} aria-keyshortcuts="Control+S" aria-disabled={saving || undefined}
        aria-busy={saving || undefined} onClick={() => { if (!saving) onSave(); }}>
        Save dashboard
      </button>
    </>
  );
}

/** Under the header after a removal: what went, and Undo (gone after the next edit or 10 s). */
export function RemovedNote({ title, onUndo }: { title: string; onUndo(): void }) {
  return (
    // Not spoken: the grid's live region already says it once ("… Ctrl+Z brings it back.").
    <div className={s.removed} role="status" aria-live="off">
      <p className={s.removedLine}>Removed "{title}".</p>
      <button type="button" className={s.removedUndo} onClick={onUndo}>Undo</button>
    </div>
  );
}

const SHOWN_PROBLEMS = 3;

/** A save that didn't go through, other than a version conflict (SaveConflict says that one). */
export function EditNotice({ error, onShowJson, actionRef }: {
  error: DashboardRequestError;
  onShowJson(): void;
  actionRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { problems } = error;
  const more = problems.length - SHOWN_PROBLEMS;
  return (
    <div className={s.notice} role="alert">
      <div className={s.noticeText}>
        <p className={s.noticeLine}>{failure(error, "save again")}</p>
        {problems.length > 0 && (
          <ul className={s.problems}>
            {problems.slice(0, SHOWN_PROBLEMS).map((p) => (
              <li key={`${p.path}:${p.message}`} className={s.problem}>
                {p.path && <code className={s.path}>{p.path}</code>} {p.message}
              </li>
            ))}
            {more > 0 && <li className={s.problem}>{more === 1 ? "1 more problem" : `${more} more problems`} on the JSON tab.</li>}
          </ul>
        )}
      </div>
      {problems.length > 0 && <button ref={actionRef} type="button" className={s.noticeAction} onClick={onShowJson}>Show in JSON</button>}
    </div>
  );
}

/** Asked before Discard drops changes: focus on Discard changes, Ctrl+Enter confirms, Esc cancels. */
export function DiscardDialog({ title, onCancel, onDiscard, restoreFocusTo }: {
  title: string;
  onCancel(): void;
  onDiscard(): void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const go = useRef<HTMLButtonElement>(null);
  return (
    <DialogShell provider="monitoring" busy={false} onCancel={onCancel} onConfirm={onDiscard} first={go}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>Discard your changes to "{title}"?</h2>
      <div className={s.dialogActions}>
        <button type="button" className={s.secondary} onClick={onCancel}>Cancel</button>
        <button ref={go} type="button" className={s.danger} onClick={onDiscard}>Discard changes</button>
      </div>
    </DialogShell>
  );
}
