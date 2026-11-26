// The JSON tab: the dashboard as its document, in CodeMirror (loaded with the tab, not the page).
// Typing applies live: 150 ms after the last keystroke the text is checked (the editor reducer's
// `setJson`), and a valid document becomes the draft; an invalid one is kept as text with its
// problems while the dashboard keeps the last valid version. Typing outside edit mode starts it.
//
// The kit can't replace an editor's text, so the editor is mounted again (a key on a revision)
// whenever the draft changes from outside it: Discard, a save, a restored draft or version, and
// coming back from another tab. Its own changes never remount it, so the cursor stays put.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { EDITOR_UNAVAILABLE, loadCodeMirror, type EditorKeys, type MountedEditor } from "../../../features/actions/lazyCodeMirror";
import { isMac, keysFor } from "../../../features/chrome/shortcuts";
import k from "../../../features/chrome/key.module.css";
import type { DashboardOut } from "../api";
import { isDirty, sameJson, type EditingState, type EditorAction, type EditorState } from "../editor/editorState";
import { dashboardJson, type DashboardSpec, type Problem } from "../schema";
import { ReviewChanges } from "./ReviewChanges";
import s from "./JsonTab.module.css";

/** How long typing must pause before the text is checked and applied. */
export const JSON_DEBOUNCE_MS = 150;
export const JSON_LABEL = "Dashboard JSON";

/** The keyboard is nowhere: on <body>, or on something that just went away. */
const focusLost = () => { const a = document.activeElement; return a === null || a === document.body || !a.isConnected; };
const canReview = (st: EditorState | null): boolean => st?.mode === "edit" && st.jsonProblems.length === 0 && isDirty(st);

const PREFIX = "Not valid JSON: ";

/**
 * A parser's complaint in plain words, with where it is when the parser says (V8's `position N
 * (line L column C)` or Firefox's `line L column C`; a bare `position N` needs `text` to find the
 * line). Other problems (a message that isn't "Not valid JSON: …") are returned as they are.
 */
