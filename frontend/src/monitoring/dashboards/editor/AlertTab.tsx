// The Alert tab (E2): a panel's alert as the rule form writes it, on the panel's own query. The
// condition is one sentence, how often it would have fired is checked as you type (its advice shows
// in the recommendation bar above the tabs, as `calmerThreshold`), then who hears about it and where
// it runs. Every change goes into the draft at once (`updatePanel`), so the JSON tab and the draft
// agree; the alert is saved with the dashboard, and its rule appears on the Alerts page.
//
// This module also registers the `calmerThreshold` recommendation, so it loads with the editor.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject } from "react";
import { failure } from "../../../api/http";
import type { GroupOut, ProjectOut } from "../../api/types";
import {
  useCapabilities, useChannels, useContactPoints, usePanelStates,
  type ContactPointOut, type DryRunIn, type DryRunOut, type PanelAlertStateOut, type ScopeKind,
} from "../../alerts/api";
import { durationWords, notRefreshedWords, seriesWord, STATE_LABEL, STATE_UNKNOWN, stateTone } from "../../alerts/format";
import { ALERT_PANEL_TYPES } from "../../alerts/limits";
import { ruleExpr } from "../../alerts/ruleExpr";
import { mixedClusterWarnings } from "../../alerts/rules/clusterWarning";
import { adviceFor, calmerWords, DryRunLine, thresholdText } from "../../alerts/rules/DryRunLine";
import { installedOf, RuleDetailsFields, type DetailsValue } from "../../alerts/rules/RuleDetailsFields";
import { parseThreshold, RuleSentence, seriesWordOf, type SentenceValue } from "../../alerts/rules/RuleSentence";
import { WhereItRuns } from "../../alerts/rules/WhereItRuns";
import r from "../../alerts/rules/RuleForm.module.css";
import { registerRecommendationRule, RULES, type RecommendationRule } from "../../build/recommend";
import { sameJson } from "../sameJson";
import type { DashboardOwner, PanelData } from "../runPanel";
import { newAlert, validateDashboard, type DashboardSpec, type OwnerKind, type PanelAlert, type PanelSpec, type Problem } from "../schema";
import type { PanelUpdate } from "./SidePanel";
import s from "./SidePanel.module.css";

// --- copy -------------------------------------------------------------------------------------

export const NO_ALERT = "This panel has no alert.";
export const ADD_ALERT = "Add an alert";
export const cantHaveAlert = (type: string) => `A ${type} panel can't have an alert. Use a time series, stat, gauge or bar panel.`;
export const BAND_NOTE = "On the chart, the dashed line and shaded area show where the alert would fire.";
export const REMOVE_NOTE = "Removing the alert deletes its rule when you save.";
export const savedWithWords = (where: string) =>
  `Saved with the dashboard; it also appears on the Alerts page under ${where}, with a link back to this panel.`;
export const defaultsWords = (parts: string[]) => `Alerts use each variable's default: ${parts.join(", ")}.`;
export const nowWords = (state: PanelAlertStateOut, now: number) => {
  const since = state.since === null ? Number.NaN : Date.parse(state.since);
  const label = STATE_LABEL[state.state];
  return Number.isFinite(since) ? `Now: ${label} for ${durationWords((now - since) / 1000)}` : `Now: ${label}`;
};
/** Said under "In the tool" while what the projects can do is being read (the rule form's words). */
const CHECKING_WHERE = "Checking where it can run…";
/** A contact point the alert names that the list doesn't have (deleted since): shown, so it can be unticked. */
const UNKNOWN_CONTACT = "A contact point that no longer exists";

// --- the threshold to start from ------------------------------------------------------------

/** `x` rounded up to two significant digits (0.312 → 0.32, 1234 → 1300); 0 stays 0. */
export function roundUp2(x: number): number {
  if (!Number.isFinite(x) || x === 0) return 0;
  const step = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 1);
  const q = Number((x / step).toPrecision(12));
  return Number((Math.ceil(q) * step).toPrecision(2));
}

