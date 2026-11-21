// What a dashboard's panels run against: its owner (and, on a group, the Projects choice), the
// variables' values, the time range and "now". The page owns "now": it advances on Refresh now,
// on each auto-refresh tick (skipped while the page is hidden) and when the time range changes,
// so every refresh is a new window, never the old one sent again.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueries, useQuery, useQueryClient, type QueryState } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { getProject, listGroups, listProjects } from "../../api/client";
import { groupsKey, projectKey, projectsKey } from "../../api/hooks";
import type { GroupOut, ProjectOut } from "../../api/types";
import type { MonitoringView } from "../../shell/tabState";
import { labelValues, type LabelValuesOut, type LabelValuesParams } from "../api";
import { interpolate, VariableError, type ResolvedVars, type VarValue } from "../interpolate";
import type { DashboardOwner } from "../runPanel";
import { variablesUsed, type DashboardSpec, type OwnerKind, type PanelSpec, type RefreshSpec, type SourceRef, type TimeSpec, type VariableSpec } from "../schema";
import { REFRESH_LABELS, refreshMs as refreshMsOf, resolveTime, stepFor } from "../time";

export type DashboardViewState = Extract<MonitoringView, { page: "dashboard" }>;
export type ProjectRef = { id: string; name: string };

/** One variable as the page shows it. `missing`: selected values the label no longer has (kept selected). */
export type VariableState = {
  spec: VariableSpec;
  values: string[];
  loading: boolean;
  error: string | null;
  selected: VarValue;
  missing: string[];
};

/** The view's key for a group dashboard's Projects selection. */
export const PROJECTS_VAR = "__projects";

// --- Panel status: what the Updated line reads ------------------------------------------------

export interface PanelStatus {
  /** When the data shown was read; null while waiting or after a failure. */
  updatedAt: number | null;
  loading: boolean;
}

export interface StatusSummary {
  /** The oldest read among the panels showing data. */
  updatedAt: number | null;
  /** Some panel is loading. */
  updating: boolean;
}

/** Panels report here; only the Updated line listens, so a report never re-renders the grid. */
export interface PanelStatusStore {
  report(panelId: string, status: PanelStatus | null): void;
  subscribe(listener: () => void): () => void;
  snapshot(): StatusSummary;
}

