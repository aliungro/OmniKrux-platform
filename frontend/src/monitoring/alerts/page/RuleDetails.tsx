// A rule's details (A2, right): its name and where it runs, what can be done with it, the facts
// (who it belongs to, its state and since when, who it notifies, how often it checks), a bar for a
// tool that isn't in step with it, the query, the chart against its threshold, and what happened
// recently. States are as the server last read them, with the time they were checked.

import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { useProjects } from "../../api/hooks";
import { escapeCloses } from "../../focus";
import { DeleteReviewDialog } from "../../DeleteReviewDialog";
import { closesOnLeave, menuKeys, POPUP, useCloseOutside } from "../../dashboards/page/popover";
import type { MonitoringView } from "../../shell/tabState";
import {
  alertsKeys, deleteRule, pauseRule, refreshAlerts, resumeRule, ruleDeleteReview, syncTarget,
  type AlertChangeOut, type AttachOut, type AlertRequestError, type RuleDeleteReviewOut, type RuleOut, type Severity, type TargetOut, type TargetState,
  type ToolKind,
} from "../api";
import { durationWords, STATE_LABEL, stateTone, stateWithMessage, whereLabel } from "../format";
import { parseDuration } from "../limits";
import { lokiFailedWords, TOOL_FAILED, useToolReviews } from "../reviews/useToolReviews";
import { AttachDialog, attachedWords } from "../rules/AttachDialog";
import { mixedClusterWarnings } from "../rules/clusterWarning";
import { RuleChart } from "./RuleChart";
import { RuleHistory } from "./RuleHistory";
import { clockTime, labelsText, secondsSince, silencedWords } from "./words";
import s from "./AlertsPage.module.css";

/** Silence, when the rule is not checked anywhere yet. */
export const NOTHING_TO_SILENCE = "This rule hasn't been checked yet. Silence it once it has.";
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
    // `tool_copy` null says nothing is in a tool (a cancelled review, a first write that failed);
    // only an older answer without the field falls back to the rule's own tool.
    const copy = t.tool ?? (t.tool_copy !== undefined ? t.tool_copy : outOfStep ? ruleTool : null);
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
  // "Not checked yet: the first check runs within 1 min." says it all: no "for", no label twice.
  const message = holder?.message ?? null;
  if (state === "waiting" && message?.startsWith(text)) return message;
  if (since) text += ` for ${durationWords(secondsSince(since, now))}`;
  if (state === "firing") {
    const instance = active.flatMap((t) => t.instances).find((i) => i.state === "firing");
    const labels = labelsText(instance?.labels);
    if (labels) text += ` · ${labels}`;
    const muted = silencedWords(active.flatMap((t) => t.instances));
    if (muted) text += ` · ${muted}`;
  }
  if ((state === "unreachable" || state === "waiting" || state === "error") && message) text += ` · ${message}`;
  return text;
}

/** One place's state: its label, why it can't be checked or is waiting, and what is silenced. */
function targetStateWords(t: TargetOut): string {
  let text = STATE_LABEL[t.state];
  if (t.state === "unreachable" || t.state === "waiting" || t.state === "error") text = stateWithMessage(text, t.message);
  if (t.state === "firing") {
    const muted = silencedWords(t.instances);
    if (muted) text += ` · ${muted}`;
  }
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
  /** Edit rule: the rule form in this place (a page rule's). */
  onEdit?(): void;
  /** Silence: the Silences view with this rule's silence prefilled; absent when nothing checks it yet. */
  onSilence?(): void;
  id: string;
}

export function RuleDetails({ rule, now, headingRef, onOpen, onDeleted, onEscape, afterDelete, onEdit, onSilence, id }: RuleDetailsProps) {
  const client = useQueryClient();
  const reviews = useToolReviews();
  const projects = useProjects();
  const more = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["monitoring", "alerts"], predicate: (q) => q.queryKey[2] !== "dryRun" });
  }, [client]);

  /** Attached: the rule is the panel's now (shown at once), and the dashboard's tool changes queue. */
  const attached = (out: AttachOut, panelTitle: string) => {
    client.setQueryData<RuleOut[]>(alertsKeys.rules(), (old) => old?.map((r) => (r.id === out.rule.id ? out.rule : r)));
    client.setQueryData(alertsKeys.rule(out.rule.id), out.rule);
    void refreshAlerts(client);
    restore.current = more.current;
    setAttaching(false);
    setNotice(attachedWords(panelTitle));
    reviews.enqueue(out.dashboard.alert_changes, { focus: more.current });
  };

  const tool = rule.engine === "tool";
  const pauseOrResume = async (resume: boolean) => {
    setProblem(null);
    try {
      await (resume ? resumeRule(rule.id) : pauseRule(rule.id));
    } catch (err) {
      setProblem(failure(err, "try again"));
    }
    void refreshAlerts(client);
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
    ...(rule.origin === "page" ? [{ label: "Attach to a panel…", onSelect: () => { setNotice(null); setAttaching(true); } }] : []),
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
  // A project's link that may hold other clusters: every project the rule runs in is checked.
  const warnings = mixedClusterWarnings(rule.scope, rule.source_type, rule.source_id, projects.data ?? [], [],
    group ? [...new Set(active.map((t) => t.project_id))] : undefined);

  return (
    <section id={id} className={s.details} aria-labelledby={`${id}-name`} onKeyDown={onKeyDown}>
      <div className={s.detailsHead}>
        <h2 id={`${id}-name`} ref={headingRef} tabIndex={-1} className={s.ruleName}>{rule.name}</h2>
        {wherePlaces(rule).map((w) => <span key={w} className={s.where}>{w}</span>)}
        <div className={s.detailsActions}>
          <button type="button" className={s.button} aria-keyshortcuts="s" aria-disabled={onSilence ? undefined : true}
            title={onSilence ? undefined : NOTHING_TO_SILENCE} onClick={onSilence}>Silence</button>
          {rule.origin === "panel" && rule.panel ? (
            <button type="button" className={s.button}
              onClick={() => onOpen({ page: "dashboard", id: rule.panel!.dashboard_id, panel: rule.panel!.panel_id, editAlert: true })}>
              Edit on its panel
            </button>
          ) : (
            <button type="button" className={s.button} onClick={onEdit}>Edit rule</button>
          )}
          <MoreActions items={items} buttonRef={more} />
        </div>
      </div>
      {notes.map((n) => <p key={n} className={s.quiet}>{n}</p>)}
      {notice && <p className={s.quiet} role="status">{notice}</p>}
      {warnings.map((w) => <p key={w} className={s.toolBar} data-tone="warn" data-cluster-warning="">{w}</p>)}
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
                      {p ? p.text : targetStateWords(t)}
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

      {attaching && (
        <AttachDialog rule={rule} restoreFocusTo={restore} onAttached={attached}
          onCancel={() => { restore.current = more.current; setAttaching(false); }} />
      )}
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
