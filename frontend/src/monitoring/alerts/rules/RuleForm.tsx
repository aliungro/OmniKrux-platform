// The rule form of the Alerts page (A2's details area): who the rule is for and which source it
// reads, its query, its condition as one sentence, how often that would have fired and the query
// against the threshold, then its details and where it runs. Ctrl+Enter saves from anywhere in it;
// Esc leaves an untouched form at once and asks first about one with changes. A save the server
// refuses puts its words under the field it names, with the keyboard there.

import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { failure } from "../../../api/http";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import { pressed } from "../../../features/chrome/shortcuts";
import { useGroups, useProjects } from "../../api/hooks";
import type { GroupOut, ProjectOut } from "../../api/types";
import {
  createRule, getRule, saveRule, useCapabilities, useChannels, useContactPoints,
  type AlertRequestError, type DryRunIn, type RuleChangeOut, type RuleIn, type RuleOut, type ScopeKind, type SourceType,
} from "../api";
import { numberText } from "../format";
import { EVERY_SECONDS, defaultsExpr } from "../limits";
import { ThresholdChart, type ChartInput } from "../page/RuleChart";
import { mixedClusterWarnings } from "./clusterWarning";
import { DryRunLine } from "./DryRunLine";
import { installedOf, RuleDetailsFields, type DetailsValue, type Installed } from "./RuleDetailsFields";
import { NEW_TITLE, keepRuleForm, ruleFormSessions, type RuleFormKept } from "./formSessions";
import { RuleSentence, parseThreshold, seriesWordOf, type SentenceValue } from "./RuleSentence";
import { useSettled } from "./useRuleDryRun";
import { WhereItRuns } from "./WhereItRuns";
import s from "./RuleForm.module.css";

export const DISCARD_TITLE = "Discard this rule?";
export const PICK_SOURCE = "Pick a source.";
export const CHECKING_WHERE = "Checking where it can run…";
export const FORM_CHART_CAPTION = "The query over the last 6 hours; the dashed line is the threshold.";
const NO_QUERY_YET = "Write a query to see it against the threshold.";
const RULE_GONE = "That alert rule no longer exists. Pick another from the list.";
const SOURCE_WORDS: Record<SourceType, string> = { prometheus: "Prometheus-compatible", loki: "Loki" };
const QUERYABLE: readonly SourceType[] = ["prometheus", "loki"];

/** The fields a refusal can name, and where its words go. */
type Field = "name" | "query" | "threshold" | "for" | "message" | "contact_point_ids" | "channel" | "source" | "scope";
const FIELDS: readonly Field[] = ["name", "query", "threshold", "for", "message", "contact_point_ids", "channel", "source", "scope"];

type Owner = { kind: ScopeKind; id: string };
type SourcePick = { type: SourceType; id: string | null };

interface Draft {
  owner: Owner | null;
  source: SourcePick | null;
  expr: string;
  cond: SentenceValue;
  details: DetailsValue;
}

const ownerKey = (o: Owner | null) => (o ? `${o.kind}:${o.id}` : "");
const sourceKey = (p: SourcePick | null) => (p ? `${p.type}:${p.id ?? ""}` : "");

/** The sources a rule of `owner` can read: a project's linked queryable sources, or for a group each
 * project's first of a type. `first`: a project rule written as "the first source of this type"
 * keeps that choice, named by the link it reads now. */
function sourceChoices(owner: Owner | null, projects: readonly ProjectOut[], first?: SourceType | null): { pick: SourcePick; label: string }[] {
  if (owner === null) return [];
  if (owner.kind === "group") return QUERYABLE.map((type) => ({ pick: { type, id: null }, label: `Each project's ${SOURCE_WORDS[type]} source` }));
  const project = projects.find((p) => p.id === owner.id);
  const links = (project?.links ?? []).filter((l): l is typeof l & { source_type: SourceType } => QUERYABLE.includes(l.source_type as SourceType));
  const named = links.map((l) => ({ pick: { type: l.source_type, id: l.source_id } as SourcePick, label: `${l.source_name} (${SOURCE_WORDS[l.source_type]})` }));
  if (!first) return named;
  const now = links.find((l) => l.source_type === first);
  return [{ pick: { type: first, id: null }, label: firstSourceWords(first, now?.source_name ?? null) }, ...named];
}

