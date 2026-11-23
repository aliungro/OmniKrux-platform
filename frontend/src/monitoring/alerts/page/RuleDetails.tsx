// A rule's details (A2, right): its name and where it runs, what can be done with it, the facts
// (who it belongs to, its state and since when, who it notifies, how often it checks), a bar for a
// tool that isn't in step with it, the query, the chart against its threshold, and what happened
// recently. States are as the server last read them, with the time they were checked.

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { invalidateMonitoring } from "../../api/hooks";
import { escapeCloses } from "../../focus";
import { DeleteReviewDialog } from "../../DeleteReviewDialog";
import { closesOnLeave, menuKeys, POPUP, useCloseOutside } from "../../dashboards/page/popover";
import type { MonitoringView } from "../../shell/tabState";
import {
  deleteRule, pauseRule, resumeRule, ruleDeleteReview, syncTarget,
  type AlertChangeOut, type AlertRequestError, type RuleDeleteReviewOut, type RuleOut, type Severity, type TargetOut, type TargetState,
  type ToolKind,
} from "../api";
import { durationWords, STATE_LABEL, stateTone, whereLabel } from "../format";
import { parseDuration } from "../limits";
import { lokiFailedWords, TOOL_FAILED, useToolReviews } from "../reviews/useToolReviews";
import { RuleChart } from "./RuleChart";
import { RuleHistory } from "./RuleHistory";
import { clockTime, labelsText, secondsSince } from "./words";
import s from "./AlertsPage.module.css";

/** Buttons whose work comes with a later step of this update (F31). */
export const LATER = "Comes with the next step of this update.";
export const TOOL_PAUSE = "This rule runs in the tool, which keeps checking it. Silence it instead.";
const SEVERITY_WORDS: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

const clusterOf = (t: Pick<TargetOut, "project_name">) => `${t.project_name}'s cluster`;

type ToolProblem = { text: string; action: "review" | "retry"; tool: ToolKind };

/**
 * A tool that isn't in step with a target, in words, what fixes it and which tool; null when all
 * is well. `ruleTool` is the tool of the rule's source type: where a copy is when the answer
 * doesn't say (a target now checked by OmniKrux has no `tool`).
 */
export function toolProblem(t: TargetOut, ruleTool: ToolKind): ToolProblem | null {
  const msg = t.tool_message ? ` ${t.tool_message}` : "";
  const outOfStep = t.tool_state !== null && t.tool_state !== "in_sync";
  // Leaving (the rule moved, or is being deleted), or now checked by OmniKrux while its old copy
  // stays in the tool: shown until it is gone. A leaving OmniKrux check with no copy goes at once.
  if (t.leaving || (t.engine !== "tool" && outOfStep)) {
    const copy = t.tool ?? t.tool_copy ?? (outOfStep ? ruleTool : null);
    if (copy === "loki_ruler") return { text: `Still in Loki.${msg}`, action: "retry", tool: copy };
    if (copy === "prometheus_rule") return { text: `Still in ${clusterOf(t)}: removing it needs a review.`, action: "review", tool: copy };
    return null;
  }
  if (t.engine !== "tool" || t.tool === null || !outOfStep) return null;
  const where = t.tool === "loki_ruler" ? "Loki" : clusterOf(t);
  return { text: `Not applied in ${where}.${msg}`, action: t.tool_state === "needs_review" ? "review" : "retry", tool: t.tool };
}

/** The where chip(s): one per distinct place (a group rule may run in several). */
function wherePlaces(rule: RuleOut): string[] {
  const active = rule.targets.filter((t) => !t.leaving);
  if (active.length === 0) {
    return [rule.engine === "tool" ? (rule.source_type === "loki" ? "in Loki" : "in Prometheus") : "checked by OmniKrux"];
  }
  return [...new Set(active.map((t) => whereLabel(t)))];
}

