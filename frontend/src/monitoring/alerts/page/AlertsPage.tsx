// The Alerts page (A2): a bar with the views (Rules, Silences, Contact points) and New alert rule,
// the note on OmniKrux's own checks, then the rules: a list with what fires now pinned on top and
// every rule under its project or group, and beside it the selected rule's details. The view's
// `tab` and `rule` are written with `replace` (the keyboard stays where it is): Back leaves the
// page, not each rule looked at. Rules and states are read again every 15 seconds; a read that
// fails says so and is never shown as current. New alert rule and Edit rule open the rule form in
// the details' place; picking another rule or leaving asks first about a form with changes.

import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MutableRefObject, type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { pageKey, pressed } from "../../../features/chrome/shortcuts";
import type { MonitoringPageProps } from "../../MonitoringApp";
import { useMonitoringTree } from "../../api/hooks";
import { currentOwner } from "../../dashboards/create/currentOwner";
import { readRecent } from "../../home/recent";
import { keyboardIsFree } from "../../pages/Gone";
import type { AlertsView, MonitoringView } from "../../shell/tabState";
import {
  alertsKeys, listRules, loudFiring, refreshAlerts, useAlertOverview,
  type AlertChangeOut, type AlertRequestError, type OverviewOut, type RuleChangeOut, type RuleOut,
} from "../api";
import { ContactPointsTab } from "../contacts/ContactPointsTab";
import { SilencesTab, type SilenceAsk } from "../silences/SilencesTab";
import { silencePrefill, type SilencePrefill } from "../silences/SilenceForm";
import { endRuleForm, ruleFormSessions, startRuleForm, type RuleFormOpen } from "../rules/formSessions";
import { RuleForm, type RuleFormHandle } from "../rules/RuleForm";
import { useToolReviews } from "../reviews/useToolReviews";
import { escapeCloses } from "../../focus";
import { EngineNote } from "./EngineNote";
import { listRows } from "./listModel";
import { RuleDetails } from "./RuleDetails";
import { RuleList } from "./RuleList";
import { clockTime, staleWords } from "./words";
import s from "./AlertsPage.module.css";

type Tab = NonNullable<AlertsView["tab"]>;
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "rules", label: "Rules" },
  { id: "silences", label: "Silences" },
  { id: "contacts", label: "Contact points" },
];

const REFETCH_MS = 15_000;
/** Under this width the list and the details stack: Enter opens the details, Esc goes back. */
const NARROW_QUERY = "(max-width: 719px)";
export const NO_RULES = "No alert rules yet. Make one here, or from a panel's Alert tab.";
const RULE_GONE = "That alert rule no longer exists. Pick another from the list.";
export const NOT_FIRING_NOW = "That alert isn't firing any more, so there's nothing to prefill.";

