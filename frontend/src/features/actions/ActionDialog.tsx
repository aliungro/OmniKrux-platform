import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { failure, HttpError } from "../../api/http";
import type { ApplyResult, Plan, PlanRequest } from "../../api/types";
import { DialogShell } from "../dock/ConfirmDialog";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import cd from "../dock/ConfirmDialog.module.css";
import { DiffView } from "./DiffView";
import { DrainOptions, type DrainFlags } from "./forms";
import { DrainProgress } from "./DrainProgress";
import { StartActionContext, useActions, type StartAction } from "./useActions";
import s from "./ActionDialog.module.css";

/** pipeline.py PRODUCTION and TYPE_TO_CONFIRM, word for word. */
export const PRODUCTION = "This is a production cluster.";
export const typeToConfirm = (name: string) => `Type ${name} to confirm`;

/** Applies that take something away get the danger colour on their button. */
const DESTRUCTIVE = new Set(["delete", "drain"]);

type Failure = { message: string; review: boolean };

/**
 * Reviews one plan and applies it. Everything it names comes from the plan, never from what is
 * selected now: the provider, `cluster / namespace / kind name`, the environment. Apply sends the
 * plan id and, where the plan asks for it, the typed name; nothing else. A conflict (409) or a
 * plan that expired or was used (404) keeps the dialog open with "Review again".
 */
export function ActionDialog({
  plan,
  onDone,
  onReview,
}: {
  plan: Plan;
  onDone: (result?: ApplyResult) => void;
  /** Plans the same change again, with `params` changed (a drain's options); rejects with the server's words. */
  onReview: (params?: Record<string, unknown>) => Promise<void>;
}) {
  const id = useId();
  const actions = useActions();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"idle" | "applying" | "reviewing">("idle");
  const [error, setError] = useState<Failure | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

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
        setJobId(out.job_id);
        setPhase("idle");
        return;
      }
      onDone(out);
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

  let body: ReactNode;
  if (jobId !== null) {
    body = <DrainProgress jobId={jobId} onClose={() => onDone()} />;
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
      onCancel={() => onDone()}
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
          <span className={s.kind}>{target.kind_key}</span> <span className={s.name}>{target.name}</span>
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
 * opens the dialog on it; it resolves when the dialog closes, with what was applied (null when
 * cancelled), and rejects with the server's words when the plan can't be made. Only the newest
 * start opens: a plan that comes back after another was asked for is dropped.
 */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const actions = useActions();
  const [open, setOpen] = useState<{ req: PlanRequest; plan: Plan } | null>(null);
  const latest = useRef(0);
  const settle = useRef<((result: ApplyResult | null) => void) | null>(null);

  const start = useCallback<StartAction>(
    async (req) => {
      const seq = ++latest.current;
      const plan = await actions.plan(req);
      if (seq !== latest.current) return null;
      settle.current?.(null);
      return new Promise<ApplyResult | null>((resolve) => {
        settle.current = resolve;
        setOpen({ req, plan });
      });
    },
    [actions],
  );

  const review = useCallback(
    async (params?: Record<string, unknown>) => {
      if (open === null) return;
      const req = params ? { ...open.req, params: { ...open.req.params, ...params } } : open.req;
      const seq = ++latest.current;
      const plan = await actions.plan(req);
      if (seq === latest.current) setOpen({ req, plan });
    },
    [actions, open],
  );

  const done = useCallback((result?: ApplyResult) => {
    latest.current += 1;
    setOpen(null);
    settle.current?.(result ?? null);
    settle.current = null;
  }, []);

  return (
    <StartActionContext.Provider value={start}>
      {children}
      {open && <ActionDialog plan={open.plan} onDone={done} onReview={review} />}
    </StartActionContext.Provider>
  );
}
