import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isMac, keysFor, pressed } from "../chrome/shortcuts";
import { EDITOR_UNAVAILABLE, loadCodeMirror, type EditorKeys, type MountedEditor } from "./lazyCodeMirror";
import k from "../chrome/key.module.css";
import s from "./YamlEditor.module.css";

/** The button if it can be pressed now. */
const enabled = (b: HTMLButtonElement | null) => (b !== null && !b.disabled ? b : null);

/**
 * The YAML tab's editor: the object's YAML as it was when editing began, in CodeMirror (loaded
 * now, not with the page). "Review changes" plans an edit of the text as it is; "Discard" goes
 * back to the YAML. A refused review leaves the text as you typed it, with the reason above it.
 *
 * Keyboard-complete: Ctrl+Enter (Cmd+Enter on macOS) anywhere in it reviews the changes, Esc leaves
 * the text for "Review changes" (or "Discard" while nothing has changed), and left and right move
 * between the two. Only a press discards: no key that leaves or reviews ever does.
 */
export function YamlEditor({
  yaml,
  label,
  busy,
  error,
  onReview,
  onDiscard,
}: {
  yaml: string;
  label: string;
  busy: boolean;
  error: string | null;
  onReview: (text: string) => void;
  onDiscard: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const text = useRef(yaml);
  const [changed, setChanged] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const box = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MountedEditor | null>(null);
  // What had focus when editing began (the Edit button, or the row whose `e` started it), read once
  // the details have settled: an Edit button that went with the YAML view has handed focus on
  // (the details put it on the YAML tab) by then.
  const trigger = useRef<Element | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);

  const canReview = !busy && changed && state === "ready";
  // The editor is mounted once, so its keys read the latest of these.
  const latest = useRef({ canReview, onReview });
  latest.current = { canReview, onReview };
  const [keys] = useState<EditorKeys>(() => ({
    onSubmit: () => {
      if (latest.current.canReview) latest.current.onReview(text.current);
    },
    onLeave: () => {
      (enabled(reviewButton.current) ?? enabled(discardButton.current))?.focus();
    },
  }));

  // Mounted once: the text being edited is the editor's own, whatever the cluster does meanwhile
  // (the edit plan says so if the object moved on).
  useEffect(() => {
    let editor: MountedEditor | null = null;
    let gone = false;
    const start = text.current;
    loadCodeMirror().then(
      (cm) => {
        if (gone || !host.current) return;
        editor = cm.editor(
          host.current,
          start,
          (next) => {
            text.current = next;
            setChanged(next !== start);
          },
          label,
          keys,
        );
        editorRef.current = editor;
        setState("ready");
      },
      () => {
        if (!gone) setState("failed");
      },
    );
    return () => {
      gone = true;
      editorRef.current = null;
      editor?.destroy();
    };
  }, [label, keys]);

  useEffect(() => {
    trigger.current = document.activeElement;
  }, []);

  // Once shown, the editor takes focus, but only if focus is still where editing began (or inside
  // this box, or lost with the button that went): never pulled from wherever you moved meanwhile.
  useEffect(() => {
    if (state !== "ready") return;
    const active = document.activeElement;
    const stayed =
      active === null ||
      active === document.body ||
      active === trigger.current ||
      !active.isConnected ||
      (box.current?.contains(active) ?? false);
    if (stayed) editorRef.current?.focus();
  }, [state]);

  // Escape stays in the editor: it never closes the details with your edits in them. Ctrl+Enter
  // reviews from anywhere in it (the text handles its own first); held, it is still prevented, so
  // it never presses the focused button (Discard), and it reviews only once.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      return;
    }
    if (e.defaultPrevented || !pressed("reviewEdit", e)) return;
    e.preventDefault();
    if (!e.repeat) keys.onSubmit();
  };

  // Left and right on either button go to the other one; with a modifier they are left alone.
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const other =
      e.target === reviewButton.current ? discardButton.current : e.target === discardButton.current ? reviewButton.current : null;
    if (enabled(other) === null) return;
    e.preventDefault();
    other!.focus();
  };

  const mac = isMac();

  return (
    <div ref={box} className={s.box} onKeyDown={onKey}>
      <div className={s.bar} onKeyDown={onBarKey}>
        <span className={s.what}>{changed ? "Edited, not saved" : "Editing"}</span>
        <span className={s.hint}>
          <span className={`${k.k} ${s.k}`}>{keysFor("reviewEdit", mac)[0]}</span> reviews ·{" "}
          <span className={`${k.k} ${s.k}`}>{keysFor("close", mac)[0]}</span> leaves the editor
        </span>
        <span className={s.push} />
        <button ref={discardButton} type="button" className={s.btn} onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <button
          ref={reviewButton}
          type="button"
          className={`${s.btn} ${s.go}`}
          onClick={() => onReview(text.current)}
          disabled={!canReview}
          aria-keyshortcuts={mac ? "Meta+Enter" : "Control+Enter"}
        >
          {busy ? "Reviewing…" : "Review changes"}
        </button>
      </div>
      {error && <p className={s.error} role="alert">{error}</p>}
      {state === "loading" && <p className={s.note} role="status">Loading the editor…</p>}
      {state === "failed" && <p className={`${s.note} ${s.error}`} role="alert">{EDITOR_UNAVAILABLE}</p>}
      <div ref={host} className={`${s.editor} mono`} hidden={state !== "ready"} />
    </div>
  );
}