/** Keys the page takes: outside fields, dialogs, menus and pickers (the rule list is fine). */
function pageKeyHere(e: globalThis.KeyboardEvent): boolean {
  if (!pageKey(e)) return false;
  const t = e.target;
  return !(t instanceof Element && t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-dashboard-popup], [data-rule-form]'));
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

export default function AlertsPage({ view, nav, tabId }: MonitoringPageProps) {
  const alerts: AlertsView = view.page === "alerts" ? view : { page: "alerts" };
  const tab: Tab = alerts.tab ?? "rules";
  const ids = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const overview = useAlertOverview();
  const newButton = useRef<HTMLButtonElement>(null);
  // New alert rule, asked: the Rules view opens the form once it is there (and says so).
  const [newAsk, setNewAsk] = useState<number | null>(null);
  // Silence, asked from a rule: the Silences view opens its form prefilled, once.
  const [silenceAsk, setSilenceAsk] = useState<SilenceAsk | null>(null);
  const takeSilenceAsk = useCallback(() => setSilenceAsk(null), []);
  // Said in the Silences view when the alert asked about (from Home) stopped firing.
  const [silenceNote, setSilenceNote] = useState<string | null>(null);

  // The view as last written: a second write before the tab re-renders builds on the first.
  const navRef = useRef(nav);
  navRef.current = nav;
  const written = useRef(alerts);
  written.current = alerts;
  const write = useCallback((patch: { tab?: Tab; rule?: string | null }) => {
    const base = written.current;
    const nextTab = "tab" in patch ? patch.tab : base.tab;
    const nextRule = "rule" in patch ? patch.rule : base.rule;
    const next: AlertsView = { page: "alerts" };
    if (nextTab && nextTab !== "rules") next.tab = nextTab;
    if (nextRule) next.rule = nextRule;
    written.current = next;
    navRef.current.navigate(next, "replace");
  }, []);
  const open = useCallback((v: MonitoringView) => navRef.current.navigate(v, "push"), []);

  // Silence, asked from Home: decided on a read of the rules made for this ask (never on a list read
  // earlier, which may be out of date). The alert's place is prefilled once (as the rule details
  // do), or it says it stopped firing; then the view drops the ask, so Back or a reload never asks
  // again. A read that fails drops the ask and says nothing new.
  const client = useQueryClient();
  const asked = alerts.silence;
  const askedKey = asked ? `${asked.rule}\n${asked.target}` : null;
  useEffect(() => {
    if (!asked) return;
    let live = true;
    void client.fetchQuery<RuleOut[], AlertRequestError>({
      queryKey: alertsKeys.rules(), queryFn: ({ signal }) => listRules(undefined, signal), staleTime: 0, retry: false,
    }).then((rules) => {
      if (!live) return;
      const r = rules.find((x) => x.id === asked.rule);
      const t = r?.targets.find((x) => x.id === asked.target && !x.leaving);
      if (r && t && t.state === "firing") {
        setSilenceNote(null);
        setSilenceAsk((a) => ({ n: (a?.n ?? 0) + 1, prefill: silencePrefill(r, t) }));
      } else setSilenceNote(NOT_FIRING_NOW);
      write({ tab: "silences" });
    }, () => {
      if (live) write({ tab: "silences" });
    });
    return () => { live = false; };
    // Once per ask: `askedKey` names it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedKey]);
  useEffect(() => { if (tab !== "silences") setSilenceNote(null); }, [tab]);

  // The heading takes the keyboard when the page opens (unless the user is busy elsewhere).
  useEffect(() => { if (keyboardIsFree()) heading.current?.focus({ preventScroll: true }); }, []);

  // 1 2 3: the views. The keyboard goes to the view's tab, so it never stays on a list that went.
  const focusTab = useRef<Tab | null>(null);
  // Another view leaves an open rule form: it asks first when the form has changes.
  const leaveForm = useRef<((then: () => void) => void) | null>(null);
  const showTab = useCallback((next: Tab, viaKey: boolean) => {
    if (next === (written.current.tab ?? "rules")) {
      if (viaKey) tabRefs.current[next]?.focus();
      return;
    }
    const go = () => {
      if (viaKey) focusTab.current = next;
      write({ tab: next });
    };
    if (leaveForm.current) leaveForm.current(go);
    else go();
  }, [write]);
  // After the commit's other effects: a question closing as the view changes hands the keyboard back
  // to where it was asked from, and the view's tab takes it after that.
  useEffect(() => {
    if (focusTab.current === tab) {
      focusTab.current = null;
      tabRefs.current[tab]?.focus();
    }
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pageKeyHere(e) || !pressed("alertsViews", e)) return;
      e.preventDefault();
      if (e.repeat) return;
      showTab(TABS[Number(e.key) - 1].id, true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showTab]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? TABS[(at + 1) % TABS.length]
      : e.key === "ArrowLeft" ? TABS[(at - 1 + TABS.length) % TABS.length]
      : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    showTab(next.id, true);
  };

  const firing = overview.data ? loudFiring(overview.data.counts) : 0;
  // The overview's last good read, when a later one failed: kept, and said to be old.
  const overviewStaleAt = overview.isError && overview.data ? overview.dataUpdatedAt : null;
  return (
    <div className={s.page}>
      <header className={s.bar}>
        <h1 ref={heading} tabIndex={-1} className={s.title}>Alerts</h1>
        <div role="tablist" aria-label="Alerts views" className={s.tabs} onKeyDown={onTabKey}>
          {TABS.map((t, i) => {
            const on = t.id === tab;
            return (
              <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} id={`${ids}-tab-${t.id}`} type="button" role="tab"
                aria-selected={on} aria-controls={on ? `${ids}-panel` : undefined} tabIndex={on ? 0 : -1} aria-keyshortcuts={String(i + 1)}
                className={s.tab} onClick={() => showTab(t.id, false)}>
                {t.label}
                {t.id === "rules" && firing > 0 && (
                  <span className={s.tabCount} data-stale={overviewStaleAt !== null || undefined}
                    aria-label={overviewStaleAt === null ? `${firing} firing` : `${firing} firing at ${clockTime(new Date(overviewStaleAt).toISOString())}`}>
                    {firing}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button ref={newButton} type="button" className={s.primary}
          onClick={() => {
            if (tab !== "rules") write({ tab: "rules" });
            setNewAsk((n) => (n ?? 0) + 1);
          }}>
          New alert rule
        </button>
      </header>
      <EngineNote overview={overview.data} error={overview.error} staleAt={overviewStaleAt} />
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className={s.panel}>
        {tab === "rules" ? (
          <RulesView alerts={alerts} write={write} open={open} overview={overview.data} overviewStaleAt={overviewStaleAt}
            refetchOverview={() => void overview.refetch()}
            overviewSettled={overview.data !== undefined || overview.isError} pageHeading={heading}
            newAsk={newAsk} onNewTaken={() => setNewAsk(null)} newButton={newButton}
            openContactPoints={() => write({ tab: "contacts" })} tabId={tabId} leaveForm={leaveForm}
            onSilence={(prefill) => {
              setSilenceAsk((a) => ({ n: (a?.n ?? 0) + 1, prefill }));
              write({ tab: "silences" });
            }} />
        ) : tab === "silences" ? (
          <SilencesTab ask={silenceAsk} onAskTaken={takeSilenceAsk} leaveRef={leaveForm} tabId={tabId} note={silenceNote} />
        ) : (
          <ContactPointsTab leaveRef={leaveForm} tabId={tabId} />
        )}
      </div>
    </div>
  );
}

// --- The Rules view: list and details --------------------------------------------------------------

interface RulesViewProps {
  alerts: AlertsView;
  write(patch: { rule?: string | null }): void;
  open(view: MonitoringView): void;
  overview: OverviewOut | undefined;
  /** When the overview shown was read, if a later read failed; else null. */
  overviewStaleAt: number | null;
  refetchOverview(): void;
  /** The overview answered (or failed): what fires is known, so the first row won't move. */
  overviewSettled: boolean;
  pageHeading: RefObject<HTMLHeadingElement | null>;
  /** New alert rule was pressed (a new number each time); `onNewTaken` once the form is opening. */
  newAsk: number | null;
  onNewTaken(): void;
  newButton: RefObject<HTMLButtonElement | null>;
  openContactPoints(): void;
  /** The Monitoring tab: its open rule form is kept for it while the page is away. */
  tabId: string;
  /** Set to the way out of an open form, for the page's views. */
  leaveForm: MutableRefObject<((then: () => void) => void) | null>;
  /** Silence on the shown rule: the Silences view with this silence prefilled. */
  onSilence(prefill: SilencePrefill): void;
}

type FormState = RuleFormOpen;

function RulesView({
  alerts, write, open, overview, overviewStaleAt, refetchOverview, overviewSettled, pageHeading, newAsk, onNewTaken, newButton,
  openContactPoints, tabId, leaveForm: leaveFormRef, onSilence,
}: RulesViewProps) {
  const client = useQueryClient();
  const reviews = useToolReviews();
  const tree = useMonitoringTree();
  const detailsId = useId();
  const narrow = useNarrow();
  const rules = useQuery<RuleOut[], AlertRequestError>({
    queryKey: alertsKeys.rules(), queryFn: ({ signal }) => listRules(undefined, signal), refetchInterval: REFETCH_MS, retry: false,
  });
  // "Now" for the list's and the details' durations, moved on with each read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REFETCH_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { setNow(Date.now()); }, [rules.dataUpdatedAt, overview]);

  // A failed refresh keeps the last good list (and the details, a dialog, a menu, the keyboard)
  // and says how old it is, until a read works again. Only a first read that fails shows nothing.
  const data = rules.data;
  const rulesStaleAt = rules.isError && rules.data ? rules.dataUpdatedAt : null;
  const staleAt = rulesStaleAt === null ? overviewStaleAt : overviewStaleAt === null ? rulesStaleAt : Math.min(rulesStaleAt, overviewStaleAt);
  const refreshAll = () => {
    if (rulesStaleAt !== null) void rules.refetch();
    if (overviewStaleAt !== null) refetchOverview();
  };
  const rows = useMemo(() => (data ? listRows(data, overview, now) : []), [data, overview, now]);
  const ruleRows = useMemo(() => rows.filter((r) => r.kind === "rule"), [rows]);

  // The selection: the view's rule, else the first in the list once what fires is known. That first
  // one stays shown while it is listed, so a later read that pins another rule doesn't move it.
  const fallback = useRef<string | null>(null);
  if (overviewSettled && (fallback.current === null || !ruleRows.some((r) => r.ruleId === fallback.current))) {
    fallback.current = ruleRows[0]?.ruleId ?? null;
  }
  const selectedId = alerts.rule ?? (overviewSettled ? fallback.current : null);
  const [picked, setPicked] = useState<string | null>(null);
  const active = ruleRows.find((r) => r.key === picked && r.ruleId === selectedId) ?? ruleRows.find((r) => r.ruleId === selectedId) ?? null;
  const rule = data?.find((r) => r.id === selectedId) ?? null;

  const rowEls = useRef(new Map<string, HTMLElement>());
  const rowRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) rowEls.current.set(key, el);
    else rowEls.current.delete(key);
  }, []);
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const [showDetails, setShowDetails] = useState(false);
  const want = useRef<"details" | "row" | "new" | null>(null);

  // The rule form, in the details' place. A form with changes is asked about before it goes.
  // The form open in this tab is kept for it (formSessions): it comes back when the page does.
  const [form, setFormState] = useState<FormState | null>(() => ruleFormSessions.get(tabId)?.open ?? null);
  const [formKey, setFormKey] = useState(() => ruleFormSessions.get(tabId)?.key ?? 0);
  const formRef = useRef<RuleFormHandle>(null);
  const closeForm = () => {
    setFormState(null);
    endRuleForm(tabId);
  };
  const leaveForm = (then: () => void) => {
    if (form && formRef.current) formRef.current.requestClose(() => { closeForm(); then(); });
    else then();
  };
  leaveFormRef.current = form ? leaveForm : null;
  const shownForm = useRef({ form, formKey });
  shownForm.current = { form, formKey };
  useEffect(() => {
    // Mounted again (StrictMode, or a page shown again) with its form: it is kept again.
    const { form: f, formKey: k } = shownForm.current;
    if (f && !ruleFormSessions.has(tabId)) startRuleForm(tabId, f, k);
    return () => {
      leaveFormRef.current = null;
      // The page goes away: a form with nothing to lose goes with it; one with changes stays kept.
      if (ruleFormSessions.get(tabId)?.changed === false) endRuleForm(tabId);
    };
  }, [tabId, leaveFormRef]);
  const openForm = (next: FormState) => leaveForm(() => {
    const key = formKey + 1;
    startRuleForm(tabId, next, key);
    setFormState(next);
    setFormKey(key);
    if (narrow) setShowDetails(true);
  });
  // The changes a save hands on: queued once the saved rule's details have the keyboard.
  const savedChanges = useRef<AlertChangeOut[] | null>(null);

  const focusRow = useCallback(() => {
    const el = active ? rowEls.current.get(active.key) : undefined;
    (el ?? pageHeading.current)?.focus({ preventScroll: false });
  }, [active, pageHeading]);

  const pick = (key: string, how: "click" | "key") => {
    if (form) leaveForm(() => choose(key, how));
    else choose(key, how);
  };
  const choose = (key: string, how: "click" | "key") => {
    const row = ruleRows.find((r) => r.key === key);
    if (!row?.ruleId) return;
    setPicked(key);
    if (row.ruleId !== alerts.rule) write({ rule: row.ruleId });
    if (how === "key") rowEls.current.get(key)?.focus();
    else if (narrow) {
      want.current = "details";
      setShowDetails(true);
    }
  };
  const enter = () => {
    if (narrow) {
      want.current = "details";
      setShowDetails(true);
    } else detailsHeading.current?.focus();
  };
  const escape = () => {
    if (form) leaveForm(back);
    else back();
  };
  const back = () => {
    if (narrow) {
      want.current = "row";
      setShowDetails(false);
    } else focusRow();
  };

  // The keyboard follows Enter and Esc on a narrow window once the other side is drawn; and a part
  // that went away with it (a refreshed row, a Retry that's done) hands it on: never to <body>.
  const last = useRef<{ el: HTMLElement; zone: "list" | "details" | "other" } | null>(null);
  useLayoutEffect(() => {
    if (want.current === "details" && detailsHeading.current) {
      want.current = null;
      detailsHeading.current.focus();
      const changes = savedChanges.current;
      savedChanges.current = null;
      if (changes) reviews.enqueue(changes, { focus: detailsHeading.current });
    } else if (want.current === "new") {
      want.current = null;
      (newButton.current ?? pageHeading.current)?.focus();
    } else if (want.current === "row" && (!narrow || !showDetails)) {
      want.current = null;
      focusRow();
    }
    const lost = last.current;
    const activeEl = document.activeElement;
    if (lost && !lost.el.isConnected && (activeEl === null || activeEl === document.body)) {
      last.current = null;
      if (lost.zone === "details" && detailsHeading.current) detailsHeading.current.focus({ preventScroll: true });
      else focusRow();
    }
  });
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const zone = el.closest("[data-alerts-list]") ? "list" : el.closest("[data-alerts-details]") ? "details" : "other";
    last.current = { el, zone };
  };

  // After a delete: the next rule (or the one before), else the page's heading.
  const nextAfter = useCallback((ruleId: string) => {
    const at = active ? ruleRows.indexOf(active) : -1;
    const after = ruleRows.slice(at + 1).find((r) => r.ruleId !== ruleId);
    const before = [...ruleRows.slice(0, Math.max(0, at))].reverse().find((r) => r.ruleId !== ruleId);
    return after ?? before ?? null;
  }, [active, ruleRows]);
  const deleted = (gone: RuleOut, changes: AlertChangeOut[], restore: RefObject<HTMLElement | null>) => {
    const next = nextAfter(gone.id);
    setPicked(next?.key ?? null);
    write({ rule: next?.ruleId ?? null });
    if (narrow) setShowDetails(false);
    void refreshAlerts(client);
    reviews.enqueue(changes, { focus: restore.current });
  };

  // New alert rule: for the owner new dashboards go to (the sidebar's), else the first project by name.
  useEffect(() => {
    if (newAsk === null) return;
    onNewTaken();
    const owner = tree.data ? currentOwner(alerts, tree.data, readRecent()) : null;
    openForm({ mode: "new", ...(owner ? { scope: { kind: owner.kind, id: owner.id } } : {}) });
    // Once per press: `newAsk` is a new number each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newAsk]);

  const cancelForm = () => {
    closeForm();
    want.current = rule ? "details" : "new";
    if (narrow && !rule) setShowDetails(false);
  };
  const saved = (change: RuleChangeOut) => {
    const made = change.rule;
    closeForm();
    if (!made) return;
    // Shown at once (the list is read again too), selected, with the keyboard on its name.
    client.setQueryData<RuleOut[]>(alertsKeys.rules(), (old) =>
      !old ? [made] : old.some((r) => r.id === made.id) ? old.map((r) => (r.id === made.id ? made : r)) : [...old, made]);
    client.setQueryData(alertsKeys.rule(made.id), made);
    setPicked(null);
    if (made.id !== alerts.rule) write({ rule: made.id });
    savedChanges.current = change.changes;
    want.current = "details";
    if (narrow) setShowDetails(true);
    void refreshAlerts(client);
  };
  const afterDelete = (gone: RuleOut) => {
    const next = nextAfter(gone.id);
    return (next ? rowEls.current.get(next.key) : undefined) ?? pageHeading.current;
  };

  // Silence: the rule's first place it is checked in (a group rule's other projects can be edited in the form).
  const silenceTarget = rule ? (rule.targets.find((t) => !t.leaving) ?? rule.targets[0]) : undefined;
  const silenceRule = rule && silenceTarget ? () => onSilence(silencePrefill(rule, silenceTarget)) : undefined;
  const silenceRef = useRef(silenceRule);
  silenceRef.current = form ? undefined : silenceRule;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pageKeyHere(e) || !pressed("alertSilence", e) || !silenceRef.current) return;
      e.preventDefault();
      if (!e.repeat) silenceRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  let list;
  if (!data) {
    list = rules.isError ? (
      <div className={s.listNote} data-tone="warn" role="alert">
        <p>The alert rules couldn't be read. {failure(rules.error, "try again")}</p>
        <button type="button" className={s.button} onClick={() => void rules.refetch()}>Try again</button>
      </div>
    ) : <p className={s.listNote} role="status">Loading…</p>;
  } else if (ruleRows.length === 0) {
    list = <p className={s.listNote}>{NO_RULES}</p>;
  } else {
    list = <RuleList rows={rows} activeKey={active?.key ?? null} onPick={pick} onEnter={enter} rowRef={rowRef} detailsId={detailsId} />;
  }

  let details = null;
  if (form) {
    details = (
      <RuleForm key={formKey} ref={formRef} initial={form.mode === "edit" ? form.rule : undefined}
        scope={form.mode === "new" ? form.scope : undefined} headingRef={detailsHeading} tabId={tabId}
        onSaved={saved} onCancel={cancelForm} onOpenContactPoints={() => { closeForm(); openContactPoints(); }} />
    );
  } else if (rule) {
    details = (
      <RuleDetails key={rule.id} id={detailsId} rule={rule} now={now} headingRef={detailsHeading} onOpen={open} onEscape={escape}
        afterDelete={() => afterDelete(rule)} onDeleted={(changes, restore) => deleted(rule, changes, restore)}
        onEdit={rule.origin === "page" ? () => openForm({ mode: "edit", rule }) : undefined} onSilence={silenceRule} />
    );
  } else if (data && alerts.rule) {
    details = <p className={s.detailsNote} data-alerts-gone="">{RULE_GONE}</p>;
  }

  const stacked = narrow && data !== undefined && (ruleRows.length > 0 || form !== null);
  return (
    <>
      {/* Always present, so the note is announced when it appears. */}
      <div role="status" aria-live="polite" className={staleAt === null ? s.staleIdle : s.stale} data-tone="warn">
        {staleAt !== null && (
          <>
            <p>{staleWords(staleAt)}</p>
            <button type="button" className={s.barButton} onClick={refreshAll}>Try again</button>
          </>
        )}
      </div>
    <div className={s.split} data-narrow={narrow || undefined} onFocus={onFocus}>
      <div className={s.left} data-alerts-list="" hidden={stacked && showDetails}>
        {list}
      </div>
      {details && (
        <div className={s.right} data-alerts-details="" hidden={stacked && !showDetails}>
          {stacked && (
            <button type="button" className={s.back} onClick={escape} onKeyDown={escapeCloses(escape)}>Back to the rules</button>
          )}
          {details}
        </div>
      )}
    </div>
    </>
  );
}
