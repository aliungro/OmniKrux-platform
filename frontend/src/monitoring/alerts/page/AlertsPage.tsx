// The Alerts page (A2): a bar with the views (Rules, Silences, Contact points) and New alert rule,
// the note on OmniKrux's own checks, then the rules: a list with what fires now pinned on top and
// every rule under its project or group, and beside it the selected rule's details. The view's
// `tab` and `rule` are written with `replace` (the keyboard stays where it is): Back leaves the
// page, not each rule looked at. Rules and states are read again every 15 seconds; a read that
// fails says so and is never shown as current.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { pageKey, pressed } from "../../../features/chrome/shortcuts";
import { invalidateMonitoring } from "../../api/hooks";
import type { MonitoringPageProps } from "../../MonitoringApp";
import { keyboardIsFree } from "../../pages/Gone";
import type { AlertsView, MonitoringView } from "../../shell/tabState";
import { alertsKeys, listRules, useAlertOverview, type AlertChangeOut, type AlertRequestError, type OverviewOut, type RuleOut } from "../api";
import { useToolReviews } from "../reviews/useToolReviews";
import { EngineNote } from "./EngineNote";
import { listRows } from "./listModel";
import { RuleDetails, LATER } from "./RuleDetails";
import { RuleList } from "./RuleList";
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

/** Keys the page takes: outside fields, dialogs, menus and pickers (the rule list is fine). */
function pageKeyHere(e: globalThis.KeyboardEvent): boolean {
  if (!pageKey(e)) return false;
  const t = e.target;
  return !(t instanceof Element && t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [data-dashboard-popup]'));
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

export default function AlertsPage({ view, nav }: MonitoringPageProps) {
  const alerts: AlertsView = view.page === "alerts" ? view : { page: "alerts" };
  const tab: Tab = alerts.tab ?? "rules";
  const ids = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const overview = useAlertOverview();

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

  // The heading takes the keyboard when the page opens (unless the user is busy elsewhere).
  useEffect(() => { if (keyboardIsFree()) heading.current?.focus({ preventScroll: true }); }, []);

  // 1 2 3: the views. The keyboard goes to the view's tab, so it never stays on a list that went.
  const focusTab = useRef<Tab | null>(null);
  const showTab = useCallback((next: Tab, viaKey: boolean) => {
    if (viaKey) focusTab.current = next;
    if (next !== (written.current.tab ?? "rules")) write({ tab: next });
    else if (viaKey) tabRefs.current[next]?.focus();
  }, [write]);
  useLayoutEffect(() => {
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

  const firing = overview.data?.counts.firing ?? 0;
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
                {t.id === "rules" && firing > 0 && <span className={s.tabCount} aria-label={`${firing} firing`}>{firing}</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className={s.primary} aria-disabled="true" title={LATER}>New alert rule</button>
      </header>
      <EngineNote overview={overview.data} error={overview.error} />
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className={s.panel}>
        {tab === "rules" ? (
          <RulesView alerts={alerts} write={write} open={open} overview={overview.data}
            overviewSettled={overview.data !== undefined || overview.isError} pageHeading={heading} />
        ) : (
          <p className={s.later}>{tab === "silences" ? "Silences" : "Contact points"}: {LATER}</p>
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
  /** The overview answered (or failed): what fires is known, so the first row won't move. */
  overviewSettled: boolean;
  pageHeading: RefObject<HTMLHeadingElement | null>;
}

function RulesView({ alerts, write, open, overview, overviewSettled, pageHeading }: RulesViewProps) {
  const client = useQueryClient();
  const reviews = useToolReviews();
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

  // A failed read shows no rules: what was read before is no longer current.
  const data = rules.isError ? undefined : rules.data;
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
  const want = useRef<"details" | "row" | null>(null);

  const focusRow = useCallback(() => {
    const el = active ? rowEls.current.get(active.key) : undefined;
    (el ?? pageHeading.current)?.focus({ preventScroll: false });
  }, [active, pageHeading]);

  const pick = (key: string, how: "click" | "key") => {
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
    void invalidateMonitoring(client);
    reviews.enqueue(changes, { focus: restore.current });
  };
  const afterDelete = (gone: RuleOut) => {
    const next = nextAfter(gone.id);
    return (next ? rowEls.current.get(next.key) : undefined) ?? pageHeading.current;
  };

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
  if (rule) {
    details = (
      <RuleDetails key={rule.id} id={detailsId} rule={rule} now={now} headingRef={detailsHeading} onOpen={open} onEscape={escape}
        afterDelete={() => afterDelete(rule)} onDeleted={(changes, restore) => deleted(rule, changes, restore)} />
    );
  } else if (data && alerts.rule) {
    details = <p className={s.detailsNote} data-alerts-gone="">{RULE_GONE}</p>;
  }

  const stacked = narrow && data !== undefined && ruleRows.length > 0;
  return (
    <div className={s.split} data-narrow={narrow || undefined} onFocus={onFocus}>
      <div className={s.left} data-alerts-list="" hidden={stacked && showDetails}>
        {list}
      </div>
      {details && (
        <div className={s.right} data-alerts-details="" hidden={stacked && !showDetails}>
          {stacked && (
            <button type="button" className={s.back} onClick={escape}>Back to the rules</button>
          )}
          {details}
        </div>
      )}
    </div>
  );
}