export const firstSourceWords = (type: SourceType, now: string | null) =>
  `The first ${SOURCE_WORDS[type]} source${now ? ` (now ${now})` : ""}`;

/** The source a new choice of owner starts on: the same type if it has one, else its first. */
function defaultSource(owner: Owner | null, projects: readonly ProjectOut[], wanted?: SourceType): SourcePick | null {
  const choices = sourceChoices(owner, projects);
  return (choices.find((c) => c.pick.type === wanted) ?? choices[0])?.pick ?? null;
}

/** The source as the rule names it: a project rule that reads "the first of the type" keeps `null`. */
function initialSource(rule: RuleOut): SourcePick {
  return { type: rule.source_type, id: rule.source_id };
}

function draftOf(rule: RuleOut | undefined, owner: Owner | null, projects: readonly ProjectOut[]): Draft {
  if (rule) {
    return {
      owner: { kind: rule.scope.kind, id: rule.scope.id },
      source: initialSource(rule),
      expr: rule.expr,
      cond: { ...rule.condition, every: rule.condition.every as SentenceValue["every"] },
      details: {
        name: rule.name, severity: rule.severity, message: rule.message, notify: rule.contact_points.map((c) => c.id),
        engine: rule.engine, channel: rule.channel,
      },
    };
  }
  return {
    owner,
    source: defaultSource(owner, projects),
    expr: "",
    cond: { of: "each", op: "above", threshold: 0, for: "5m", every: "1m" },
    details: { name: "", severity: "warning", message: "", notify: [], engine: "omnikrux", channel: null },
  };
}

/**
 * What the server is sent: contact points for a rule OmniKrux checks, a channel for a tool's. A
 * tool's rule where OmniKrux installed the tools sends contact points too (`some`), or only them
 * (`all`), and none where it didn't (`none`). While that isn't known (null: still read, or the read
 * failed), a tool's rule sends the saved rule's own contact points unchanged (`saved`; none for a new
 * rule): an edit never drops them, and none added in the form while they were hidden is sent.
 */
function ruleIn(d: Draft, owner: Owner, source: SourcePick, installed: Installed | null, saved: readonly string[] = []): RuleIn {
  const tool = d.details.engine === "tool";
  const contacts = !tool || installed === "some" || installed === "all" ? d.details.notify
    : installed === null ? [...saved] : [];
  const channel = tool && installed !== "all";
  return {
    name: d.details.name, scope: owner, source, expr: d.expr,
    condition: { ...d.cond }, severity: d.details.severity, message: d.details.message,
    contact_point_ids: contacts, engine: d.details.engine, channel: channel ? d.details.channel : null,
  };
}

/** The projects a rule of `owner` runs in, by name. */
function projectsOf(owner: Owner | null, projects: readonly ProjectOut[], groups: readonly GroupOut[]): ProjectOut[] {
  if (owner === null) return [];
  const ids = owner.kind === "project" ? [owner.id] : groups.find((g) => g.id === owner.id)?.project_ids ?? [];
  return ids.flatMap((id) => projects.filter((p) => p.id === id));
}

export interface RuleFormHandle {
  /** Leave the form: at once when nothing changed, else after "Discard this rule?" says Discard. */
  requestClose(then: () => void): void;
}

export interface RuleFormProps {
  /** The rule to edit; none: a new rule. */
  initial?: RuleOut;
  /** Who a new rule is for at first; else the first project. */
  scope?: Owner;
  onSaved(change: RuleChangeOut): void;
  onCancel(): void;
  /** The heading, so the page can hand it the keyboard (Enter in the list). */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** The Contact points tab (asks about changes first). */
  onOpenContactPoints?(): void;
  /** The Monitoring tab the form is kept for (formSessions): its draft survives the page going away. */
  tabId?: string;
}