export function jsonWords(raw: string, text?: string): string {
  if (!raw.startsWith(PREFIX)) return raw;
  const said = raw.slice(PREFIX.length);
  let at: { line: number; column: number } | null = null;
  const both = /line (\d+) column (\d+)/.exec(said);
  const position = /position (\d+)/.exec(said);
  if (both) at = { line: Number(both[1]), column: Number(both[2]) };
  else if (position && text !== undefined) {
    const head = text.slice(0, Number(position[1]));
    const lines = head.split("\n");
    at = { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  const atEnd = position !== null && text !== undefined && Number(position[1]) >= text.trimEnd().length;
  const plain = /expected (double-quoted )?property name/i.test(said) ? "a property name needs double quotes"
    : /unexpected end of (JSON input|data)|unterminated/i.test(said) || atEnd ? "the text ends too early"
    : /unexpected (token|character)/i.test(said) ? "a character doesn't belong there"
    : "it doesn't read as JSON";
  return at ? `Not valid JSON at line ${at.line}, column ${at.column}: ${plain}.` : `Not valid JSON: ${plain}.`;
}

/** One problem as a line: its path, then its words. */
const problemLine = (p: Problem, text?: string) => (p.path ? `${p.path}: ${p.message}` : jsonWords(p.message, text));

/** A ready-made view's document: read-only, with Copy to edit (the header's; absent while it runs). */
export function ReadyMadeJson({ spec, onCopy }: { spec: DashboardSpec; onCopy?(): void }) {
  return (
    <div className={s.frame}>
      <div className={s.bar}>
        <p className={s.state}>Read-only</p>
        <span className={s.push} />
        <button type="button" className={s.btn} aria-disabled={onCopy ? undefined : true} onClick={() => onCopy?.()}>Copy to edit</button>
      </div>
      <pre className={s.code} aria-label={JSON_LABEL} tabIndex={0}>{dashboardJson(spec)}</pre>
    </div>
  );
}

interface Props {
  dashboard: DashboardOut;
  /** This tab's edit session, or null outside edit mode. */
  editing: EditingState | null;
  dispatch(action: EditorAction): EditorState;
  /** Edit mode for typing outside it. False: it didn't start (another tab edits it; the page says so). */
  onStartEditing(): boolean;
  /** Task 14's save (conflicts included). */
  onSave(): Promise<void>;
  /** What this tab's last save answered: the saved side before the dashboard query catches up. */
  lastSaved: DashboardOut | null;
  /** The toolbar's Discard (edit mode's only one): Esc leaves the editor for it while there is nothing to review. */
  discardRef: RefObject<HTMLButtonElement | null>;
  /** Rises each time a save was refused for text that doesn't apply: the inline problem takes the keyboard. */
  problemFocus: number;
  saving: boolean;
  /** Set by this tab: applies typing still waiting for its pause, and returns the state it made. */
  flushRef: { current: (() => EditorState | null) | null };
}

export function JsonTab({ dashboard, editing, dispatch, onStartEditing, onSave, lastSaved, discardRef, problemFocus, saving, flushRef }: Props) {
  const ownerKind = dashboard.owner_kind;
  // What the editor shows: the draft (or its invalid text) while editing, the saved document
  // otherwise. Right after a save the dashboard query hasn't caught up yet: the save's answer is
  // the saved document (so the editor isn't replaced by the older one under your typing).
  const saved = lastSaved && lastSaved.id === dashboard.id && lastSaved.version > dashboard.version ? lastSaved.spec : dashboard.spec;
  const shown = editing ? editing.draft : saved;
  const shownText = editing ? editing.jsonText : null;

  // The draft this editor's own typing made last: seeing it come back is no reason to remount.
  const echo = useRef<{ draft: DashboardSpec; jsonText: string | null } | null>(null);
  const [mount, setMount] = useState({ draft: shown, jsonText: shownText, rev: 0 });
  let rev = mount.rev;
  if (mount.draft !== shown || mount.jsonText !== shownText) {
    const own = echo.current !== null && echo.current.draft === shown && echo.current.jsonText === shownText;
    const same = mount.jsonText === shownText && sameJson(mount.draft, shown);
    rev = own || same ? mount.rev : mount.rev + 1;
    setMount({ draft: shown, jsonText: shownText, rev });
  }
  const doc = shownText ?? dashboardJson(shown);

  // The latest of everything the editor's callbacks read (it is mounted once per revision).
  const latest = useRef({ editing, dispatch, ownerKind, onStartEditing, rev });
  latest.current = { editing, dispatch, ownerKind, onStartEditing, rev };
  /** Typing waiting for its pause, and the revision it was typed into. */
  const pending = useRef<{ text: string; rev: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** Set once typing started edit mode, before the page has drawn it (keystrokes come faster). */
  const started = useRef(false);
  started.current = editing !== null;

  const apply = useCallback((text: string): EditorState => {
    const action = { type: "setJson", text, ownerKind: latest.current.ownerKind } as const;
    let next = latest.current.dispatch(action);
    // Edit mode ended under the typing (a save answered before the pause): it starts again with it.
    if (next.mode !== "edit" && latest.current.onStartEditing()) {
      started.current = true;
      next = latest.current.dispatch(action);
    }
    if (next.mode === "edit") echo.current = { draft: next.draft, jsonText: next.jsonText };
    return next;
  }, []);
  const flush = useCallback((): EditorState | null => {
    const p = pending.current;
    if (!p) return null;
    clearTimeout(p.timer);
    pending.current = null;
    return apply(p.text);
  }, [apply]);

  // Save and Discard in the header apply what was just typed first; leaving the tab applies it too.
  useEffect(() => {
    flushRef.current = flush;
    return () => {
      flush();
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flush, flushRef]);
  // A remount replaces the text: typing into the old editor is dropped, never applied over it.
  useLayoutEffect(() => {
    const p = pending.current;
    if (p && p.rev !== rev) {
      clearTimeout(p.timer);
      pending.current = null;
    }
  }, [rev]);

  const onChange = useCallback((text: string) => {
    if (!started.current) {
      if (!latest.current.onStartEditing()) {
        // Not here: the editor goes back to the saved document.
        setMount((m) => ({ ...m, rev: m.rev + 1 }));
        return;
      }
      started.current = true;
    }
    if (pending.current) clearTimeout(pending.current.timer);
    const at = latest.current.rev;
    pending.current = {
      text,
      rev: at,
      timer: setTimeout(() => {
        pending.current = null;
        apply(text);
      }, JSON_DEBOUNCE_MS),
    };
  }, [apply]);

  const reviewButton = useRef<HTMLButtonElement>(null);
  const stateLine = useRef<HTMLParagraphElement>(null);
  // A refused save says what is wrong where it is said already, and the keyboard goes there.
  const seenFocus = useRef(problemFocus);
  useEffect(() => {
    if (problemFocus === seenFocus.current) return;
    seenFocus.current = problemFocus;
    stateLine.current?.focus();
  }, [problemFocus]);
  // Where Review changes returns the keyboard as it closes: Review changes, unless the save ended
  // edit mode. Then the page has already put it on Edit (W10), and it stays there.
  const reviewReturn = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      if (latest.current.editing !== null) return reviewButton.current;
      const active = document.activeElement;
      return active instanceof HTMLElement && active !== document.body && active.isConnected ? active : reviewButton.current;
    },
  }), []);
  const [reviewing, setReviewing] = useState(false);
  const review = useCallback(() => {
    const st = flush() ?? latest.current.editing;
    if (canReview(st)) setReviewing(true);
  }, [flush]);
  const discardTarget = useRef(discardRef);
  discardTarget.current = discardRef;
  const [keys] = useState<EditorKeys>(() => ({
    onSubmit: () => review(),
    // Esc leaves for Review changes, or for Discard while there is nothing to review.
    onLeave: () => {
      const st = flush() ?? latest.current.editing;
      (canReview(st) ? reviewButton.current : discardTarget.current.current)?.focus();
    },
  }));

  const problems = editing?.jsonProblems ?? [];
  const reviewable = canReview(editing);
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const mac = isMac();
  const state = problems.length > 0 ? "bad" : editing ? "live" : "valid";
  const more = problems.length - 1;

  return (
    <div className={s.frame} data-state={state}>
      <div className={s.bar}>
        <p ref={stateLine} className={s.state} data-testid="json-state" role="status" tabIndex={-1}>
          {problems.length > 0
            ? `✗ ${problemLine(problems[0], shownText ?? undefined)} · the dashboard keeps the last valid version`
            : editing ? "✓ Valid · applied live" : "✓ Valid"}
        </p>
        {more > 0 && (
          <button type="button" className={s.more} aria-expanded={showAll} aria-controls={showAll ? listId : undefined}
            onClick={() => setShowAll((v) => !v)}>
            {more === 1 ? "1 more problem" : `${more} more problems`}
          </button>
        )}
        <span className={s.push} />
        {editing && (
          <>
            <span className={s.hint} aria-hidden="true">
              <span className={`${k.k} ${s.k}`}>{keysFor("queryRun", mac)[0]}</span> reviews ·{" "}
              <span className={`${k.k} ${s.k}`}>Esc</span> leaves the editor
            </span>
            <button ref={reviewButton} type="button" className={`${s.btn} ${s.go}`} aria-disabled={!reviewable || saving || undefined}
              aria-keyshortcuts={mac ? "Meta+Enter" : "Control+Enter"} onClick={() => { if (!saving) review(); }}>
              Review changes
            </button>
          </>
        )}
      </div>
      {showAll && more > 0 && (
        <ul id={listId} className={s.problems} aria-label="JSON problems">
          {problems.map((p) => (
            <li key={`${p.path}|${p.message}`} className={s.problem}>
              {p.path && <code className={s.path}>{p.path}</code>} {p.path ? p.message : jsonWords(p.message, shownText ?? undefined)}
            </li>
          ))}
        </ul>
      )}
      <JsonEditor key={rev} doc={doc} onChange={onChange} keys={keys} />
      {reviewing && editing && (
        <ReviewChanges title={dashboard.title} version={editing.baseVersion} saved={editing.base} draft={editing.draft}
          saving={saving} restoreFocusTo={reviewReturn}
          onCancel={() => setReviewing(false)}
          onSave={() => { void onSave().finally(() => setReviewing(false)); }} />
      )}
    </div>
  );
}