function createStatusStore(): PanelStatusStore {
  const panels = new Map<string, PanelStatus>();
  const listeners = new Set<() => void>();
  let summary: StatusSummary = { updatedAt: null, updating: false };
  const recompute = () => {
    let updatedAt: number | null = null;
    let updating = false;
    for (const p of panels.values()) {
      if (p.loading) updating = true;
      if (p.updatedAt !== null) updatedAt = updatedAt === null ? p.updatedAt : Math.min(updatedAt, p.updatedAt);
    }
    if (updatedAt === summary.updatedAt && updating === summary.updating) return;
    summary = { updatedAt, updating };
    listeners.forEach((l) => l());
  };
  return {
    report(panelId, status) {
      if (status) panels.set(panelId, status);
      else panels.delete(panelId);
      recompute();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => summary,
  };
}

export function usePanelStatus(store: PanelStatusStore): StatusSummary {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

// --- Helpers ----------------------------------------------------------------------------------

const SOURCE_WORDS: Record<SourceRef["type"], string> = { prometheus: "Prometheus-compatible", loki: "Loki" };
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const labelValuesKey = (p: LabelValuesParams) => ["monitoring", "labelValues", p] as const;
const VALID_REFRESH = new Set<unknown>(REFRESH_LABELS.map((r) => r.value));

/** The source a variable reads on one project: the one named (project dashboards), else its first of the type. */
function linkFor(project: ProjectOut, source: SourceRef, ownerKind: OwnerKind) {
  if (ownerKind === "project" && source.id !== null) return project.links.find((l) => l.source_id === source.id);
  return project.links.find((l) => l.source_type === source.type);
}

function noLink(project: ProjectOut, source: SourceRef, ownerKind: OwnerKind): string {
  if (ownerKind === "project" && source.id !== null) return `This variable's source isn't linked to ${project.name} any more.`;
  return `${project.name} has no ${SOURCE_WORDS[source.type]} source.`;
}

/** The selection a variable starts from: the view's, else the document's default; kept within what the variable allows. */
function startingSelection(v: VariableSpec, fromView: VarValue | undefined): VarValue {
  const raw = fromView ?? v.default;
  if (raw === "all") return v.includeAll ? "all" : [];
  return v.multi ? raw : raw.slice(0, 1);
}

/** The view's Projects selection, kept to the group's members; nothing left (or every one) is All. */
function projectSelection(raw: VarValue | undefined, all: ProjectRef[]): VarValue {
  if (raw === undefined || raw === "all") return "all";
  const kept = raw.filter((id) => all.some((p) => p.id === id));
  return kept.length === 0 || kept.length === all.length ? "all" : kept;
}

/** The variables a panel's shown queries use. */
export function panelVariables(panel: PanelSpec): string[] {
  return [...new Set(panel.queries.filter((q) => !q.hidden).flatMap((q) => variablesUsed(q.expr)))];
}

// --- The context ------------------------------------------------------------------------------

export interface DashboardContext {
  owner: DashboardOwner | null;
  ownerName: string;
  vars: ResolvedVars;
  variables: VariableState[];
  projects: { all: ProjectRef[]; selected: VarValue } | null;
  /** The time range in seconds, from `now`. */
  range: { start: number; end: number };
  time: TimeSpec;
  /** Milliseconds; advances on refresh, on each auto-refresh tick and on time changes. */
  now: number;
  refresh: RefreshSpec;
  refreshMs: number | null;
  /** Counts refreshes (Refresh now and ticks): a panel whose window didn't move reads it again. */
  refreshSeq: number;
  refreshNow(): void;
  /** Reads a variable's values again after a failure. */
  retryVariable(name: string): void;
  /** Whether a panel must wait: its owner or a variable it uses is still loading. */
  waiting(panel: PanelSpec): boolean;
  status: PanelStatusStore;
}

export function useDashboardContext(view: DashboardViewState, spec: DashboardSpec, ownerKind: OwnerKind, ownerId: string): DashboardContext {
  const client = useQueryClient();

  // The owner: a project, or a group with its members' projects (each with its links).
  const projectQ = useQuery({ queryKey: projectKey(ownerId), queryFn: () => getProject(ownerId), enabled: ownerKind === "project" });
  const groupsQ = useQuery({ queryKey: groupsKey, queryFn: () => listGroups(), enabled: ownerKind === "group" });
  const projectsQ = useQuery({ queryKey: projectsKey, queryFn: () => listProjects(), enabled: ownerKind === "group" });
  const group: GroupOut | undefined = ownerKind === "group" ? groupsQ.data?.find((g) => g.id === ownerId) : undefined;
  const memberProjects = useMemo(() => {
    if (!group || !projectsQ.data) return null;
    const byId = new Map(projectsQ.data.map((p) => [p.id, p]));
    return group.project_ids.flatMap((id) => { const p = byId.get(id); return p ? [p] : []; }).sort(byName);
  }, [group, projectsQ.data]);
  const allProjects = useMemo(() => memberProjects?.map((p) => ({ id: p.id, name: p.name })) ?? [], [memberProjects]);
  const projectsSelected = projectSelection(view.vars?.[PROJECTS_VAR], allProjects);
  const selectedKey = JSON.stringify(projectsSelected);
  const owner = useMemo<DashboardOwner | null>(() => {
    if (ownerKind === "project") return projectQ.data ? { kind: "project", project: projectQ.data } : null;
    if (!group || !memberProjects) return null;
    const chosen: VarValue = JSON.parse(selectedKey);
    const members = chosen === "all" ? memberProjects : memberProjects.filter((p) => chosen.includes(p.id));
    return { kind: "group", group, members };
  }, [ownerKind, projectQ.data, group, memberProjects, selectedKey]);
  const ownerName = ownerKind === "project" ? (projectQ.data?.name ?? "") : (group?.name ?? "");
  const projects = useMemo(
    () => (ownerKind === "group" ? { all: allProjects, selected: JSON.parse(selectedKey) as VarValue } : null),
    [ownerKind, allProjects, selectedKey],
  );

  // "Now", and the range from it. A new time range starts a new "now" in the same render, so no
  // run is ever sent with the new range and an old "now".
  const time = view.time ?? spec.time;
  const timeKey = `${time.from}\n${time.to}`;
  // `valuesNow`: the window variables read their values over. It moves with the time range and
  // Refresh now, not with auto-refresh ticks, so a tick doesn't re-read every variable.
  const [clock, setClock] = useState(() => { const now = Date.now(); return { key: timeKey, now, valuesNow: now, seq: 0 }; });
  if (clock.key !== timeKey) {
    const now = Math.max(Date.now(), clock.now + 1);
    setClock({ key: timeKey, now, valuesNow: now, seq: clock.seq });
  }
  const rangeAt = (seconds: number) =>
    resolveTime({ from: time.from, to: time.to }, seconds) ?? resolveTime(spec.time, seconds) ?? { start: seconds - 21600, end: seconds };
  const nowSeconds = Math.floor(clock.now / 1000);
  const valuesSeconds = Math.floor(clock.valuesNow / 1000);
  // Only these inputs matter: the range is the same object until "now" or the time range moves.
  const range = useMemo(() => rangeAt(nowSeconds), [time.from, time.to, spec.time, nowSeconds]);
  const valuesRange = useMemo(() => rangeAt(valuesSeconds), [time.from, time.to, spec.time, valuesSeconds]);

  /** Refresh now: a new window for every panel, and fresh variable values. */
  const refreshNow = useCallback(() => {
    setClock((c) => { const now = Math.max(Date.now(), c.now + 1); return { key: c.key, now, valuesNow: now, seq: c.seq + 1 }; });
  }, []);
  /** An auto-refresh tick: a new window for every panel. */
  const tick = useCallback(() => {
    setClock((c) => ({ ...c, now: Math.max(Date.now(), c.now + 1), seq: c.seq + 1 }));
  }, []);
  const refresh: RefreshSpec = view.refresh !== undefined && VALID_REFRESH.has(view.refresh) ? (view.refresh as RefreshSpec) : spec.refresh;
  const refreshMs = refreshMsOf(refresh);
  const lastTick = useRef(clock.now);
  lastTick.current = clock.now;
  useEffect(() => {
    if (refreshMs === null) return;
    // Ticks are skipped while the page is hidden: nobody sees them, and the tools aren't asked.
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") tick(); }, refreshMs);
    // Back from a hidden page: catch up at once when a tick was skipped.
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastTick.current >= refreshMs) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refreshMs, tick]);

  // Variables, in order: each one's `match` is substituted with the ones before it, and it waits
  // until they have loaded. Values come from each selected project and are unioned.
  const lastValues = useRef(new Map<string, { key: string; values: string[] }>());
  const builtins = { stepSeconds: stepFor(valuesRange.end - valuesRange.start, 24), rangeSeconds: valuesRange.end - valuesRange.start };
  const requests: LabelValuesParams[] = [];
  const paramsByVariable = new Map<string, LabelValuesParams[]>();
  const states: VariableState[] = [];
  const resolved: ResolvedVars = {};
  let blocked = owner === null;
  for (const v of spec.variables) {
    let selected = startingSelection(v, view.vars?.[v.name]);
    let values: string[] = [];
    let loading = false;
    let error: string | null = null;
    if (blocked) loading = true;
    else {
      let match: string | null = null;
      try {
        match = interpolate(v.match, resolved, builtins);
      } catch (err) {
        if (!(err instanceof VariableError)) throw err;
        error = err.message;
      }
      const members = owner === null ? [] : owner.kind === "project" ? [owner.project] : owner.members;
      const params: LabelValuesParams[] = [];
      if (match !== null) {
        for (const p of members) {
          const link = linkFor(p, v.source, ownerKind);
          if (!link) { error = noLink(p, v.source, ownerKind); break; }
          params.push({ sourceId: link.source_id, projectId: p.id, label: v.labelName, match, start: valuesRange.start, end: valuesRange.end });
        }
      }
      if (error === null) {
        requests.push(...params);
        paramsByVariable.set(v.name, params);
        const read = params.map((p) => client.getQueryState<LabelValuesOut>(labelValuesKey(p)) as QueryState<LabelValuesOut> | undefined);
        const failed = read.find((r) => r?.status === "error");
        // The same question over another window: its last answer stands while the new one loads.
        const asked = JSON.stringify([v.labelName, params.map(({ start: _s, end: _e, ...rest }) => rest)]);
        if (failed) error = failure(failed.error, "try again");
        else if (read.every((r) => r?.status === "success" && r.data)) {
          values = [...new Set(read.flatMap((r) => r?.data?.values ?? []))].sort();
          lastValues.current.set(v.name, { key: asked, values });
        } else {
          const kept = lastValues.current.get(v.name);
          if (kept?.key === asked) values = kept.values;
          else loading = true;
        }
      }
    }
    const loaded = !loading && error === null;
    // A single-value variable with nothing chosen takes its first value.
    if (loaded && !v.multi && selected !== "all" && selected.length === 0 && values.length > 0) selected = [values[0]];
    const missing = loaded && selected !== "all" ? selected.filter((x) => !values.includes(x)) : [];
    resolved[v.name] = { multi: v.multi, value: selected };
    if (loading) blocked = true;
    states.push({ spec: v, values, loading, error, selected, missing });
  }

  // Every label-values read, so each answer re-renders this (and the next variable can ask).
  useQueries({
    queries: requests.map((p) => ({
      queryKey: labelValuesKey(p),
      queryFn: ({ signal }: { signal: AbortSignal }) => labelValues(p, signal),
      retry: false,
      gcTime: 60_000,
    })),
    combine: (results) => results.map((r) => `${r.status}:${r.dataUpdatedAt}:${r.errorUpdatedAt}`).join("|"),
  });

  // Stable while nothing changes, so panels whose queries didn't change keep their runs.
  const varsKey = JSON.stringify(resolved);
  const vars = useMemo<ResolvedVars>(() => JSON.parse(varsKey), [varsKey]);
  const statesKey = JSON.stringify(states);
  const variables = useMemo<VariableState[]>(() => JSON.parse(statesKey), [statesKey]);
  const loadingNames = useMemo(() => new Set(variables.filter((v) => v.loading).map((v) => v.spec.name)), [variables]);
  const waiting = useCallback(
    (panel: PanelSpec) => owner === null || panelVariables(panel).some((name) => loadingNames.has(name)),
    [owner, loadingNames],
  );
  const paramsRef = useRef(paramsByVariable);
  paramsRef.current = paramsByVariable;
  const retryVariable = useCallback((name: string) => {
    for (const p of paramsRef.current.get(name) ?? []) void client.refetchQueries({ queryKey: labelValuesKey(p), exact: true });
  }, [client]);

  const status = useMemo(createStatusStore, []);

  return {
    owner, ownerName, vars, variables, projects, range, time, now: clock.now, refresh, refreshMs,
    refreshSeq: clock.seq, refreshNow, retryVariable, waiting, status,
  };
}