/** The current maximum of the query a new alert reads (`newAlert`'s), rounded up; 0 without data. */
export function startThreshold(panel: PanelSpec, data: PanelData | null): number {
  if (data === null || (data.state !== "ready" && data.state !== "partial")) return 0;
  const ref = (panel.queries.find((q) => !q.hidden) ?? panel.queries[0])?.ref;
  let max = -Infinity;
  for (const series of data.series) {
    if (series.queryRef !== ref) continue;
    for (const [, y] of series.points) if (y !== null && Number.isFinite(y) && y > max) max = y;
  }
  return max === -Infinity ? 0 : roundUp2(max);
}

// --- the dry run and the recommendation ------------------------------------------------------

/** The last dry run of a panel's alert, as the recommendation bar reads it (`ctx.alert`). */
export interface AlertDryRun {
  alert: PanelAlert;
  dryRun: DryRunOut;
}

/**
 * What a dry run answers for: the panel, its alert's condition and the query it reads. A kept
 * answer counts only while this is unchanged (a name or a contact point doesn't change it).
 */
export function alertRunKey(panel: PanelSpec): string {
  const a = panel.alert;
  if (a === null) return "";
  const q = panel.queries.find((x) => x.ref === a.query);
  return JSON.stringify([panel.id, a.query, a.of, a.op, a.threshold, a.for, a.every, q?.expr ?? null, q?.source ?? null]);
}

const isAlertDryRun = (x: unknown): x is AlertDryRun =>
  typeof x === "object" && x !== null && "alert" in x && "dryRun" in x && (x as AlertDryRun).alert !== null;

/**
 * Over the last 6 hours this alert fired often (3 times or more), and a calmer threshold would have
 * fired at most once: advise it. Reads the Alert tab's last dry run (`ctx.alert`), never asks the
 * server itself, and says nothing when part of the data couldn't be read.
 */
export const calmerThresholdRule: RecommendationRule = {
  id: "calmerThreshold",
  evaluate({ panel, alert }) {
    const a = panel.alert;
    if (a === null || !isAlertDryRun(alert)) return null;
    const seen = alert.alert;
    if (seen.op !== a.op || seen.threshold !== a.threshold || seen.query !== a.query || seen.of !== a.of || seen.for !== a.for || seen.every !== a.every) return null;
    const tip = adviceFor(alert.dryRun, a.op, a.threshold);
    if (tip === null) return null;
    const from = a.threshold;
    const to = tip.threshold;
    return {
      id: "calmerThreshold",
      key: `calmerThreshold:${panel.id}:${from}`,
      text: ["That's often. At ", { strong: thresholdText(to) }, ` it ${calmerWords(tip.fired)}.`],
      applyLabel: `Use ${thresholdText(to)}`,
      apply: (p) => (p.alert !== null && p.alert.threshold === from ? { ...p, alert: { ...p.alert, threshold: to } } : p),
    };
  },
};

// Registered once, however often this module is evaluated (tests reset modules; HMR reloads them).
if (!RULES.some((rule) => rule.id === calmerThresholdRule.id)) registerRecommendationRule(calmerThresholdRule);

// --- problems ---------------------------------------------------------------------------------

type ProblemField = "name" | "query" | "threshold" | "for" | "message" | "contact_point_ids" | "channel" | "other";

