import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { failure, HttpError } from "../../api/http";
import type { Plan, PlanRequest } from "../../api/types";
import { DialogShell } from "../dock/ConfirmDialog";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import cd from "../dock/ConfirmDialog.module.css";
import { DiffView } from "./DiffView";
import { DrainOptions, type DrainFlags } from "./forms";
import { DrainProgress } from "./DrainProgress";
import { discardPlans, StartActionContext, useActions, type ActionOutcome, type StartAction } from "./useActions";
import s from "./ActionDialog.module.css";

/** pipeline.py PRODUCTION and TYPE_TO_CONFIRM, word for word. */
export const PRODUCTION = "This is a production cluster.";
export const typeToConfirm = (name: string) => `Type ${name} to confirm`;

/** Applies that take something away get the danger colour on their button. */
const DESTRUCTIVE = new Set(["delete", "drain", "evict"]);

type Failure = { message: string; review: boolean };

/**
 * Reviews one plan and applies it. Everything it names comes from the plan, never from what is
 * selected now: the provider, `cluster / namespace / kind name`, the environment. Apply sends the
 * plan id and, where the plan asks for it, the typed name; nothing else. A conflict (409) or a
 * plan that expired or was used (404) keeps the dialog open with "Review again". It closes with
 * what the change did in the server's words (`onDone(outcome)`), or with nothing when cancelled.
 */
