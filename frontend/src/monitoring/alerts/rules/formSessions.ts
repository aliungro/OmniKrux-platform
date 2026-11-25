// The rule form open in each Monitoring tab, kept outside the page (as M2's `editSessions` keep a
// dashboard's edit): switching tabs, or leaving Monitoring and coming back, finds the form as it was.
// A form with changes holds every way out of its tab (closing it, going elsewhere, Back, Forward)
// through MonitoringApp's leave check, and a reload or a closed browser tab asks first too.
//
// Small and free of the form's code, so MonitoringApp can read it without loading the Alerts page.

import type { AppTabs } from "../../../features/shell/workspace";
import { holdUnload } from "../../dashboards/drafts/useDraft";
import type { MonitoringTabAction, MonitoringView } from "../../shell/tabState";
import type { RuleOut, ScopeKind } from "../api";

/** Which form is open: a new rule (for a scope at first) or the edit of a rule. */
export type RuleFormOpen = { mode: "new"; scope?: { kind: ScopeKind; id: string } } | { mode: "edit"; rule: RuleOut };

/** What the form had when its page went away: given back when the page shows again. */
export interface RuleFormKept {
  /** The rule the form edits now (after Open it again, the one read then). */
  base: RuleOut | undefined;
  draft: unknown;
  start: unknown;
  /** The threshold as typed, which may not be a number yet. */
  thresholdText: string;
}

export interface RuleFormSession {
  open: RuleFormOpen;
  /** Names the form's mount: a new one starts fresh. */
  key: number;
  kept: RuleFormKept | null;
  /** Something would be lost: the draft moved from its start, or the threshold isn't a number. */
  changed: boolean;
  /** Its name for the leave question. */
  title: string;
}

/** By Monitoring tab id. */
export const ruleFormSessions = new Map<string, RuleFormSession>();

const unloadKey = (tabId: string) => `rule:${tabId}`;

export function startRuleForm(tabId: string, open: RuleFormOpen, key: number): void {
  ruleFormSessions.set(tabId, { open, key, kept: null, changed: false, title: open.mode === "edit" ? open.rule.name : NEW_TITLE });
  holdUnload(unloadKey(tabId), false);
}

export function keepRuleForm(tabId: string, kept: RuleFormKept, changed: boolean, title: string): void {
  const session = ruleFormSessions.get(tabId);
  if (!session) return;
  ruleFormSessions.set(tabId, { ...session, kept, changed, title });
  holdUnload(unloadKey(tabId), changed);
}

/** The form is closed (saved, cancelled, discarded) or its tab is gone. */
export function endRuleForm(tabId: string): void {
  ruleFormSessions.delete(tabId);
  holdUnload(unloadKey(tabId), false);
}

/** Tabs that are gone take their forms with them. */
export function pruneRuleForms(tabs: AppTabs<MonitoringView>): void {
  if (ruleFormSessions.size === 0 && alertFormMarks.size === 0) return;
  const ids = new Set(tabs.tabs.map((t) => t.id));
  for (const id of [...ruleFormSessions.keys()]) if (!ids.has(id)) endRuleForm(id);
  for (const id of [...alertFormMarks.keys()]) if (!ids.has(id)) clearAlertForms(id);
}

// --- the Silences and Contact points forms ----------------------------------------------------
// They keep nothing outside their page (never a secret), so leaving the page loses them: each one
// with changes marks its tab here (its title and where it lives, never what was typed), and every
// way out of that tab asks first, switching tabs included.

/** Where a marked form lives, and its name for the leave question. */
export interface AlertFormMark {
  title: string;
  /** The Alerts view it lives on (Silences, Contact points). */
  tab?: "silences" | "contacts";
  /** Or the Monitoring page it lives on (a Grafana connection form): any view of it keeps the form. */
  page?: MonitoringView["page"];
  /** With `page`: the item it is about (a source's own page): another item's page is a way out. */
  id?: string;
  /**
   * Holds only closing the tab: every other way out keeps the work (setup keeps its draft per tab),
   * and a reload keeps it too.
   */
  closeOnly?: boolean;
}

/** By Monitoring tab id, then by form. */
export const alertFormMarks = new Map<string, Map<string, AlertFormMark>>();

const formUnloadKey = (tabId: string, formId: string) => `form:${tabId}:${formId}`;

