import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { deleteEmpty, failure } from "../../api/http";
import type { ActionTarget, Plan } from "../../api/types";
import { DialogShell } from "../dock/ConfirmDialog";
import cd from "../dock/ConfirmDialog.module.css";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import s from "./ActionDialog.module.css";
import { typeToConfirm } from "./ActionDialog";
import { useActions } from "./useActions";

export interface DeleteSelection {
  key: string;
  uid: string;
  target: ActionTarget;
  clusterName: string;
}

type Review = { selection: DeleteSelection; plan: Plan } | { selection: DeleteSelection; error: string };
type Result = { key: string; ok: boolean; message: string };

// Keep concurrent Kubernetes requests bounded when the list spans several clusters.
const REQUESTS_PER_BATCH = 5;

/** The server holds at most 50 open delete reviews: close the ones this dialog won't apply. */
function discard(planIds: Iterable<string>): void {
  for (const planId of planIds) void deleteEmpty(`/api/actions/${encodeURIComponent(planId)}`).catch(() => {});
}

export function BulkDeleteDialog({ selected, onClose }: {
  selected: readonly DeleteSelection[];
  onClose: (deleted: readonly string[]) => void;
}) {
  const id = useId();
  const first = useRef<HTMLButtonElement>(null);
  const applyInProgress = useRef(false);
  const actions = useActions();
  const [review, setReview] = useState<Review[] | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  // Reviews made and not yet applied; closed on the server when the dialog goes.
  const open = useRef(new Set<string>());
  useEffect(() => {
    const reviews = open.current;
    return () => {
      discard(reviews);
      reviews.clear();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const items: Review[] = [];
      for (let i = 0; i < selected.length && !cancelled; i += REQUESTS_PER_BATCH) {
        items.push(...await Promise.all(selected.slice(i, i + REQUESTS_PER_BATCH).map(async selection => {
          try {
            const plan = await actions.plan({
              action: "delete", target: selection.target, params: { expected_uid: selection.uid },
            });
            if (cancelled) discard([plan.plan_id]);
            else open.current.add(plan.plan_id);
            return { selection, plan };
          } catch (err) {
            return { selection, error: failure(err, "review deletion") };
          }
        })));
      }
      if (!cancelled) setReview(items);
    };
    // Let the first effect clean up before React's development replay makes requests.
    void Promise.resolve().then(load);
    return () => { cancelled = true; };
  }, [actions, selected]);

  useEffect(() => {
    if (results) first.current?.focus();
  }, [results]);

  const canApply = review !== null && results === null && !applying && review.every(item =>
    "plan" in item && item.plan.blocked.length === 0
    && (item.plan.confirm_text === null || typed[item.selection.key] === item.plan.confirm_text));

  const apply = async () => {
    if (!review || !canApply || applyInProgress.current) return;
    applyInProgress.current = true;
    setApplying(true);
    const outcomes: Result[] = [];
    for (let i = 0; i < review.length; i += REQUESTS_PER_BATCH) {
      outcomes.push(...await Promise.all(review.slice(i, i + REQUESTS_PER_BATCH).map(async item => {
        const { selection } = item;
        if ("error" in item) return { key: selection.key, ok: false, message: item.error };
        try {
          const confirm = item.plan.confirm_text === null ? undefined : typed[selection.key];
          open.current.delete(item.plan.plan_id);  // an apply uses the review up, whatever the outcome
          const out = await actions.apply(item.plan.plan_id, confirm);
          return { key: selection.key, ok: true, message: out.message };
        } catch (err) {
          return { key: selection.key, ok: false, message: failure(err, "confirm deletion") };
        }
      })));
    }
    setResults(outcomes);
    setApplying(false);
  };

  const deleted = results?.filter(result => result.ok).map(result => result.key) ?? [];
  const close = () => onClose(deleted);
  const noun = selected.length === 1 ? "resource" : "resources";
  const provider = review?.find(item => "plan" in item)?.plan.cluster.provider ?? "onprem";
  return createPortal(
    <DialogShell provider={provider}
      role="dialog" busy={applying} onCancel={close} first={first} labelledBy={`${id}-title`}
      className={s.dialog}>
      <h2 id={`${id}-title`} className={cd.title}>
        {results ? "Deletion results" : `Delete ${selected.length} ${noun}`}
      </h2>
      {review === null && <p role="status">Reviewing selected resources…</p>}
      {applying && <p role="status">Deleting selected resources…</p>}
      {results && <p role="status">{deleted.length} of {selected.length} deleted.</p>}
      {review && <ul className={s.bulkList}>
        {review.map((item, i) => {
          const { selection } = item;
          const plan = "plan" in item ? item.plan : null;
          const cluster = plan?.cluster.name ?? selection.clusterName;
          const target = plan?.target ?? selection.target;
          const name = plan ? `${plan.kind} ${target.name}` : target.name;
          const path = [cluster, target.namespace, name].filter(Boolean).join(" / ");
          const result = results?.[i];
          return <li key={selection.key} className={s.bulkItem}>
            <div className={s.bulkPath}>
              {plan && <ProviderBadge provider={knownProvider(plan.cluster.provider)} />}
              <strong>{path}</strong>
              {plan?.cluster.environment === "production" && <span className={s.production}>Production</span>}
            </div>
            {result ? <p className={result.ok ? s.lead : cd.error}>{result.message}</p>
              : "error" in item ? <p className={cd.error}>{item.error}</p>
                : <>
                  {item.plan.summary.slice(1).map((line, i) => <p key={i} className={s.lead}>{line}</p>)}
                  {item.plan.warnings.map((line, i) => <p key={i} className={s.bulkWarning}>{line}</p>)}
                  {item.plan.blocked.map((line, i) => <p key={i} className={cd.error}>{line}</p>)}
                  {item.plan.confirm_text !== null && <label className={s.typed}>
                    <span>{typeToConfirm(item.plan.confirm_text)}</span>
                    <input className={s.input} value={typed[selection.key] ?? ""} disabled={applying}
                      autoComplete="off" autoCapitalize="off" spellCheck={false}
                      onChange={event => {
                        const value = event.target.value;
                        setTyped(old => ({ ...old, [selection.key]: value }));
                      }} />
                  </label>}
                </>}
          </li>;
        })}
      </ul>}
      {review?.some(item => "error" in item || item.plan.blocked.length > 0) && (
        <p role="alert" className={cd.error}>Some resources couldn't be reviewed. Close this review and adjust your selection.</p>
      )}
      <div className={s.actions}>
        <button ref={first} type="button" className={s.btn} onClick={close} disabled={applying}>{results ? "Close" : "Cancel"}</button>
        {results === null && <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => void apply()} disabled={!canApply}>
          Delete {selected.length} {noun}
        </button>}
      </div>
    </DialogShell>,
    document.body,
  );
}
