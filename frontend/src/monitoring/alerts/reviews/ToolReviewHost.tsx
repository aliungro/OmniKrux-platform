// Holds the tool review queue of the Monitoring app (mounted once, by `MonitoringApp`). Each queued
// target is synced (`POST /targets/{id}/sync`); a `review` answer opens the shared `ActionDialog`
// on its plan, a `done` answer is skipped, and a refusal is announced; then the next one. What
// each review did is said in a polite status line. After an apply or a cancel, the alerts lists
// are read again (not an open dry run: nothing it reads changed). The keyboard never rests on
// <body>: a closed review hands it back to where the review started, the next review takes it,
// and when the queue ends it goes to `after.focus` (or the Monitoring workspace). A status of
// successes only goes away by itself after a while, and when the workspace moves to another page
// (`place`); one that says something is left to do stays until it is dismissed.
//
// A `contacts` change (the contact points in an Alertmanager OmniKrux installed) is reviewed by the
// install reviews (`useInstallReviews().contacts`), which say how it went; it waits behind the
// PrometheusRule reviews of its batch, so a rule exists before what routes it, and the queue waits
// for it before going on. Every review this queue opens first takes the screen's `turn()`: a review
// of the install host never shows beside it.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import type { Plan } from "../../../api/types";
import { ActionDialog } from "../../../features/actions/ActionDialog";
import { discardPlans } from "../../../features/actions/useActions";
import { focusMainFrom } from "../../focus";
import { useInstallReviews } from "../../install/useInstallReviews";
import { syncTarget, type AlertChangeOut, type SyncOut } from "../api";
import {
  appliedWords, cancelledWords, failedWords, lokiFailedWords, removedWords, TOOL_FAILED, ToolReviewsContext,
  type ToolReviewRequest, type ToolReviewResult, type ToolReviews,
} from "./useToolReviews";
import s from "./ToolReviewHost.module.css";

/** A queued review and whoever waits on how it ends (a rule's Review button). */
interface Item extends ToolReviewRequest {
  waiting: ((result: ToolReviewResult) => void)[];
  /** A sync the caller already made: its answer is used instead of syncing again. */
  answer?: SyncOut;
  /** A `contacts` change: the cluster whose Alertmanager's contact points the install reviews review. */
  contactsOf?: string;
}

/** The queue key of a cluster's contact points review (rule targets are keyed by their id). */
const contactsKey = (clusterId: string) => `contacts:${clusterId}`;

/** One line of the status: applied (ok), not applied yet (wait), couldn't (failed). */
interface Line {
  id: number;
  tone: "ok" | "wait" | "failed";
  text: string;
}

/** The status keeps the latest few lines of the run. */
const MAX_LINES = 6;
/** How long a status of successes only stays up. */
export const OK_STATUS_MS = 8000;

/** Whether the keyboard is nowhere (on <body>, or on something just removed). */
function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