function stateWords(rule: RuleOut, now: number): string {
  const active = rule.targets.filter((t) => !t.leaving);
  const state: TargetState = rule.paused ? "paused" : rule.state;
  const holder = active.find((t) => t.state === state);
  const since = state === "firing" && rule.firing_since ? rule.firing_since : (holder?.state_since ?? null);
  let text = STATE_LABEL[state];
  if (since) text += ` for ${durationWords(secondsSince(since, now))}`;
  if (state === "firing") {
    const instance = active.flatMap((t) => t.instances).find((i) => i.state === "firing");
    const labels = labelsText(instance?.labels);
    if (labels) text += ` · ${labels}`;
  }
  if ((state === "unreachable" || state === "waiting" || state === "error") && holder?.message) text += ` · ${holder.message}`;
  return text;
}

function notifiesWords(rule: RuleOut): string {
  if (rule.contact_points.length > 0) return rule.contact_points.map((c) => c.name).join(", ");
  if (rule.channel) return rule.channel.receiver;
  return rule.engine === "tool" ? "Wherever its Alertmanager sends it" : "Nobody yet";
}

function checksWords(rule: RuleOut): string {
  const every = parseDuration(rule.condition.every);
  const wait = parseDuration(rule.condition.for) ?? 0;
  const head = `every ${every === null ? rule.condition.every : durationWords(every)}`;
  return `${head} · ${wait === 0 ? "right away" : `fires after ${durationWords(wait)}`}`;
}

function checkedWords(rule: RuleOut): string {
  // The oldest check of the places it runs: never a newer time than every place was read at.
  // A place never checked makes the rule not checked yet: no other time hides it.
  const times = rule.targets.filter((t) => !t.leaving).map((t) => t.last_eval_at);
  if (times.length === 0 || times.some((t) => t === null)) return "Not checked yet";
  return clockTime((times as string[]).sort((a, b) => Date.parse(a) - Date.parse(b))[0]);
}

// --- More actions ----------------------------------------------------------------------------

interface MenuItem {
  label: string;
  onSelect?(): void;
  /** Shown as the item's title when it can't be used. */
  why?: string;
  danger?: boolean;
}

