import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EDITOR_UNAVAILABLE, loadCodeMirror, type MountedEditor } from "./lazyCodeMirror";
import s from "./YamlEditor.module.css";

/**
 * The YAML tab's editor: the object's YAML as it was when editing began, in CodeMirror (loaded
 * now, not with the page). "Review changes" plans an edit of the text as it is; "Discard" goes
 * back to the YAML. A refused review leaves the text as you typed it, with the reason above it.
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
        );
        setState("ready");
        editor.focus();
      },
      () => {
        if (!gone) setState("failed");
      },
    );
    return () => {
      gone = true;
      editor?.destroy();
    };
  }, [label]);

  // Escape stays in the editor: it never closes the details with your edits in them.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") e.stopPropagation();
  };

  return (
    <div className={s.box} onKeyDown={onKey}>
      <div className={s.bar}>
        <span className={s.what}>{changed ? "Edited, not saved" : "Editing"}</span>
        <span className={s.push} />
        <button type="button" className={s.btn} onClick={onDiscard} disabled={busy}>
          Discard
        </button>
        <button
          type="button"
          className={`${s.btn} ${s.go}`}
          onClick={() => onReview(text.current)}
          disabled={busy || !changed || state !== "ready"}
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