export function ToolReviewHost({ children, place }: {
  children: ReactNode;
  /** Names the page the workspace shows: a status of successes only goes when it changes. */
  place?: string;
}) {
  const client = useQueryClient();
  const installReviews = useInstallReviews();
  const install = useRef(installReviews);
  install.current = installReviews;
  const queue = useRef<Item[]>([]);
  const running = useRef(false);
  const alive = useRef(true);
  /** Where the keyboard goes when the queue ends. */
  const after = useRef<HTMLElement | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState<{ item: Item; plan: Plan } | null>(null);
  /** The review on screen, for the dialog's callbacks (they may run after a re-render). */
  const shown = useRef<{ item: Item; plan: Plan } | null>(null);
  /** Ends the review on screen. */
  const closing = useRef<((result: ToolReviewResult) => void) | null>(null);
  const [ended, setEnded] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const lineId = useRef(0);

  const say = useCallback((tone: Line["tone"], text: string) => {
    if (!alive.current) return;
    setLines((now) => [...now, { id: ++lineId.current, tone, text }].slice(-MAX_LINES));
  }, []);

  const show = useCallback((next: { item: Item; plan: Plan } | null) => {
    shown.current = next;
    setOpen(next);
  }, []);

  // The alerts lists and badges, read again; an open dry run isn't (its rule didn't change).
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["monitoring", "alerts"], predicate: (q) => q.queryKey[2] !== "dryRun" });
  }, [client]);

  /** What a `done` answer means: nothing left to review, unless the tool refused the rule. */
  const doneResult = useCallback((item: Item, answer: Extract<SyncOut, { kind: "done" }>, sayApplied: boolean, removal = false): ToolReviewResult => {
    const target = answer.target;
    if (target?.tool_state === "failed") {
      const message = target.tool_message ?? TOOL_FAILED;
      say("failed", target.tool === "loki_ruler" ? lokiFailedWords(item.ruleName, message) : failedWords(item.ruleName, item.projectName, message));
      return "failed";
    }
    if (sayApplied) say("ok", (removal ? removedWords : appliedWords)(item.ruleName, item.projectName));
    return "applied";
  }, [say]);

  /** Syncs one target and, when it needs a review, waits for its dialog to close. */
  const syncAndShow = useCallback(async (item: Item): Promise<ToolReviewResult> => {
    let answer: SyncOut;
    try {
      answer = item.answer ?? await syncTarget(item.targetId);
    } catch (err) {
      say("failed", failedWords(item.ruleName, item.projectName, failure(err)));
      return "failed";
    }
    if (!alive.current) {
      if (answer.kind === "review") discardPlans([answer.plan.plan_id]);
      return "cancelled";
    }
    if (answer.kind === "done") return doneResult(item, answer, false);
    const plan = answer.plan;
    return new Promise<ToolReviewResult>((resolve) => {
      closing.current = resolve;
      show({ item, plan });
    });
  }, [doneResult, say, show]);

  /** One queued review: a target's (in the screen's turn), or a cluster's contact points. */
  const reviewOne = useCallback(async (item: Item): Promise<ToolReviewResult> => {
    if (item.contactsOf !== undefined) {
      // The install reviews open it (in their turn) and say how it went.
      const outcome = await install.current.contacts(item.contactsOf, after.current ?? undefined);
      return outcome === "started" ? "applied" : outcome;
    }
    // Planned only once no other review holds the screen; held until this one closed.
    const release = await install.current.turn();
    // Monitoring went away while it waited: nothing is synced for it.
    if (!alive.current) {
      release();
      return "cancelled";
    }
    try {
      return await syncAndShow(item);
    } finally {
      release();
    }
  }, [syncAndShow]);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (alive.current && queue.current.length > 0) {
        const item = queue.current[0];
        const result = await reviewOne(item);
        if (!alive.current) return;
        queue.current.shift();
        setPending(queue.current.length);
        for (const settle of item.waiting) settle(result);
        refresh();
      }
    } finally {
      running.current = false;
    }
    setEnded((n) => n + 1);
  }, [refresh, reviewOne]);

  /**
   * Queues a cluster's contact points review. One still waiting goes to the end (behind the rules
   * queued since, which it routes); one already under way is followed by a new one, as the contact
   * points changed again.
   */
  const addContacts = useCallback((clusterId: string, clusterName: string) => {
    const key = contactsKey(clusterId);
    // The first item is under way while the queue runs: a waiting one is looked for after it.
    const from = running.current ? 1 : 0;
    const at = queue.current.findIndex((i, n) => n >= from && i.targetId === key);
    const kept = at >= 0 ? queue.current.splice(at, 1)[0] : null;
    queue.current.push(kept ?? { targetId: key, ruleName: "", projectName: clusterName, waiting: [], contactsOf: clusterId });
    setPending(queue.current.length);
  }, []);

  /** Queues a review; one already queued (or open) for the same target is the same review. */
  const add = useCallback((request: ToolReviewRequest, settle?: (result: ToolReviewResult) => void, answer?: SyncOut) => {
    const same = queue.current.find((i) => i.targetId === request.targetId);
    if (same) {
      if (settle) same.waiting.push(settle);
      // The same review is already on its way: a second plan for it isn't needed.
      if (answer?.kind === "review") discardPlans([answer.plan.plan_id]);
      return;
    }
    queue.current.push({ ...request, waiting: settle ? [settle] : [], ...(answer ? { answer } : {}) });
    setPending(queue.current.length);
  }, []);

  /** A new run starts with an empty status: its lines are about this run only. */
  const startRun = useCallback(() => {
    if (running.current || queue.current.length > 0) return false;
    setLines([]);
    after.current = null;
    return true;
  }, []);

  const enqueue = useCallback<ToolReviews["enqueue"]>((changes: AlertChangeOut[], opts) => {
    const reviews = changes.filter((c) => c.kind === "review");
    const failed = changes.filter((c) => c.kind === "failed");
    const contacts = changes.filter((c): c is AlertChangeOut & { cluster_id: string } => c.kind === "contacts" && !!c.cluster_id);
    if (reviews.length === 0 && failed.length === 0 && contacts.length === 0) return;
    const fresh = startRun();
    for (const c of failed) {
      const message = c.message ?? TOOL_FAILED;
      // A PrometheusRule's change names the project's cluster; anything else was a Loki ruler's.
      say("failed", c.tool === "prometheus_rule" ? failedWords(c.rule_name, c.project_name, message) : lokiFailedWords(c.rule_name, message));
    }
    if (reviews.length === 0 && contacts.length === 0) return;
    if (opts?.focus !== undefined || fresh) after.current = opts?.focus ?? null;
    for (const c of reviews) add({ targetId: c.target_id, ruleName: c.rule_name, projectName: c.project_name });
    // After the batch's rules: the PrometheusRules exist before what routes their alerts.
    for (const c of contacts) addContacts(c.cluster_id, c.project_name);
    void pump();
  }, [add, addContacts, pump, say, startRun]);

  const reviewTarget = useCallback<ToolReviews["reviewTarget"]>((targetId, ruleName, projectName, answer) => {
    startRun();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) after.current = active;
    return new Promise<ToolReviewResult>((resolve) => {
      add({ targetId, ruleName, projectName }, resolve, answer);
      void pump();
    });
  }, [add, pump, startRun]);

  const finish = useCallback((result: ToolReviewResult) => {
    const resolve = closing.current;
    closing.current = null;
    show(null);
    resolve?.(result);
  }, [show]);

  const onDone = useCallback((outcome?: unknown) => {
    const now = shown.current;
    if (now === null) return;
    if (outcome === undefined) {
      // Closed without an apply: the review is closed on the server too.
      discardPlans([now.plan.plan_id]);
      say("wait", cancelledWords(now.item.ruleName, now.item.projectName));
      finish("cancelled");
    } else {
      const words = now.plan.action === "delete" ? removedWords : appliedWords;
      say("ok", words(now.item.ruleName, now.item.projectName));
      finish("applied");
    }
  }, [finish, say]);

  // Review again: the target is synced again and its new plan takes the old one's place. A
  // refusal rejects, and the dialog shows its words.
  const onReview = useCallback(async () => {
    const now = shown.current;
    if (now === null) return;
    const answer = await syncTarget(now.item.targetId);
    if (shown.current !== now) {
      if (answer.kind === "review") discardPlans([answer.plan.plan_id]);
      return;
    }
    discardPlans([now.plan.plan_id]);
    if (answer.kind === "review") show({ item: now.item, plan: answer.plan });
    else finish(doneResult(now.item, answer, true, now.plan.action === "delete"));
  }, [doneResult, finish, show]);

  // Leaving Monitoring: the review on screen is closed on the server, and whoever waits hears
  // "cancelled".
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (shown.current !== null) discardPlans([shown.current.plan.plan_id]);
      shown.current = null;
      const waiting = queue.current.flatMap((i) => i.waiting);
      queue.current = [];
      closing.current?.("cancelled");
      closing.current = null;
      for (const settle of waiting) settle("cancelled");
    };
  }, []);

  // A review closed with more to come: its dialog handed the keyboard back; if that place is
  // gone, the keyboard waits where the run started (or on the workspace), never on <body>.
  useEffect(() => {
    if (open !== null || !running.current || !focusLost()) return;
    if (after.current?.isConnected) after.current.focus();
    else focusMainFrom(region.current);
  }, [open]);

  // The queue ended: the keyboard goes to where the caller asked, or stays where the last
  // review returned it, or (when that is gone) to the workspace.
  useEffect(() => {
    if (ended === 0) return;
    const target = after.current;
    after.current = null;
    if (target?.isConnected) target.focus();
    else if (focusLost()) focusMainFrom(region.current);
  }, [ended]);

  const dismiss = useCallback(() => {
    if (region.current?.contains(document.activeElement)) focusMainFrom(region.current);
    setLines([]);
  }, []);

  // Successes only, with nothing left to review: said, so they go by themselves (not while the
  // keyboard is on the status) and when the workspace shows another page. A line that says what
  // is left to do stays until it is dismissed.
  const onlyOk = lines.length > 0 && lines.every((l) => l.tone === "ok") && pending === 0 && open === null;
  useEffect(() => {
    if (!onlyOk) return;
    const timer = window.setTimeout(() => {
      if (!region.current?.contains(document.activeElement)) setLines([]);
    }, OK_STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [onlyOk, lines]);
  const seenPlace = useRef(place);
  useEffect(() => {
    if (seenPlace.current === place) return;
    seenPlace.current = place;
    if (onlyOk) dismiss();
  }, [place, onlyOk, dismiss]);

  const value = useMemo<ToolReviews>(() => ({ enqueue, reviewTarget, pending }), [enqueue, reviewTarget, pending]);
  return (
    <ToolReviewsContext.Provider value={value}>
      {children}
      {open && <ActionDialog key={open.item.targetId} plan={open.plan} onDone={onDone} onReview={onReview} />}
      <div ref={region} className={lines.length > 0 ? s.tray : s.idle} data-testid="tool-review-status">
        <div role="status" aria-live="polite" className={s.lines}>
          {lines.length > 0 && (
            <ul className={s.list}>
              {lines.map((line) => (
                <li key={line.id} className={s.line} data-tone={line.tone}>
                  <span className={s.shape} aria-hidden="true" />
                  <span>{line.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {lines.length > 0 && (
          <button type="button" className={s.dismiss} onClick={dismiss}>
            Dismiss
          </button>
        )}
      </div>
    </ToolReviewsContext.Provider>
  );
}
