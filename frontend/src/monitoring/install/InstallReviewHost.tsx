// Holds the install reviews of the Monitoring app (mounted once, by `MonitoringApp`, around the
// tool review queue). An install, an uninstall or the contact points of OmniKrux's own Alertmanager
// is planned on the server and reviewed in the shared `ActionDialog`, one at a time: a second
// request waits for the first to close. The install review carries its settings (planned again on
// **Update review**; the last edited ones are kept, so **Review again** after an expired or stale
// plan keeps them) and, once applied, the job's progress. What each review did is said in a polite
// status line; then Monitoring's data and the audit log are read again, and the keyboard goes back
// where the review was asked for (or to the workspace), never to <body>.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import type { Plan } from "../../api/types";
import { useClusters } from "../../api/useClusters";
import { ActionDialog } from "../../features/actions/ActionDialog";
import { discardPlans, type ActionOutcome } from "../../features/actions/useActions";
import { OK_STATUS_MS } from "../alerts/reviews/ToolReviewHost";
import t from "../alerts/reviews/ToolReviewHost.module.css";
import { focusMainFrom } from "../focus";
import { planInstall, planUninstall, syncContacts, type Component, type InstallPlanIn, type InstallPlanOut, type InstallSettingsIn } from "./api";
import { InstallProgress, type InstallJobState } from "./InstallProgress";
import { UninstallOptions } from "./UninstallOptions";
import { InstallSettingsPanel } from "./InstallSettingsPanel";
import {
  contactsAppliedWords, contactsCancelledWords, installingWords, InstallReviewsContext, notInstalledWords, notUninstalledWords,
  reviewFailedWords, stoppingWords, uninstallingWords, type FocusAfter, type InstallOutcome, type InstallReviews,
} from "./useInstallReviews";

type Kind = "install" | "uninstall" | "contacts";

/** A queued review and whoever waits on how it ends. */
interface Item {
  id: number;
  kind: Kind;
  clusterId: string;
  components: Component[];
  projectId?: string;
  focusAfter?: FocusAfter;
  /** The install settings last edited: every plan of this review is made with them. */
  settings?: InstallSettingsIn;
  /** Edits in the settings panel not sent yet (null: none, or not sendable): Review again uses them. */
  draft?: InstallSettingsIn | null;
  /** The uninstall's stored-data choice, planned again when it changes (off unless asked for). */
  deleteData?: boolean;
  resolve(outcome: InstallOutcome): void;
}

interface Open {
  item: Item;
  plan: Plan;
  /** The install review's settings, problems and facts. */
  install: InstallPlanOut | null;
}

interface Line {
  id: number;
  tone: "ok" | "wait" | "failed";
  text: string;
}

const MAX_LINES = 6;

function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/** The review of an item: its plan, or `done` when the contact points need none. */
async function planFor(item: Item): Promise<Omit<Open, "item"> | "done"> {
  if (item.kind === "install") {
    const body: InstallPlanIn = { cluster_id: item.clusterId, components: item.components };
    if (item.settings) body.settings = item.settings;
    if (item.projectId) body.project_id = item.projectId;
    const out = await planInstall(body);
    return { plan: out.plan, install: out };
  }
  if (item.kind === "uninstall") return { plan: await planUninstall(item.clusterId, { delete_data: item.deleteData === true }), install: null };
  const out = await syncContacts(item.clusterId);
  return out.kind === "review" ? { plan: out.plan, install: null } : "done";
}