function MoreActions({ items, buttonRef }: { items: MenuItem[]; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) buttonRef.current?.focus();
  }, [buttonRef]);
  const closeQuietly = useCallback(() => close(false), [close]);
  useCloseOutside(open, root, closeQuietly);
  useLayoutEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  return (
    <div ref={root} className={s.popAnchor}>
      <button ref={buttonRef} type="button" className={s.iconButton} aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div {...POPUP} className={s.popup} onKeyDown={escapeCloses(() => close(true))} onBlur={closesOnLeave(closeQuietly)}>
          <div ref={menu} role="menu" aria-label="More actions" className={s.menu} onKeyDown={menuKeys}>
            {items.map((a) => (
              <button key={a.label} type="button" role="menuitem" tabIndex={-1} className={s.menuItem}
                data-danger={a.danger || undefined} aria-disabled={a.onSelect ? undefined : true} title={a.onSelect ? undefined : a.why}
                onClick={() => { if (!a.onSelect) return; close(true); a.onSelect(); }}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Delete ------------------------------------------------------------------------------------

function DeleteRuleDialog({ rule, restoreFocusTo, onCancel, onDeleted }: {
  rule: RuleOut;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onDeleted(changes: AlertChangeOut[]): void;
}) {
  const [review, setReview] = useState<RuleDeleteReviewOut | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    setBusy(true);
    try {
      setReview(await ruleDeleteReview(rule.id));
    } catch (err) {
      setError(failure(err, "try again"));
    }
    setBusy(false);
  }, [rule.id]);
  const started = useRef(false);
  useLayoutEffect(() => {
    if (started.current) return;
    started.current = true;
    void read();
  }, [read]);

  const confirm = async () => {
    if (busy) return;
    if (!review) {
      setError(null);
      await read();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await deleteRule(rule.id, review.token);
      onDeleted(out.changes);
    } catch (err) {
      const e = err as AlertRequestError;
      if (e.code === "not_found") {
        onDeleted([]);
        return;
      }
      setError(failure(e, "try again"));
      // A rule that changed since the question: what goes with it is asked again.
      if (e.code === "rule_changed") {
        try { setReview(await ruleDeleteReview(rule.id)); } catch { setReview(null); }
      }
      setBusy(false);
    }
  };

  const clusters = review ? [...new Set(review.cluster_removals.map((r) => r.cluster_name ?? `${r.project_name}'s cluster`))] : [];
  return (
    <DeleteReviewDialog title={`Delete the rule "${rule.name}"?`} action="Delete rule" busy={busy} error={error}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onConfirm={() => void confirm()}>
      {!review && !error && <p>Checking what goes with it…</p>}
      {clusters.map((c) => <p key={c}>It's also removed from {c}; that opens its own review.</p>)}
      {review && review.loki_removals.length > 0 && <p>It's also removed from Loki.</p>}
      {review?.panel && <p>Its panel "{review.panel.panel_title}" loses its alert; the dashboard saves a new version.</p>}
    </DeleteReviewDialog>
  );
}

// --- The details ---------------------------------------------------------------------------------

export interface RuleDetailsProps {
  rule: RuleOut;
  /** Milliseconds since the epoch. */
  now: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Opens another Monitoring view in this tab (a dashboard). */
  onOpen(view: MonitoringView): void;
  /** The rule was deleted (its tool changes are handed on); `restore` is where the keyboard goes. */
  onDeleted(changes: AlertChangeOut[], restore: RefObject<HTMLElement | null>): void;
  /** Esc in the details: back to the list. */
  onEscape(): void;
  /** Where the keyboard goes after the delete (the next rule's row, else the page's heading). */
  afterDelete(): HTMLElement | null;
  id: string;
}

export function RuleDetails({ rule, now, headingRef, onOpen, onDeleted, onEscape, afterDelete, id }: RuleDetailsProps) {
  const client = useQueryClient();
  const reviews = useToolReviews();
  const more = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["monitoring", "alerts"], predicate: (q) => q.queryKey[2] !== "dryRun" });
  }, [client]);

  const tool = rule.engine === "tool";
  const pauseOrResume = async (resume: boolean) => {
    setProblem(null);
    try {
      await (resume ? resumeRule(rule.id) : pauseRule(rule.id));
    } catch (err) {
      setProblem(failure(err, "try again"));
    }
    void invalidateMonitoring(client);
  };

  /** Review (a cluster change, through the queue) or Retry (Loki is written at once, its own path). */
  const fix = async (t: TargetOut, tool: ToolKind) => {
    if (working) return;
    setProblem(null);
    setWorking(t.id);
    try {
      if (tool === "loki_ruler") {
        try {
          const out = await syncTarget(t.id);
          if (out.kind === "done" && out.target?.tool_state === "failed") setProblem(lokiFailedWords(rule.name, out.target.tool_message ?? TOOL_FAILED));
          // A cluster review after all (the rule moved there): this answer is its review, not synced again.
          else if (out.kind === "review") await reviews.reviewTarget(t.id, rule.name, t.project_name, out);
        } catch (err) {
          setProblem(lokiFailedWords(rule.name, failure(err, "try again")));
        }
        refresh();
      } else {
        await reviews.reviewTarget(t.id, rule.name, t.project_name);
      }
    } finally {
      setWorking(null);
    }
  };
  const fixButton = (t: TargetOut, p: ToolProblem) => (
    <button type="button" className={s.barButton} aria-disabled={working !== null || undefined}
      onClick={() => void fix(t, p.tool)}>
      {p.action === "review" ? "Review" : "Retry"}
    </button>
  );
  const ruleTool: ToolKind = rule.source_type === "loki" ? "loki_ruler" : "prometheus_rule";

  const items: MenuItem[] = [
    rule.paused
      ? { label: "Resume", onSelect: tool ? undefined : () => void pauseOrResume(true), why: TOOL_PAUSE }
      : { label: "Pause", onSelect: tool ? undefined : () => void pauseOrResume(false), why: TOOL_PAUSE },
    ...(rule.origin === "page" ? [{ label: "Attach to a panel…", why: LATER }] : []),
    { label: "Delete rule…", onSelect: () => setDeleting(true), danger: true },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    onEscape();
  };

  const group = rule.scope.kind === "group";
  const active = rule.targets.filter((t) => !t.leaving);
  const shownTarget = active[0] ?? rule.targets[0];
  const notes = [...new Set(rule.targets.map((t) => t.engine_note).filter((n): n is string => !!n))];
  const bars = group ? [] : rule.targets.flatMap((t) => {
    const p = toolProblem(t, ruleTool);
    return p ? [{ t, p }] : [];
  });
  const fact = (term: string, value: ReactNode) => (
    <div className={s.fact} key={term}>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
  const state: TargetState = rule.paused ? "paused" : rule.state;

  return (
    <section id={id} className={s.details} aria-labelledby={`${id}-name`} onKeyDown={onKeyDown}>
      <div className={s.detailsHead}>
        <h2 id={`${id}-name`} ref={headingRef} tabIndex={-1} className={s.ruleName}>{rule.name}</h2>
        {wherePlaces(rule).map((w) => <span key={w} className={s.where}>{w}</span>)}
        <div className={s.detailsActions}>
          <button type="button" className={s.button} aria-keyshortcuts="s" aria-disabled="true" title={LATER}>Silence</button>
          {rule.origin === "panel" && rule.panel ? (
            <button type="button" className={s.button}
              onClick={() => onOpen({ page: "dashboard", id: rule.panel!.dashboard_id, panel: rule.panel!.panel_id, editAlert: true })}>
              Edit on its panel
            </button>
          ) : (
            <button type="button" className={s.button} aria-disabled="true" title={LATER}>Edit rule</button>
          )}
          <MoreActions items={items} buttonRef={more} />
        </div>
      </div>
      {notes.map((n) => <p key={n} className={s.quiet}>{n}</p>)}
      {problem && <p className={s.toolBar} data-tone="warn" role="alert">{problem}</p>}
      {bars.map((b) => (
        <div key={b.t.id} className={s.toolBar} data-tone="warn">
          <p>{b.p.text}</p>
          {fixButton(b.t, b.p)}
        </div>
      ))}

      <dl className={s.facts}>
        {fact(group ? "Group" : "Project", rule.scope.name)}
        {fact("State", <span className={s.stateValue} data-tone={stateTone(state)}>{stateWords(rule, now)}</span>)}
        {fact("Notifies", notifiesWords(rule))}
        {fact("Checks", checksWords(rule))}
        {fact("Severity", SEVERITY_WORDS[rule.severity])}
        {rule.origin === "panel" && rule.panel && fact("From panel", (
          <button type="button" className={s.linkButton}
            onClick={() => onOpen({ page: "dashboard", id: rule.panel!.dashboard_id, panel: rule.panel!.panel_id })}>
            {rule.panel.panel_title} on {rule.panel.dashboard_title}
          </button>
        ))}
        {fact("Checked", checkedWords(rule))}
      </dl>

      <pre className={s.query}>{shownTarget?.rule_text || rule.expr}</pre>

      {group && rule.targets.length > 0 && (
        <table className={s.perProject} aria-label="Per project">
          <thead>
            <tr><th scope="col">Project</th><th scope="col">Where</th><th scope="col">State</th><th scope="col"><span className={s.hidden}>Action</span></th></tr>
          </thead>
          <tbody>
            {rule.targets.map((t) => {
              const p = toolProblem(t, ruleTool);
              return (
                <tr key={t.id}>
                  <td>{t.project_name}</td>
                  <td>{whereLabel(t)}</td>
                  <td>
                    <span className={s.stateValue} data-tone={p ? "warn" : stateTone(t.state)}>
                      {p ? p.text : `${STATE_LABEL[t.state]}${t.message && (t.state === "unreachable" || t.state === "waiting" || t.state === "error") ? ` · ${t.message}` : ""}`}
                    </span>
                  </td>
                  <td>{p && fixButton(t, p)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <RuleChart rule={rule} />
      <RuleHistory rule={rule} />

      {deleting && (
        <DeleteRuleDialog rule={rule} restoreFocusTo={restore}
          onCancel={() => { restore.current = more.current; setDeleting(false); }}
          onDeleted={(changes) => {
            restore.current = afterDelete();
            setDeleting(false);
            onDeleted(changes, restore);
          }} />
      )}
    </section>
  );
}
