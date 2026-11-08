import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { failure } from "../../api/http";
import type { Revision } from "../../api/types";
import { useRevisions } from "./useActions";
import s from "./forms.module.css";

export const MAX_REPLICAS = 10_000;
/** workloads.py NO_EARLIER, word for word. */
export const noEarlier = (name: string) => `Deployment ${name} has no earlier revision to roll back to.`;

/** Escape in a form closes the form, not the details around it. */
function escapeCloses(onCancel: () => void) {
  return (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
}

function wholeCount(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n <= MAX_REPLICAS ? n : null;
}

/** How many replicas: prefilled with the count it runs at now; Review plans the scale. */
export function ScaleForm({
  name,
  initial,
  busy,
  error,
  onReview,
  onCancel,
}: {
  name: string;
  initial: number;
  busy: boolean;
  error: string | null;
  onReview: (replicas: number) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(initial));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const replicas = wholeCount(text);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (replicas !== null && !busy) onReview(replicas);
  };
  return (
    <form className={s.strip} onSubmit={submit} onKeyDown={escapeCloses(onCancel)} aria-label={`Scale ${name}`}>
      <label className={s.field} htmlFor={`${id}-n`}>
        Replicas
      </label>
      <input
        ref={input}
        id={`${id}-n`}
        className={s.count}
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_REPLICAS}
        step={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={replicas === null}
        aria-describedby={`${id}-h`}
      />
      <span id={`${id}-h`} className={s.hint}>
        {replicas === null ? "A whole number from 0 to 10,000." : `Runs ${initial} now.`}
      </span>
      <span className={s.push} />
      <button type="button" className={s.btn} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className={`${s.btn} ${s.go}`} disabled={busy || replicas === null}>
        {busy ? "Reviewing…" : "Review"}
      </button>
      {error && <p className={s.error} role="alert">{error}</p>}
    </form>
  );
}

/** The revision a rollback goes to by default: the newest one older than the one running. */
export function previousRevision(revisions: readonly Revision[]): number | null {
  const current = revisions.find((r) => r.current)?.revision;
  const older = revisions.filter((r) => !r.current && (current === undefined || r.revision < current));
  return older.length > 0 ? Math.max(...older.map((r) => r.revision)) : null;
}

/** A deployment's revisions to pick from, newest first; the previous one is picked to start with. */
export function RollbackForm({
  clusterId,
  namespace,
  name,
  busy,
  error,
  onReview,
  onCancel,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  busy: boolean;
  error: string | null;
  onReview: (revision: number) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const revisions = useRevisions(clusterId, namespace, name);
  const [picked, setPicked] = useState<number | null>(null);
  const list = revisions.data;
  const chosen = picked ?? (list ? previousRevision(list) : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chosen !== null && !busy) onReview(chosen);
  };

  let body;
  if (list === undefined) {
    body = revisions.isError ? (
      <p className={s.error} role="alert">{failure(revisions.error, "try again")}</p>
    ) : (
      <p className={s.hint} role="status">Loading revisions…</p>
    );
  } else if (previousRevision(list) === null) {
    body = <p className={s.hint}>{noEarlier(name)}</p>;
  } else {
    body = (
      <fieldset className={s.revisions}>
        <legend className={s.legend}>Roll {name} back to</legend>
        {list.map((r) => (
          <label key={r.revision} className={s.revision} data-current={r.current || undefined}>
            <input
              type="radio"
              name={`${id}-rev`}
              value={r.revision}
              checked={chosen === r.revision}
              disabled={r.current}
              onChange={() => setPicked(r.revision)}
            />
            <span className={s.rev}>Revision {r.revision}</span>
            <span className={s.images}>{r.images.join(", ") || "No images"}</span>
            {r.current && <span className={s.now}>Running now</span>}
          </label>
        ))}
      </fieldset>
    );
  }

  return (
    <form className={`${s.strip} ${s.column}`} onSubmit={submit} onKeyDown={escapeCloses(onCancel)} aria-label={`Roll back ${name}`}>
      {body}
      <div className={s.row}>
        <span className={s.push} />
        <button type="button" className={s.btn} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={`${s.btn} ${s.go}`} disabled={busy || chosen === null}>
          {busy ? "Reviewing…" : "Review"}
        </button>
      </div>
      {error && <p className={s.error} role="alert">{error}</p>}
    </form>
  );
}

export interface DrainFlags {
  force: boolean;
  delete_emptydir_data: boolean;
}

/**
 * What a drain may also do. Ticking one plans the drain again with it, so the dialog always shows
 * the plan the server would apply; a failed review puts the box back.
 */
export function DrainOptions({ disabled, onChange }: { disabled: boolean; onChange: (flags: DrainFlags) => Promise<boolean> }) {
  const [flags, setFlags] = useState<DrainFlags>({ force: false, delete_emptydir_data: false });
  const toggle = async (key: keyof DrainFlags, on: boolean) => {
    const before = flags;
    const next = { ...flags, [key]: on };
    setFlags(next);
    if (!(await onChange(next))) setFlags(before);
  };
  return (
    <fieldset className={s.options} disabled={disabled}>
      <legend className={s.legend}>Drain options</legend>
      <label className={s.check}>
        <input type="checkbox" checked={flags.force} onChange={(e) => void toggle("force", e.target.checked)} />
        Evict pods without a controller
      </label>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={flags.delete_emptydir_data}
          onChange={(e) => void toggle("delete_emptydir_data", e.target.checked)}
        />
        Delete emptyDir data
      </label>
    </fieldset>
  );
}