export function ActionDialog({
  plan,
  onDone,
  onReview,
}: {
  plan: Plan;
  onDone: (outcome?: ActionOutcome) => void;
  /** Plans the same change again, with `params` changed (a drain's options); rejects with the server's words. */
  onReview: (params?: Record<string, unknown>) => Promise<void>;
}) {
  const id = useId();
  const actions = useActions();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"idle" | "applying" | "reviewing">("idle");
  const [error, setError] = useState<Failure | null>(null);
  /** A drain under way: its job, and what the apply said when it started it. */
  const [started, setStarted] = useState<{ jobId: string; message: string } | null>(null);
  /** How the drain ended (or that it is lost), once its progress says so. */
  const ended = useRef<ActionOutcome | null>(null);

  // A new plan (reviewed again) starts clean: the name is typed again for it.
  const [shown, setShown] = useState(plan.plan_id);
  if (shown !== plan.plan_id) {
    setShown(plan.plan_id);
    setTyped("");
    setError(null);
  }

  const { cluster, target } = plan;
  const production = cluster.environment === "production";
  const warnings = plan.warnings.filter((w) => w !== PRODUCTION);
  const typedOk = plan.confirm_text === null || typed === plan.confirm_text;
  const busy = phase !== "idle";
  const canApply = !busy && plan.blocked.length === 0 && typedOk && !error?.review;

  const apply = async () => {
    if (!canApply) return;
    setPhase("applying");
    setError(null);
    try {
      const out = await actions.apply(plan.plan_id, plan.confirm_text === null ? undefined : typed);
      if (out.outcome === "started" && out.job_id) {
        setStarted({ jobId: out.job_id, message: out.message });
        setPhase("idle");
        return;
      }
      onDone({ message: out.message, tone: "ok" });
    } catch (err) {
      const review = err instanceof HttpError && (err.status === 409 || err.status === 404);
      setError({ message: failure(err), review });
      setPhase("idle");
    }
  };

  /** Plans again; false (with the reason shown) when that failed. */
  const review = async (params?: Record<string, unknown>): Promise<boolean> => {
    setPhase("reviewing");
    setError(null);
    try {
      await onReview(params);
      return true;
    } catch (err) {
      setError({ message: failure(err), review: params === undefined });
      return false;
    } finally {
      setPhase("idle");
    }
  };

  // Closing a drain's progress, however: say how it ended, or that it was started and carries on.
  const close = () => {
    if (started === null) onDone();
    else onDone(ended.current ?? { message: started.message, tone: "ok" });
  };

  let body: ReactNode;
  if (started !== null) {
    body = <DrainProgress jobId={started.jobId} onClose={close} onOutcome={(o) => { ended.current = o; }} />;
  } else {
    body = (
      <>
        {plan.summary.length > 0 && (
          <ul className={s.summary} id={`${id}-b`}>
            {plan.summary.map((line, i) => (
              <li key={i} className={i === 0 ? s.lead : s.item}>
                {line}
              </li>
            ))}
          </ul>
        )}
        {(warnings.length > 0 || plan.blocked.length > 0) && (
          <ul className={s.notes}>
            {plan.blocked.map((line) => (
              <li key={`b:${line}`} className={s.note} data-tone="bad">
                <span className={s.shape} aria-hidden="true" />
                {line}
              </li>
            ))}
            {warnings.map((line) => (
              <li key={`w:${line}`} className={s.note} data-tone="warn">
                <span className={s.shape} aria-hidden="true" />
                {line}
              </li>
            ))}
          </ul>
        )}
        {plan.action === "drain" && (
          <DrainOptions disabled={busy} onChange={(flags: DrainFlags) => review({ ...flags })} />
        )}
        {plan.diff && <DiffView before={plan.diff.before} after={plan.diff.after} />}
        {plan.confirm_text !== null && (
          <label className={s.typed}>
            <span>{typeToConfirm(plan.confirm_text)}</span>
            <input
              className={s.input}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void apply();
                }
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
        )}
        {error && (
          <div className={cd.error} role="alert">
            {error.message}
          </div>
        )}
        <div className={s.actions}>
          {error?.review && (
            <button type="button" className={`${s.btn} ${s.again}`} onClick={() => void review()} disabled={busy}>
              {phase === "reviewing" ? "Reviewing…" : "Review again"}
            </button>
          )}
          <button ref={cancelRef} type="button" className={s.btn} onClick={() => onDone()} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${s.btn} ${DESTRUCTIVE.has(plan.action) ? s.danger : s.go}`}
            onClick={() => void apply()}
            disabled={!canApply}
          >
            {phase === "applying" ? "Applying…" : plan.apply_label}
          </button>
        </div>
      </>
    );
  }

  return (
    <DialogShell
      provider={cluster.provider}
      role="dialog"
      busy={busy}
      onCancel={close}
      first={cancelRef}
      labelledBy={`${id}-t`}
      describedBy={plan.summary.length > 0 ? `${id}-b` : undefined}
      className={`${s.dialog}${plan.diff ? ` ${s.wide}` : ""}`}
    >
      <div className={cd.where}>
        <ProviderBadge provider={knownProvider(cluster.provider)} />
        <span className={`${cd.path} ${s.path}`} data-testid="action-where">
          {cluster.name}
          <span className={s.sep}> / </span>
          {target.namespace !== null && (
            <>
              {target.namespace}
              <span className={s.sep}> / </span>
            </>
          )}
          <span className={s.kind}>{plan.kind}</span> <span className={s.name}>{target.name}</span>
        </span>
        {production && <span className={`${s.env} ${s.prod}`}>Production</span>}
        {cluster.environment === "development" && <span className={`${s.env} ${s.dev}`}>Development</span>}
      </div>
      {production && (
        <p className={s.production} data-tone="warn">
          {PRODUCTION}
        </p>
      )}
      <h2 id={`${id}-t`} className={cd.title}>
        {plan.title}
      </h2>
      {body}
    </DialogShell>
  );
}

/**
 * Holds the change being reviewed and draws its dialog over the page. `start` plans a change and
 * opens the dialog on it; it resolves when the dialog closes, with what the change did (null when
 * cancelled), and rejects with the server's words when the plan can't be made. Only the newest
 * start opens, and only while its caller still wants it (`isCurrent`): a plan that comes back after
 * you moved on is dropped, so it never opens a dialog or takes focus.
 */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const actions = useActions();
  const [open, setOpen] = useState<{ req: PlanRequest; plan: Plan } | null>(null);
  const latest = useRef(0);
  const settle = useRef<((outcome: ActionOutcome | null) => void) | null>(null);
  // The review on screen. One that is dropped, replaced or closed without an apply is closed on
  // the server too, so it never holds a place among the open delete reviews.
  const shown = useRef<string | null>(null);
  const show = useCallback((next: { req: PlanRequest; plan: Plan } | null) => {
    if (shown.current !== null && shown.current !== next?.plan.plan_id) discardPlans([shown.current]);
    shown.current = next?.plan.plan_id ?? null;
    setOpen(next);
  }, []);
  useEffect(() => () => {
    if (shown.current !== null) discardPlans([shown.current]);
    shown.current = null;
  }, []);

  const start = useCallback<StartAction>(
    async (req, opts) => {
      const seq = ++latest.current;
      const plan = await actions.plan(req);
      if (seq !== latest.current || (opts?.isCurrent && !opts.isCurrent())) {
        discardPlans([plan.plan_id]);
        return null;
      }
      settle.current?.(null);
      return new Promise<ActionOutcome | null>((resolve) => {
        settle.current = resolve;
        show({ req, plan });
      });
    },
    [actions, show],
  );

  const review = useCallback(
    async (params?: Record<string, unknown>) => {
      if (open === null) return;
      const req = params ? { ...open.req, params: { ...open.req.params, ...params } } : open.req;
      const seq = ++latest.current;
      const plan = await actions.plan(req);
      if (seq === latest.current) show({ req, plan });
      else discardPlans([plan.plan_id]);
    },
    [actions, open, show],
  );

  const done = useCallback((outcome?: ActionOutcome) => {
    latest.current += 1;
    // With an outcome the review was applied (and used up); without one it was cancelled.
    if (outcome !== undefined) shown.current = null;
    show(null);
    settle.current?.(outcome ?? null);
    settle.current = null;
  }, [show]);

  return (
    <StartActionContext.Provider value={start}>
      {children}
      {open && <ActionDialog plan={open.plan} onDone={done} onReview={review} />}
    </StartActionContext.Provider>
  );
}