/**
 * One mounting of the editor: `doc` is read once. Until CodeMirror has loaded the document shows
 * as text. Once shown it takes the keyboard only if the keyboard was lost (the editor it replaces
 * had it), never pulling it from where the user moved.
 */
function JsonEditor({ doc, onChange, keys }: { doc: string; onChange(text: string): void; keys: EditorKeys }) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [start] = useState(doc);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const editorRef = useRef<MountedEditor | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  // The keyboard was in the editor this one replaces: it waits here, not on <body>.
  useLayoutEffect(() => { if (focusLost()) box.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    let editor: MountedEditor | null = null;
    let gone = false;
    loadCodeMirror().then(
      (cm) => {
        if (gone || !host.current) return;
        editor = cm.editor(host.current, start, (text) => changed.current(text), JSON_LABEL, keys);
        editorRef.current = editor;
        setState("ready");
      },
      () => { if (!gone) setState("failed"); },
    );
    return () => {
      gone = true;
      editorRef.current = null;
      editor?.destroy();
    };
  }, [start, keys]);

  useEffect(() => {
    if (state !== "ready") return;
    if (focusLost() || document.activeElement === box.current) editorRef.current?.focus();
  }, [state]);

  // Esc stays with the editor (it leaves for the buttons): nothing behind it closes over the text.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => { if (e.key === "Escape") e.stopPropagation(); };

  return (
    <div ref={box} className={s.editorBox} tabIndex={-1} onKeyDown={onKey}>
      {state === "failed" && <p className={s.failed} role="alert">{EDITOR_UNAVAILABLE}</p>}
      {state !== "ready" && <pre className={s.code} aria-label={JSON_LABEL}>{start}</pre>}
      <div ref={host} className={`${s.editor} mono`} hidden={state !== "ready"} />
    </div>
  );
}