/** Where a problem at `alert.<rest>` shows. */
function fieldOf(rest: string): ProblemField {
  const key = rest.split(/[.[]/)[0];
  if (key === "notify") return "contact_point_ids";
  if (key === "name" || key === "query" || key === "threshold" || key === "for" || key === "message" || key === "channel") return key;
  return "other";
}

/** This panel's alert problems (`panels[i].alert…`), by field; each message once. */
export function alertProblems(problems: readonly Problem[], index: number): Partial<Record<ProblemField, string[]>> {
  const prefix = `panels[${index}].alert`;
  const out: Partial<Record<ProblemField, string[]>> = {};
  for (const p of problems) {
    if (p.path !== prefix && !p.path.startsWith(`${prefix}.`) && !p.path.startsWith(`${prefix}[`)) continue;
    const field = p.path === prefix ? "other" : fieldOf(p.path.slice(prefix.length + 1));
    const list = (out[field] ??= []);
    if (!list.includes(p.message)) list.push(p.message);
  }
  return out;
}

// --- the tab ----------------------------------------------------------------------------------

const NO_PROBLEMS: readonly Problem[] = [];
/** The alert value a refused path (`alert.<key>…`) is about. */
const FIELD_KEY: Record<string, keyof PanelAlert> = {
  name: "name", query: "query", of: "of", op: "op", threshold: "threshold", for: "for", every: "every", severity: "severity",
  message: "message", notify: "notify", engine: "engine", channel: "channel",
};

const VAR_USE = (name: string) => new RegExp(String.raw`\$(?:\{${name}(?:[:}])|${name}(?![A-Za-z0-9_]))|\[\[${name}\]\]`);

/** `name = All`, `name = prod`, `name = a or b` for each variable the query uses. */
function defaultsOf(expr: string, spec: DashboardSpec): string[] {
  return spec.variables.filter((v) => VAR_USE(v.name).test(expr)).map((v) => {
    const value = v.default === "all" ? "All" : v.default.length === 0 ? "none" : v.default.join(" or ");
    return `${v.name} = ${value}`;
  });
}

type Scope = { kind: ScopeKind; id: string };

function scopeOf(owner: DashboardOwner | null): { scope: Scope; where: string; projects: ProjectOut[]; groups: GroupOut[]; projectIds: string[] } | null {
  if (owner === null) return null;
  if (owner.kind === "project") {
    return { scope: { kind: "project", id: owner.project.id }, where: owner.project.name, projects: [owner.project], groups: [], projectIds: [owner.project.id] };
  }
  return {
    scope: { kind: "group", id: owner.group.id }, where: `Group · ${owner.group.name}`, projects: owner.members, groups: [owner.group],
    projectIds: owner.members.map((p) => p.id),
  };
}

export interface AlertTabProps {
  panel: PanelSpec;
  update: PanelUpdate;
  owner: DashboardOwner | null;
  ownerKind: OwnerKind;
  panelData: PanelData | null;
  /** The draft: its variables, and the place of the panel for its problems. */
  spec: DashboardSpec;
  dashboardId: string;
  /** The panel's alert as saved (null: none saved, or a new panel). */
  saved: PanelAlert | null;
  /** A save's refusal (422), for problems the browser can't see (a contact point that's gone). */
  saveProblems?: readonly Problem[];
  /** The threshold as typed when it isn't a number (kept with the edit session), else undefined. */
  thresholdText?: string;
  /** The threshold as typed: `text` while it isn't a number, null once it is. */
  onThresholdText?(text: string | null): void;
  /** The last dry run of the alert as written (with `alertRunKey` of the panel it answered for), or null while there is none. */
  onDryRun?(run: AlertDryRun | null, key: string): void;
  /** Opens the Alerts page on the rule (a new workspace tab with Ctrl). */
  onOpenRule?(ruleId: string, newTab: boolean): void;
  /** The side panel puts the keyboard here when it opens on this tab (the first field with a problem, else Threshold). */
  focusRef?: MutableRefObject<(() => void) | null>;
}

export function AlertTab(props: AlertTabProps) {
  const { panel, update, panelData, focusRef } = props;
  const addRef = useRef<HTMLButtonElement | null>(null);
  const thresholdRef = useRef<HTMLInputElement | null>(null);
  // Add an alert puts the keyboard on Threshold; Remove alert on Add an alert (never on <body>).
  const [focusNext, setFocusNext] = useState<"threshold" | "add" | null>(null);
  useLayoutEffect(() => {
    if (focusNext === null) return;
    setFocusNext(null);
    (focusNext === "threshold" ? thresholdRef.current : addRef.current)?.focus();
  }, [focusNext]);

  if (!ALERT_PANEL_TYPES.includes(panel.type)) {
    if (focusRef) focusRef.current = null;
    return <p className={s.alertQuiet}>{cantHaveAlert(panel.type)}</p>;
  }
  if (panel.alert === null) {
    if (focusRef) focusRef.current = () => addRef.current?.focus();
    const add = () => {
      update((p) => (p.alert === null ? { ...p, alert: newAlert(p, startThreshold(p, panelData)) } : p));
      setFocusNext("threshold");
    };
    return (
      <div className={s.alertEmpty}>
        <p className={s.alertQuiet}>{NO_ALERT}</p>
        {props.saved !== null && <p className={s.alertNote}>{REMOVE_NOTE}</p>}
        <button ref={addRef} type="button" className={s.add} onClick={add}>{ADD_ALERT}</button>
      </div>
    );
  }
  return <AlertForm {...props} alert={panel.alert} thresholdRef={thresholdRef}
    onRemoved={() => setFocusNext("add")} />;
}

function AlertForm({
  panel, update, owner, ownerKind, spec, dashboardId, saved, saveProblems = NO_PROBLEMS, onDryRun, onOpenRule, focusRef, alert, thresholdRef, onRemoved,
  thresholdText, onThresholdText,
}: AlertTabProps & { alert: PanelAlert; thresholdRef: MutableRefObject<HTMLInputElement | null>; onRemoved(): void }) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLInputElement>(null);
  const notifyRef = useRef<HTMLInputElement>(null);
  const channelRef = useRef<HTMLSelectElement>(null);
  const forRef = useRef<HTMLSelectElement>(null);
  const querySelectRef = useRef<HTMLSelectElement>(null);
  const contactPoints = useContactPoints();
  const where = scopeOf(owner);
  const query = panel.queries.find((q) => q.ref === alert.query) ?? null;

  const set = (patch: Partial<PanelAlert>) => update((p) => (p.alert === null ? p : { ...p, alert: { ...p.alert, ...patch } }));

  // Problems: the document walker's on the draft, and a save's refusal for this panel's alert. A
  // refused field's words go once that field changes (the refusal was about what it held then).
  const index = spec.panels.findIndex((p) => p.id === panel.id);
  const [refusedFor, setRefusedFor] = useState({ problems: saveProblems, alert });
  if (refusedFor.problems !== saveProblems) setRefusedFor({ problems: saveProblems, alert });
  const problems = useMemo(() => {
    const checked = validateDashboard(spec, ownerKind);
    const walker = checked.ok ? [] : checked.problems;
    const prefix = `panels[${index}].alert.`;
    const refused = refusedFor.problems.filter((p) => {
      if (!p.path.startsWith(prefix)) return true;
      const key = FIELD_KEY[p.path.slice(prefix.length).split(/[.[]/)[0]];
      return key === undefined || sameJson(alert[key], refusedFor.alert[key]);
    });
    return alertProblems([...walker, ...refused], index);
  }, [spec, ownerKind, refusedFor, index, alert]);
  const first = (f: ProblemField) => problems[f]?.[0] ?? null;

  // The dry run: for the dashboard's owner, on the query's source as written, the query as the
  // rule runs it; a query it can't run says why instead (F36).
  const placed = useMemo(() => ruleExpr(spec, panel), [spec, panel]);
  const scope = where?.scope ?? null;
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : "";
  const body = useMemo<DryRunIn | null>(() => {
    if (scope === null || query === null || !placed.ok || placed.expr.trim() === "") return null;
    return {
      scope, source: { type: query.source.type, id: query.source.id }, expr: placed.expr,
      of: alert.of, op: alert.op, threshold: alert.threshold, for: alert.for, every: alert.every, suggest: true,
    };
    // `scope` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, query?.source.type, query?.source.id, placed, alert.of, alert.op, alert.threshold, alert.for, alert.every]);
  const report = useRef(onDryRun);
  report.current = onDryRun;
  const reportResult = (out: DryRunOut | null) => report.current?.(out ? { alert, dryRun: out } : null, alertRunKey(panel));

  const capabilities = useCapabilities(scope && query ? { scope, sourceType: query.source.type, sourceId: query.source.id } : null);
  // As in the rule form: whether the tools the alert runs in are ones OmniKrux installed (null while
  // that isn't known). Where they are, Notify picks contact points sent from OmniKrux's Alertmanager.
  const installedKnown = capabilities.data === undefined ? null : installedOf(capabilities.data);
  const installed = installedKnown ?? "none";
  const channels = useChannels(scope?.kind === "project" && alert.engine === "tool" && installed !== "all" ? scope.id : null);
  // A tool alert where OmniKrux is known not to have installed the tools sends no contact points
  // (the rule form's rule): hidden ones go from the draft once that is known. While it isn't known
  // (being read, or the read failed), the saved ones stay as they are.
  const hiddenNotify = alert.engine === "tool" && installedKnown === "none" && alert.notify.length > 0;
  useEffect(() => {
    if (hiddenNotify) set({ notify: [] });
    // `set` writes into the draft; it runs once each time hidden contact points show up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenNotify]);
  const warnings = where && query
    ? mixedClusterWarnings(where.scope, query.source.type, query.source.id, where.projects, where.groups, where.projectIds)
    : [];

  // The keyboard, when the side panel opens on this tab: the first field with a problem, else
  // Threshold. A field that isn't there yet (Notify's list still loading) takes it when it comes,
  // unless the keyboard has moved on since.
  const fieldEl = (f: ProblemField): HTMLElement | null => ({
    name: nameRef.current, query: querySelectRef.current, threshold: thresholdRef.current, for: forRef.current,
    contact_point_ids: notifyRef.current, channel: channelRef.current, message: messageRef.current, other: null,
  })[f];
  const awaited = useRef<ProblemField | null>(null);
  if (focusRef) {
    focusRef.current = () => {
      const order: ProblemField[] = ["name", "query", "threshold", "for", "contact_point_ids", "channel", "message"];
      // A threshold that isn't a number comes first: it is why a save was refused.
      const field = thresholdText !== undefined ? "threshold" : order.find((f) => problems[f]?.length) ?? "threshold";
      const el = fieldEl(field);
      awaited.current = el === null ? field : null;
      (el ?? thresholdRef.current)?.focus();
    };
  }
  useLayoutEffect(() => {
    const field = awaited.current;
    if (field === null) return;
    const el = fieldEl(field);
    if (el === null) return;
    awaited.current = null;
    if (document.activeElement === thresholdRef.current) el.focus();
  });

  // A contact point named in the alert that the list no longer has stays listed (ticked), so it can
  // be unticked; once unticked it stays listed while the tab is open (the keyboard stays on it).
  const known = contactPoints.data ?? [];
  const goneSeen = useRef<string[]>([]);
  for (const cp of alert.notify) {
    if (contactPoints.data !== undefined && !known.some((k) => k.id === cp) && !goneSeen.current.includes(cp)) goneSeen.current.push(cp);
  }
  const goneKey = goneSeen.current.join("\u0000");
  const listed = useMemo<ContactPointOut[]>(() => {
    if (contactPoints.data === undefined) return [];
    const gone = goneSeen.current.filter((cp) => !known.some((k) => k.id === cp));
    return [...known, ...gone.map((cp) => ({
      id: cp, name: UNKNOWN_CONTACT, type: "webhook" as const, settings: {}, secrets_set: [], summary: cp, used_by: [],
      last_delivery: null, created_at: "", updated_at: "",
    }))];
    // `goneSeen` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactPoints.data, goneKey]);

  const details: DetailsValue = {
    name: alert.name, severity: alert.severity, message: alert.message, notify: alert.notify, engine: alert.engine, channel: alert.channel,
  };
  const sentenceValue: SentenceValue = { of: alert.of, op: alert.op, threshold: alert.threshold, for: alert.for, every: alert.every };
  const word = query ? (seriesWordOf(query.expr) !== "series" ? seriesWordOf(query.expr) : seriesWord(query.legend)) : "series";
  const unit = panel.type === "logs" ? "none" : panel.options.unit;
  const defaults = query ? defaultsOf(query.expr, spec) : [];
  const queryProblem = !placed.ok ? placed.problem : null;
  const queryProblems = (problems.query ?? []).filter((m) => m !== queryProblem);
  const capsWaiting = scope && query
    ? capabilities.isError ? failure(capabilities.error, "try again") : capabilities.data === undefined ? CHECKING_WHERE : null
    : null;

  const remove = () => {
    update((p) => ({ ...p, alert: null }));
    onRemoved();
  };

  return (
    <div className={s.alertForm}>
      {saved !== null && <NowLine dashboardId={dashboardId} panelId={panel.id} onOpenRule={onOpenRule} />}

      {panel.queries.length > 1 && (
        <div className={s.field}>
          <label htmlFor={`${id}-q`} className={s.fieldLabel}>Query</label>
          <select ref={querySelectRef} id={`${id}-q`} className={s.select} value={alert.query} title={`Query ${alert.query}`}
            aria-invalid={queryProblems.length ? true : undefined} onChange={(e) => set({ query: e.target.value })}>
            {panel.queries.map((q) => <option key={q.ref} value={q.ref}>Query {q.ref}</option>)}
            {query === null && <option value={alert.query}>Query {alert.query}</option>}
          </select>
        </div>
      )}
      {queryProblems.map((m) => <p key={m} className={s.problem}>{m}</p>)}

      <div className={s.alertSentence}>
        <RuleSentence idPrefix={`${id}-cond`} value={sentenceValue} seriesWord={word} unit={unit}
          onChange={(v) => set(v)} thresholdRef={thresholdRef} forRef={forRef}
          initialText={thresholdText} onText={(t) => onThresholdText?.(parseThreshold(t) === null ? t : null)}
          errors={{ threshold: first("threshold"), for: first("for") }} />
        <p className={s.alertNote}>{BAND_NOTE}</p>
      </div>

      {queryProblem
        ? <p className={r.dryRun} data-tone="warn" data-alert-problem=""><span className={r.dryRunLine}>{queryProblem}</span></p>
        : <DryRunLine body={body} advice={false} onResult={reportResult} />}

      {warnings.map((w) => <p key={w} className={r.bar} data-tone="warn" data-cluster-warning="">{w}</p>)}
      {(problems.other ?? []).map((m) => <p key={m} className={s.problem}>{m}</p>)}

      <p className={r.sectionLabel}>Details</p>
      <RuleDetailsFields value={details} contactPoints={listed} channels={channels.data ?? null}
        notifyNote={contactPoints.isError ? failure(contactPoints.error, "try again") : contactPoints.data === undefined ? "Loading…" : null}
        onChange={(d) => set({ name: d.name, severity: d.severity, message: d.message, notify: d.notify, engine: d.engine, channel: d.channel })}
        errors={{ name: first("name"), message: first("message"), contact_point_ids: first("contact_point_ids"), channel: first("channel") }}
        refs={{ name: nameRef, message: messageRef, notify: notifyRef, channel: channelRef }} installed={installed} />

      <WhereItRuns engine={alert.engine} capabilities={capabilities.data ?? []} waiting={capsWaiting}
        onChange={(engine) => set(engine === "tool"
          // Contact points stay only where OmniKrux installed the tools (known to be): the rule form's rule.
          ? { engine, notify: installedKnown === "some" || installedKnown === "all" ? alert.notify : [] }
          : { engine, channel: null })} />

      {defaults.length > 0 && <p className={s.alertNote}>{defaultsWords(defaults)}</p>}
      {where && <p className={s.alertNote}>{savedWithWords(where.where)}</p>}

      <div className={s.alertFoot}>
        <button type="button" className={s.alertRemove} onClick={remove}>Remove alert</button>
        {saved !== null && <p className={s.alertNote}>{REMOVE_NOTE}</p>}
      </div>
    </div>
  );
}

/** Once saved: the rule's state now, and the way to it on the Alerts page. */
function NowLine({ dashboardId, panelId, onOpenRule }: { dashboardId: string; panelId: string; onOpenRule?(ruleId: string, newTab: boolean): void }) {
  const states = usePanelStates(dashboardId);
  const state = states.data?.[panelId];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // A refresh that failed never leaves the last state on as current: unknown, with what was known when.
  if (states.isError) {
    return (
      <div className={s.alertNow} data-tone="muted">
        <p className={s.alertNowText}>Now: {STATE_UNKNOWN}</p>
        {state && <p className={s.alertNote}>{notRefreshedWords(STATE_LABEL[state.state], states.dataUpdatedAt)}</p>}
      </div>
    );
  }
  if (!state) return null;
  const open = (e: MouseEvent<HTMLButtonElement>) => onOpenRule?.(state.rule_id, e.ctrlKey || e.metaKey);
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    onOpenRule?.(state.rule_id, true);
  };
  return (
    <div className={s.alertNow} data-tone={stateTone(state.state)}>
      <p className={s.alertNowText}>{nowWords(state, now)}</p>
      {onOpenRule && (
        <button type="button" className={s.alertLink} aria-keyshortcuts="Control+Enter" onClick={open} onKeyDown={keys}>
          Open on the Alerts page
        </button>
      )}
    </div>
  );
}
