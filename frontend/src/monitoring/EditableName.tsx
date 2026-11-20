import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { failure } from "../api/http";
import s from "./EditableName.module.css";

/**
 * A page's name as its heading, with Rename beside it. Renaming opens one field (focused);
 * Enter or Save name stores it, Esc or Cancel puts it back, and the keyboard returns to Rename.
 * A name the server refuses stays open with the server's words.
 */
export function EditableName({ name, titleId, dot, onRename }: {
  name: string;
  titleId: string;
  /** A colour for the dot before the name, when the page has one. */
  dot?: string;
  onRename(name: string): Promise<unknown>;
}) {
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const rename = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (wasEditing.current) rename.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const begin = () => { setText(name); setError(null); setEditing(true); };
  const cancel = () => { if (!busy) setEditing(false); };
  const save = async () => {
    if (busy) return;
    const next = text.trim();
    if (next === name) return setEditing(false);
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (err) {
      setError(failure(err, "try again"));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); void save(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
  };

  if (!editing) {
    return (
      <div className={s.head}>
        {dot && <i className={s.dot} style={{ background: dot }} aria-hidden="true" />}
        <h1 id={titleId} ref={title} tabIndex={-1} className={s.title}>{name}</h1>
        <button ref={rename} type="button" className={s.quiet} onClick={begin}>Rename</button>
      </div>
    );
  }
  return (
    <div className={s.edit}>
      <label htmlFor={`${id}-n`} className={s.label}>Name</label>
      <input id={`${id}-n`} ref={input} className={s.input} type="text" autoComplete="off" maxLength={80} value={text}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <button type="button" className={s.primary} aria-disabled={busy || undefined} onClick={() => void save()}>{busy ? "Saving…" : "Save name"}</button>
      <button type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={cancel}>Cancel</button>
      {error && <p id={`${id}-e`} className={s.error} role="alert">{error}</p>}
    </div>
  );
}