export function InstallReviewHost({ children, place }: {
  children: ReactNode;
  /** Names the page the workspace shows: a status of successes only goes when it changes. */
  place?: string;
}) {
  const client = useQueryClient();
  const clusters = useClusters().data;
  const clusterNames = useRef(new Map<string, string>());
  clusterNames.current = new Map((clusters ?? []).map((c) => [c.id, c.name]));
  const nameOf = useCallback((clusterId: string) => clusterNames.current.get(clusterId) ?? "this cluster", []);

  const queue = useRef<Item[]>([]);
  const running = useRef(false);
  const alive = useRef(true);
  const nextId = useRef(0);
  const region = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Open | null>(null);
  /** The review on screen, for the dialog's callbacks (they may run after a re-render). */
  const shown = useRef<Open | null>(null);
  /** Ends the review on screen. */
  const closing = useRef<((outcome: InstallOutcome) => void) | null>(null);
  /** Where the job of the review on screen stands; null until an apply started one. */
  const jobState = useRef<InstallJobState | null>(null);
  /** Where the keyboard goes once the closed review's dialog is gone. */
  const backTo = useRef<{ el: FocusAfter | undefined } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const lineId = useRef(0);

  const say = useCallback((tone: Line["tone"], text: string) => {
    if (!alive.current) return;
    setLines((now) => [...now, { id: ++lineId.current, tone, text }].slice(-MAX_LINES));
  }, []);

  const show = useCallback((next: Open | null) => {
    shown.current = next;
    setOpen(next);
  }, []);

  const runOne = useCallback(async (item: Item): Promise<InstallOutcome> => {
    let first: Omit<Open, "item"> | "done";
    try {
      first = await planFor(item);
    } catch (err) {
      say("failed", reviewFailedWords(item.kind, nameOf(item.clusterId), failure(err)));
      return "failed";
    }
    if (!alive.current) {
      if (first !== "done") discardPlans([first.plan.plan_id]);
      return "cancelled";
    }
    // The contact points are already what OmniKrux wants: nothing to review, nothing to say.
    if (first === "done") return "applied";
    const ready = first;
    return new Promise<InstallOutcome>((resolve) => {
      closing.current = resolve;
      jobState.current = null;
      show({ item, ...ready });
    });
  }, [nameOf, say, show]);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (alive.current && queue.current.length > 0) {
        const item = queue.current[0];
        const outcome = await runOne(item);
        if (!alive.current) return;
        queue.current.shift();
        item.resolve(outcome);
        void client.invalidateQueries({ queryKey: ["monitoring"] });
        void client.invalidateQueries({ queryKey: ["audit"] });
      }
    } finally {
      running.current = false;
    }
  }, [client, runOne]);

  const request = useCallback((fields: Omit<Item, "id" | "resolve">) => new Promise<InstallOutcome>((resolve) => {
    if (!alive.current) {
      resolve("cancelled");
      return;
    }
    queue.current.push({ ...fields, id: ++nextId.current, resolve });
    void pump();
  }), [pump]);

  const value = useMemo<InstallReviews>(() => ({
    install: (req) => request({ kind: "install", clusterId: req.clusterId, components: req.components, projectId: req.projectId, focusAfter: req.focusAfter }),
    uninstall: (clusterId, focusAfter) => request({ kind: "uninstall", clusterId, components: [], focusAfter }),
    contacts: (clusterId, focusAfter) => request({ kind: "contacts", clusterId, components: [], focusAfter }),
  }), [request]);

  const finish = useCallback((outcome: InstallOutcome) => {
    const now = shown.current;
    const resolve = closing.current;
    closing.current = null;
    backTo.current = { el: now?.item.focusAfter };
    show(null);
    resolve?.(outcome);
  }, [show]);

  const onDone = useCallback((outcome?: ActionOutcome) => {
    const now = shown.current;
    if (now === null) return;
    const { kind } = now.item;
    const cluster = now.plan.cluster.name;
    if (outcome === undefined) {
      // Closed without an apply: the review is closed on the server too.
      discardPlans([now.plan.plan_id]);
      say("wait", kind === "install" ? notInstalledWords(cluster) : kind === "uninstall" ? notUninstalledWords(cluster) : contactsCancelledWords(cluster));
      finish("cancelled");
      return;
    }
    const state = jobState.current;
    if (state === "stopping") {
      // Closed while a cancel waits for Helm: it is being stopped, not carrying on.
      say("wait", stoppingWords(kind === "uninstall" ? "uninstall" : "install", cluster));
      finish("started");
      return;
    }
    if (state === null || state === "running") {
      // Applied, or started and carrying on: say where to follow it.
      say("ok", kind === "install" ? installingWords(cluster) : kind === "uninstall" ? uninstallingWords(cluster) : contactsAppliedWords(cluster));
      finish(state === null ? "applied" : "started");
      return;
    }
    if (state === "lost") {
      say("wait", outcome.message);
      finish("started");
      return;
    }
    // It ended while the dialog stayed open: say how, in the job's own words.
    say(state === "succeeded" ? "ok" : state === "cancelled" ? "wait" : "failed", outcome.message);
    finish(state === "succeeded" ? "applied" : state === "cancelled" ? "cancelled" : "failed");
  }, [finish, say]);

  // Update review (with settings) and Review again (without): planned again with the settings
  // last edited, and the new plan takes the old one's place. A refusal rejects; the dialog says it.
  const onReview = useCallback(async (params?: Record<string, unknown>) => {
    const now = shown.current;
    if (now === null) return;
    // The stored-data choice sticks only once its plan was made: a refusal leaves it as it was.
    const keptDeleteData = now.item.deleteData;
    if (now.item.kind === "uninstall" && params && "delete_data" in params) now.item.deleteData = params.delete_data === true;
    if (now.item.kind === "install") {
      if (params && "settings" in params) now.item.settings = params.settings as InstallSettingsIn;
      else if (!params && now.item.draft) now.item.settings = now.item.draft;
    }
    let next: Awaited<ReturnType<typeof planFor>>;
    try {
      next = await planFor(now.item);
    } catch (err) {
      now.item.deleteData = keptDeleteData;
      throw err;
    }
    if (shown.current !== now) {
      if (next !== "done") discardPlans([next.plan.plan_id]);
      return;
    }
    discardPlans([now.plan.plan_id]);
    if (next !== "done") {
      show({ item: now.item, ...next });
      return;
    }
    say("ok", contactsAppliedWords(now.plan.cluster.name));
    finish("applied");
  }, [finish, say, show]);

  const onJobState = useCallback((state: InstallJobState) => { jobState.current = state; }, []);

  // Leaving Monitoring: the review on screen is closed on the server, and whoever waits hears
  // "cancelled".
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (shown.current !== null && jobState.current === null) discardPlans([shown.current.plan.plan_id]);
      shown.current = null;
      const waiting = queue.current;
      queue.current = [];
      closing.current?.("cancelled");
      closing.current = null;
      for (const item of waiting) item.resolve("cancelled");
    };
  }, []);

  // A review closed: the keyboard goes where it was asked to (the workspace when that is gone);
  // asked nowhere, it stays where the dialog handed it back, or goes to the workspace.
  useEffect(() => {
    if (open !== null || backTo.current === null) return;
    const { el } = backTo.current;
    backTo.current = null;
    const target = typeof el === "function" ? el() : el;
    if (target?.isConnected) target.focus();
    else if (el || focusLost()) focusMainFrom(region.current);
  }, [open]);

  // The tool review queue's status sits in the same corner: this one stands just above it.
  const [lift, setLift] = useState(0);
  const hasLines = lines.length > 0;
  useEffect(() => {
    const other = region.current?.parentElement?.querySelector<HTMLElement>('[data-testid="tool-review-status"]');
    if (!hasLines || !other || typeof ResizeObserver === "undefined") return;
    const measure = () => setLift(other.offsetHeight > 4 ? other.offsetHeight + 10 : 0);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(other);
    return () => observer.disconnect();
  }, [hasLines]);

  const dismiss = useCallback(() => {
    if (region.current?.contains(document.activeElement)) focusMainFrom(region.current);
    setLines([]);
  }, []);

  // Successes only, with no review open: they go by themselves (not while the keyboard is on the
  // status) and when the workspace shows another page. A line that says what is left stays.
  const onlyOk = hasLines && lines.every((l) => l.tone === "ok") && open === null && queue.current.length === 0;
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

  let dialog: ReactNode = null;
  if (open) {
    const { item, plan, install } = open;
    const action = item.kind === "uninstall" ? "uninstall" : "install";
    dialog = (
      <ActionDialog
        key={item.id}
        plan={plan}
        onDone={onDone}
        onReview={onReview}
        options={install ? ({ busy, review }) => (
          <InstallSettingsPanel settings={install.settings} problems={install.problems} facts={install.facts} busy={busy}
            onUpdate={(next) => review({ settings: next })} onDraft={(next) => { item.draft = next; }} />
        ) : item.kind === "uninstall" ? ({ busy, review }) => (
          <UninstallOptions checked={item.deleteData === true} busy={busy} onChange={(next) => review({ delete_data: next })} />
        ) : undefined}
        renderProgress={item.kind === "contacts" ? undefined : (p) => <InstallProgress {...p} action={action} onState={onJobState} />}
      />
    );
  }

  return (
    <InstallReviewsContext.Provider value={value}>
      {children}
      {dialog}
      <div ref={region} className={hasLines ? t.tray : t.idle} style={hasLines && lift > 0 ? { bottom: 20 + lift } : undefined}
        data-testid="install-review-status">
        <div role="status" aria-live="polite" className={t.lines}>
          {hasLines && (
            <ul className={t.list}>
              {lines.map((line) => (
                <li key={line.id} className={t.line} data-tone={line.tone}>
                  <span className={t.shape} aria-hidden="true" />
                  <span>{line.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {hasLines && (
          <button type="button" className={t.dismiss} onClick={dismiss}>
            Dismiss
          </button>
        )}
      </div>
    </InstallReviewsContext.Provider>
  );
}