/** The form; "Open it again" after a stale save starts it over from the rule as saved now. */
export const RuleForm = forwardRef<RuleFormHandle, RuleFormProps>(function RuleForm(props, ref) {
  // A form kept for this tab comes back as it was (only on the first mount; Open it again starts over).
  const [kept] = useState(() => (props.tabId ? ruleFormSessions.get(props.tabId)?.kept ?? null : null));
  const [base, setBase] = useState(kept?.base ?? props.initial);
  const [generation, setGeneration] = useState(0);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const reopen = async () => {
    if (!base) return;
    setReloadError(null);
    try {
      setBase(await getRule(base.id));
      setGeneration((n) => n + 1);
    } catch (err) {
      setReloadError((err as AlertRequestError).code === "not_found" ? RULE_GONE : failure(err, "try again"));
    }
  };
  return (
    <RuleFormBody key={generation} {...props} ref={ref} initial={base} onReopen={reopen} reloadError={reloadError}
      kept={generation === 0 ? kept : null} />
  );
});

type BodyProps = RuleFormProps & { onReopen(): void; reloadError: string | null; kept: RuleFormKept | null };

const RuleFormBody = forwardRef<RuleFormHandle, BodyProps>(function RuleFormBody(
  { initial, scope, onSaved, onCancel, headingRef, onOpenContactPoints, onReopen, reloadError, kept, tabId }, ref,
) {
  const id = useId();
  const projects = useProjects();
  const groups = useGroups();
  const contactPoints = useContactPoints();
  const projectList = useMemo(() => projects.data ?? [], [projects.data]);
  const groupList = useMemo(() => groups.data ?? [], [groups.data]);

  const owners = useMemo<{ owner: Owner; label: string }[]>(() => [
    ...projectList.map((p) => ({ owner: { kind: "project" as const, id: p.id }, label: p.name })),
    ...groupList.map((g) => ({ owner: { kind: "group" as const, id: g.id }, label: `Group · ${g.name}` })),
  ], [projectList, groupList]);

  // The draft, and the draft as it started: a form whose draft is still the start is unchanged.
  const [draft, setDraft] = useState<Draft>(() => (kept?.draft as Draft | undefined) ?? draftOf(initial, scope ?? null, projectList));
  const [start, setStart] = useState<Draft>(() => (kept?.start as Draft | undefined) ?? draft);
  // What the page fills in once projects and groups are read is part of the start, not a change.
  const filled = useRef(kept !== null || initial !== undefined);
  useEffect(() => {
    if (filled.current || projects.data === undefined || (groups.data === undefined && !groups.isError)) return;
    filled.current = true;
    // A new rule is for the owner asked for (where new dashboards go), else the first project by name.
    const firstByName = [...projectList].sort((a, b) => a.name.localeCompare(b.name))[0];
    const owner = initial ? { kind: initial.scope.kind, id: initial.scope.id }
      : scope && owners.some((o) => ownerKey(o.owner) === ownerKey(scope)) ? scope
      : firstByName ? { kind: "project" as const, id: firstByName.id } : owners[0]?.owner ?? null;
    // Only who it is for and the source are filled in: anything typed meanwhile stays a change.
    const fill = { owner, source: initial ? initialSource(initial) : defaultSource(owner, projectList) };
    setDraft((d) => ({ ...d, ...fill }));
    setStart((d) => ({ ...d, ...fill }));
  }, [projects.data, groups.data, groups.isError, owners, initial, scope, projectList]);
  const [thresholdText, setThresholdText] = useState(() => kept?.thresholdText ?? numberText(draft.cond.threshold));
  const [thresholdOk, setThresholdOk] = useState(() => parseThreshold(thresholdText) !== null);
  // Something would be lost: the draft moved, or the threshold as typed isn't a number yet.
  const changed = JSON.stringify(draft) !== JSON.stringify(start) || !thresholdOk;
  const leaveTitle = draft.details.name.trim() || (initial ? initial.name : NEW_TITLE);
  // Kept for the tab as it changes, so the page can go away and come back without losing it.
  useEffect(() => {
    if (tabId) keepRuleForm(tabId, { base: initial, draft, start, thresholdText }, changed, leaveTitle);
  }, [tabId, initial, draft, start, thresholdText, changed, leaveTitle]);

  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<null | (() => void)>(null);
  const [focusField, setFocusField] = useState<Field | "stale" | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef<HTMLTextAreaElement>(null);
  const thresholdRef = useRef<HTMLInputElement>(null);
  const forRef = useRef<HTMLSelectElement>(null);
  const messageRef = useRef<HTMLInputElement>(null);
  const notifyRef = useRef<HTMLInputElement>(null);
  const channelRef = useRef<HTMLSelectElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const ownerRef = useRef<HTMLSelectElement>(null);
  const staleRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  // The form opens with the keyboard on its first field (For), new or edited: at once, and again
  // once the effects of what it replaced have run (a dialog closing as it opens gives the keyboard
  // back to where it was asked from).
  const firstRef = ownerRef;
  useLayoutEffect(() => { firstRef.current?.focus({ preventScroll: true }); }, [firstRef]);
  useEffect(() => {
    const el = document.activeElement;
    if (el === null || el === document.body || !el.isConnected || !el.closest("[data-rule-form]")) firstRef.current?.focus({ preventScroll: true });
  }, [firstRef]);
  useLayoutEffect(() => {
    if (focusField === null) return;
    const target = {
      name: nameRef, query: queryRef, threshold: thresholdRef, for: forRef, message: messageRef, contact_point_ids: notifyRef,
      channel: channelRef, source: sourceRef, scope: ownerRef, stale: staleRef,
    }[focusField].current;
    setFocusField(null);
    (target ?? saveRef.current)?.focus();
  }, [focusField]);

  const requestClose = useCallback((then: () => void) => {
    if (saving) return;
    if (!changed) then();
    else setAsking(() => then);
  }, [changed, saving]);
  useImperativeHandle(ref, () => ({ requestClose }), [requestClose]);

  const edit = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const clearError = (...fields: Field[]) => setErrors((e) => {
    if (!fields.some((f) => e[f])) return e;
    const next = { ...e };
    for (const f of fields) delete next[f];
    return next;
  });

  const owner = draft.owner;
  const source = draft.source;
  // "The first source of the type" stays a choice for a project rule written that way.
  const firstType = owner?.kind !== "project" ? null
    : source?.id === null ? source.type
      : initial?.scope.kind === "project" && initial.source_id === null ? initial.source_type : null;
  const choices = sourceChoices(owner, projectList, firstType);
  const ownerProjects = projectsOf(owner, projectList, groupList);
  const capabilities = useCapabilities(owner && source ? { scope: owner, sourceType: source.type, sourceId: source.id } : null);
  // Whether the tools the rule runs in are ones OmniKrux installed (null while that isn't known).
  const installedKnown = capabilities.data === undefined ? null : installedOf(capabilities.data);
  const installed = installedKnown ?? "none";
  const channels = useChannels(owner?.kind === "project" && draft.details.engine === "tool" && installed !== "all" ? owner.id : null);
  const warnings = owner && source ? mixedClusterWarnings(owner, source.type, source.id, projectList, groupList) : [];

  const body = useMemo<DryRunIn | null>(() => (
    owner && source && draft.expr.trim() !== ""
      ? { scope: owner, source, expr: draft.expr, of: draft.cond.of, op: draft.cond.op, threshold: draft.cond.threshold,
          for: draft.cond.for, every: draft.cond.every, suggest: true }
      : null
  ), [owner, source, draft.expr, draft.cond]);

  // The chart draws the query once typing stops, with the built-ins as the rule will run them.
  const chartWanted = { owner, source, expr: draft.expr, every: draft.cond.every, projects: ownerProjects.map((p) => [p.id, p.name]) };
  const chartSettled = useSettled(chartWanted, JSON.stringify(chartWanted));
  const chart = useMemo<{ input: ChartInput } | { problem: string } | null>(() => {
    const c = chartSettled.value;
    if (!c.owner || !c.source || c.expr.trim() === "") return null;
    const placed = defaultsExpr(c.expr, [], EVERY_SECONDS[c.every] ?? 60);
    if ("problem" in placed) return { problem: placed.problem };
    return {
      input: {
        id: "form", title: "Query", scopeKind: c.owner.kind, sourceType: c.source.type, sourceId: c.source.id,
        items: c.projects.map(([pid, pname]) => ({ ref: pid, projectId: pid, projectName: pname, expr: placed.text })),
        seconds: 6 * 3600, step: 60,
      },
    };
  }, [chartSettled.value]);

  const save = async () => {
    if (saving) return;
    setFormError(null);
    setStale(null);
    if (!thresholdOk) {
      setFocusField("threshold");
      return;
    }
    if (!owner || !source) {
      setErrors((e) => ({ ...e, source: PICK_SOURCE }));
      setFocusField("source");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const out = initial
        ? await saveRule(initial.id, { ...ruleIn(draft, owner, source, installedKnown, initial.contact_points.map((c) => c.id)), base_version: initial.version })
        : await createRule(ruleIn(draft, owner, source, installedKnown));
      onSaved(out);
      return;
    } catch (err) {
      const e = err as AlertRequestError;
      if (e.code === "rule_changed") {
        setStale(e.message);
        setFocusField("stale");
      } else if (e.code === "not_found" && initial) {
        setFormError(RULE_GONE);
      } else if (e.code === "unknown_scope") {
        setErrors({ scope: e.message });
        setFocusField("scope");
      } else if (e.status === 422 && e.field && (FIELDS as readonly string[]).includes(e.field)) {
        const field = e.field as Field;
        setErrors({ [field]: e.message });
        setFocusField(field);
      } else {
        setFormError(failure(e, "try again"));
      }
    }
    setSaving(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (pressed("confirmReview", e)) {
      e.preventDefault();
      if (!e.repeat) void save();
      return;
    }
    if (e.key === "Escape" && !e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      requestClose(onCancel);
    }
  };

  const pickOwner = (key: string) => {
    const next = owners.find((o) => ownerKey(o.owner) === key)?.owner ?? null;
    clearError("scope", "source", "channel");
    edit({ owner: next, source: defaultSource(next, projectList, source?.type), details: { ...draft.details, channel: null } });
  };
  const pickSource = (key: string) => {
    clearError("source");
    edit({ source: choices.find((c) => sourceKey(c.pick) === key)?.pick ?? null });
  };

  const err = (f: Field) => errors[f] ?? null;
  const title = initial ? `Edit "${initial.name}"` : "New alert rule";
  const capsWaiting = owner && source
    ? capabilities.isError ? failure(capabilities.error, "try again") : capabilities.data === undefined ? CHECKING_WHERE : null
    : null;

  return (
    <section className={s.form} aria-labelledby={`${id}-title`} data-rule-form="" onKeyDown={onKeyDown}>
      <header className={s.head}>
        <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className={s.title}>{title}</h2>
      </header>

      {stale && (
        <div className={s.bar} data-tone="warn" role="alert">
          <p>{stale}</p>
          <button ref={staleRef} type="button" className={s.barButton} onClick={onReopen}>Open it again</button>
        </div>
      )}
      {reloadError && <p className={s.bar} data-tone="warn" role="alert">{reloadError}</p>}

      <div className={s.pair}>
        <div className={s.field}>
          <label htmlFor={`${id}-owner`} className={s.label}>For</label>
          <select ref={ownerRef} id={`${id}-owner`} className={s.input} value={ownerKey(owner)}
            aria-invalid={err("scope") ? true : undefined} aria-describedby={err("scope") ? `${id}-owner-e` : undefined}
            onChange={(e) => pickOwner(e.target.value)}>
            {owner === null && <option value="">{projects.isError || groups.isError ? "Couldn't read the projects" : "Loading…"}</option>}
            {owners.map((o) => <option key={ownerKey(o.owner)} value={ownerKey(o.owner)}>{o.label}</option>)}
          </select>
          {err("scope") && <p id={`${id}-owner-e`} className={s.fieldError}>{err("scope")}</p>}
        </div>
        <div className={s.field}>
          <label htmlFor={`${id}-source`} className={s.label}>Source</label>
          <select ref={sourceRef} id={`${id}-source`} className={s.input} value={sourceKey(source)}
            title={choices.find((c) => sourceKey(c.pick) === sourceKey(source))?.label}
            aria-invalid={err("source") ? true : undefined} aria-describedby={err("source") ? `${id}-source-e` : undefined}
            onChange={(e) => pickSource(e.target.value)}>
            {source === null && <option value="">{owner ? "No source to read" : "…"}</option>}
            {choices.map((c) => <option key={sourceKey(c.pick)} value={sourceKey(c.pick)}>{c.label}</option>)}
          </select>
          {err("source") && <p id={`${id}-source-e`} className={s.fieldError}>{err("source")}</p>}
        </div>
      </div>

      {warnings.map((w) => <p key={w} className={s.bar} data-tone="warn" data-cluster-warning="">{w}</p>)}

      <div className={s.field}>
        <label htmlFor={`${id}-query`} className={s.label}>Query</label>
        <textarea ref={queryRef} id={`${id}-query`} className={s.query} aria-label="Query" spellCheck={false} rows={3}
          autoComplete="off" value={draft.expr}
          aria-invalid={err("query") ? true : undefined} aria-describedby={err("query") ? `${id}-query-e` : undefined}
          onChange={(e) => { clearError("query"); edit({ expr: e.target.value }); }} />
        {err("query") && <p id={`${id}-query-e`} className={s.fieldError}>{err("query")}</p>}
      </div>

      <RuleSentence idPrefix={`${id}-cond`} value={draft.cond} seriesWord={seriesWordOf(draft.expr)} unit="none"
        onChange={(cond) => { clearError("threshold", "for"); edit({ cond }); }}
        onValidity={setThresholdOk} initialText={thresholdText} onText={setThresholdText}
        errors={{ threshold: err("threshold"), for: err("for") }} thresholdRef={thresholdRef} forRef={forRef} />

      <DryRunLine body={body} onAdvice={(threshold) => {
        edit({ cond: { ...draft.cond, threshold } });
        // The advice goes as the run starts again: the keyboard goes to what it changed.
        setFocusField("threshold");
      }} />

      {chart && "problem" in chart
        ? <p className={s.chartProblem} data-tone="warn">{chart.problem}</p>
        : (
          <ThresholdChart input={chart?.input ?? EMPTY_CHART} op={draft.cond.op} threshold={draft.cond.threshold}
            waiting={chartSettled.key !== JSON.stringify(chartWanted)}
            caption={FORM_CHART_CAPTION} emptyWords={NO_QUERY_YET} windowWords="the last 6 hours" />
        )}

      <p className={s.sectionLabel}>Details</p>
      <RuleDetailsFields value={draft.details} contactPoints={contactPoints.data ?? []} channels={channels.data ?? null}
        notifyNote={contactPoints.isError ? failure(contactPoints.error, "try again") : contactPoints.data === undefined ? "Loading…" : null}
        onChange={(details) => { clearError("name", "message", "contact_point_ids", "channel"); edit({ details }); }}
        onAddContactPoint={onOpenContactPoints ? () => requestClose(onOpenContactPoints) : undefined}
        errors={{ name: err("name"), message: err("message"), contact_point_ids: err("contact_point_ids"), channel: err("channel") }}
        refs={{ name: nameRef, message: messageRef, notify: notifyRef, channel: channelRef }} installed={installed} />

      <WhereItRuns engine={draft.details.engine} capabilities={capabilities.data ?? []} waiting={capsWaiting}
        onChange={(engine) => edit({ details: { ...draft.details, engine } })} />

      <footer className={s.foot}>
        {formError && <p className={s.formError} role="alert">{formError}</p>}
        <div className={s.actions}>
          <span className={s.keyHint} aria-hidden="true">Ctrl+Enter saves</span>
          <button type="button" className={s.secondary} aria-disabled={saving || undefined} onClick={() => requestClose(onCancel)}>Cancel</button>
          <button ref={saveRef} type="button" className={s.primary} aria-disabled={saving || undefined} aria-keyshortcuts="Control+Enter"
            onClick={() => void save()}>
            {saving ? "Saving…" : "Save rule"}
          </button>
        </div>
      </footer>

      {asking && <DiscardDialog onKeep={() => setAsking(null)} onDiscard={() => { const then = asking; setAsking(null); then(); }} />}
    </section>
  );
});

const EMPTY_CHART: ChartInput = { id: "form", title: "Query", scopeKind: "project", sourceType: "prometheus", sourceId: null, items: [], seconds: 6 * 3600, step: 60 };

function DiscardDialog({ onKeep, onDiscard }: { onKeep(): void; onDiscard(): void }) {
  const id = useId();
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <DialogShell provider="monitoring" busy={false} onCancel={onKeep} first={keep} labelledBy={`${id}-t`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>{DISCARD_TITLE}</h2>
      <p className={s.dialogBody}>What you wrote here isn't saved.</p>
      <div className={s.dialogActions}>
        <button ref={keep} type="button" className={s.secondary} onClick={onKeep}>Keep editing</button>
        <button type="button" className={s.danger} onClick={onDiscard}>Discard</button>
      </div>
    </DialogShell>
  );
}