/** A form says whether it has changes (`mark`) or not (null). */
export function markAlertForm(tabId: string, formId: string, mark: AlertFormMark | null): void {
  const forms = alertFormMarks.get(tabId) ?? new Map<string, AlertFormMark>();
  if (mark) forms.set(formId, mark);
  else forms.delete(formId);
  if (forms.size > 0) alertFormMarks.set(tabId, forms);
  else alertFormMarks.delete(tabId);
  holdUnload(formUnloadKey(tabId, formId), mark !== null && !mark.closeOnly);
}

/** Discard in the leave question: the tab's forms no longer hold it (they go with the page). */
export function clearAlertForms(tabId: string): void {
  for (const formId of [...(alertFormMarks.get(tabId)?.keys() ?? [])]) markAlertForm(tabId, formId, null);
}

export const FORM_LEAVE_BODY = "Leaving loses what you entered in this form.";
export const SETUP_LEAVE_BODY = "Closing this tab loses the project you started setting up.";

/**
 * The tab an action would take a changed Silences or Contact points form away from, else null:
 * closing that tab; going to another page or another Alerts view (the form's own view is no way
 * out); Back or Forward to one; and, since such a form keeps nothing, switching to or opening
 * another tab while it is the active one. A close-only mark (setup) holds closing its tab only;
 * there a form's own mark wins, so the question names the form. The mark found comes back too.
 */
export function heldFormLeave(
  action: MonitoringTabAction,
  tabs: AppTabs<MonitoringView>,
  marks: ReadonlyMap<string, ReadonlyMap<string, AlertFormMark>> = alertFormMarks,
): { tabId: string; title: string; mark: AlertFormMark } | null {
  const first = (tabId: string, closing = false) => {
    const forms = [...(marks.get(tabId)?.values() ?? [])];
    const mark = forms.find((m) => !m.closeOnly) ?? (closing ? forms[0] : undefined);
    return mark ? { tabId, mark } : null;
  };
  if (action.type === "newTab" || action.type === "activateTab" || action.type === "nextTab" || action.type === "previousTab") {
    const found = first(tabs.active);
    if (!found) return null;
    if (action.type === "activateTab" && action.id === tabs.active) return null;
    if ((action.type === "nextTab" || action.type === "previousTab") && tabs.tabs.length < 2) return null;
    return { tabId: found.tabId, title: found.mark.title, mark: found.mark };
  }
  if (action.type !== "closeTab" && action.type !== "navigate" && action.type !== "back" && action.type !== "forward") return null;
  const found = first(action.id, action.type === "closeTab");
  if (!found) return null;
  const held = { tabId: action.id, title: found.mark.title, mark: found.mark };
  const { page, id, tab: alertsTab } = found.mark;
  const stays = (v: MonitoringView) =>
    (page !== undefined
      ? v.page === page && (id === undefined || ("id" in v && v.id === id))
      : v.page === "alerts" && (v.tab ?? "rules") === alertsTab);
  if (action.type === "closeTab") return held;
  const tab = tabs.tabs.find((t) => t.id === action.id);
  if (!tab) return null;
  if (action.type === "navigate") return stays(action.view) ? null : held;
  const history = action.type === "back" ? tab.back : tab.forward;
  if (history.length === 0) return null;
  return stays(history[history.length - 1]) ? null : held;
}

export const NEW_TITLE = "New alert rule";
export const RULE_LEAVE_BODY = "Leaving loses what you wrote in this rule.";

/**
 * The tab an action would leave with a rule form that has changes, else null: closing that tab;
 * navigating it to another page (the Alerts page itself is no way out: the form stays); Back or
 * Forward in it to another page.
 */
export function heldRuleLeave(
  action: MonitoringTabAction,
  tabs: AppTabs<MonitoringView>,
  sessions: ReadonlyMap<string, RuleFormSession> = ruleFormSessions,
): { tabId: string; title: string } | null {
  if (action.type !== "closeTab" && action.type !== "navigate" && action.type !== "back" && action.type !== "forward") return null;
  const session = sessions.get(action.id);
  if (!session || !session.changed) return null;
  const held = { tabId: action.id, title: session.title };
  if (action.type === "closeTab") return held;
  const tab = tabs.tabs.find((t) => t.id === action.id);
  if (!tab) return null;
  if (action.type === "navigate") return action.view.page === "alerts" ? null : held;
  const history = action.type === "back" ? tab.back : tab.forward;
  if (history.length === 0) return null;
  return history[history.length - 1].page === "alerts" ? null : held;
}
