// A project's or a group's catalog as one list: metrics merged by name, log stream labels merged by
// name. A group reads each member's catalog on its own (never one request for several projects) and
// keeps which projects each name came from.
import { useCallback, useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import type { ProjectOut } from "../api/types";
import type { OwnerKind } from "../dashboards/schema";
import type { DashboardOwner } from "../dashboards/runPanel";
import { CATALOG_STALE_MS, catalogKey, getCatalog, type CatalogOut, type CatalogState } from "./api";

export type OwnerMetric = {
  name: string;
  type: string | null;
  help: string | null;
  unit: string | null;
  labels: string[];
  /** Series the source listed (0 when it didn't say); summed across a group's projects. */
  series: number;
  family: string | null;
  /** `null` on a group owner: the same name can come from a different source in each project. */
  sourceId: string | null;
  projectIds: string[];
};

export type OwnerStreamLabel = { name: string; values: string[]; sourceId: string | null; projectIds: string[] };

export type OwnerCatalog = {
  ownerKind: OwnerKind;
  metrics: OwnerMetric[];
  streams: OwnerStreamLabel[];
  hasPrometheus: boolean;
  hasLoki: boolean;
  /** The oldest build among the sources, in ms; `null` when nothing was built. */
  builtAt: number | null;
  problems: string[];
  notes: string[];
  /** The same notes by the type of source that gave them (a Prometheus note is never for a logs list). */
  notesBy: { prometheus: string[]; loki: string[] };
  /** The smallest window (seconds) the Loki sources read their streams over; `null` without a Loki. */
  streamWindowSeconds: number | null;
  /** Each source's build state, by source id (a project owner's; a name is judged missing only from an `ok` one). */
  sourceStates?: Record<string, CatalogState>;
};

export type CatalogPart = { project: ProjectOut; catalog: CatalogOut | null; error: string | null };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort(byText);
const add = <T>(list: T[], x: T) => { if (!list.includes(x)) list.push(x); };

/** One project's own metrics and streams: the first source (in link order) to list a name wins. */
function ofProject(part: CatalogPart, single: boolean) {
  const metrics = new Map<string, OwnerMetric>();
  const streams = new Map<string, { name: string; values: Set<string>; sourceId: string }>();
  for (const src of part.catalog?.sources ?? []) {
    for (const m of src.metrics) {
      if (metrics.has(m.name)) continue;
      metrics.set(m.name, {
        name: m.name, type: m.type, help: m.help, unit: m.unit, labels: sorted(m.labels), series: m.series ?? 0,
        family: m.family, sourceId: single ? src.source_id : null, projectIds: [part.project.id],
      });
    }
    for (const s of src.streams) {
      const have = streams.get(s.name) ?? { name: s.name, values: new Set<string>(), sourceId: src.source_id };
      s.values.forEach((v) => have.values.add(v));
      streams.set(s.name, have);
    }
  }
  return { metrics, streams };
}

export function ownerCatalog(parts: CatalogPart[], ownerKind: OwnerKind): OwnerCatalog {
  const group = ownerKind === "group";
  const metrics = new Map<string, OwnerMetric>();
  const streams = new Map<string, { values: Set<string>; sourceId: string | null; projectIds: string[] }>();
  const problems: string[] = [];
  const notes: string[] = [];
  const notesBy: OwnerCatalog["notesBy"] = { prometheus: [], loki: [] };
  let hasPrometheus = false;
  let hasLoki = false;
  let streamWindowSeconds: number | null = null;
  let builtAt: number | null = null;
  const sourceStates: Record<string, CatalogState> = {};

  for (const part of parts) {
    const where = group ? `${part.project.name}: ` : "";
    if (part.error !== null) problems.push(`${where}${part.error}`);
    for (const src of part.catalog?.sources ?? []) {
      sourceStates[src.source_id] = src.state;
      if (src.source_type === "prometheus") hasPrometheus = true;
      if (src.source_type === "loki") {
        hasLoki = true;
        const w = src.stream_window_seconds;
        if (w !== null && w !== undefined && (streamWindowSeconds === null || w < streamWindowSeconds)) streamWindowSeconds = w;
      }
      if (src.state !== "ok" && src.message) problems.push(`${where}${src.source_name}: ${src.message}`);
      src.notes.forEach((n) => {
        add(notes, n);
        if (src.source_type === "prometheus" || src.source_type === "loki") add(notesBy[src.source_type], n);
      });
      const built = Date.parse(src.built_at);
      if (!Number.isNaN(built) && (builtAt === null || built < builtAt)) builtAt = built;
    }
    const mine = ofProject(part, !group);
    for (const m of mine.metrics.values()) {
      const have = metrics.get(m.name);
      if (!have) { metrics.set(m.name, m); continue; }
      have.labels = sorted([...have.labels, ...m.labels]);
      have.series += m.series;
      have.type ??= m.type;
      have.help ??= m.help;
      have.unit ??= m.unit;
      have.family ??= m.family;
      add(have.projectIds, part.project.id);
    }
    for (const s of mine.streams.values()) {
      const have = streams.get(s.name);
      if (!have) {
        streams.set(s.name, { values: new Set(s.values), sourceId: group ? null : s.sourceId, projectIds: [part.project.id] });
        continue;
      }
      s.values.forEach((v) => have.values.add(v));
      add(have.projectIds, part.project.id);
    }
  }

  return {
    ownerKind,
    metrics: [...metrics.values()].sort((a, b) => byText(a.name, b.name)),
    streams: [...streams.entries()]
      .sort(([a], [b]) => byText(a, b))
      .map(([name, s]) => ({ name, values: sorted(s.values), sourceId: s.sourceId, projectIds: s.projectIds })),
    hasPrometheus, hasLoki, builtAt, problems, notes, notesBy, streamWindowSeconds, sourceStates,
  };
}

/** How old a build is, in words: "just now", "1 min ago", "5 min ago", "2 h ago". */
export function catalogAge(builtAt: number | null, now: number): string {
  if (builtAt === null) return "";
  const seconds = (now - builtAt) / 1000;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

export interface OwnerCatalogState {
  catalog: OwnerCatalog | null;
  loading: boolean;
  /** Set only when no member's catalog could be read. */
  error: string | null;
  /** Builds every member's catalog again; rejects with the first failure's words. */
  refresh(): Promise<void>;
}

/** An owner's catalog, one request per project. `null` waits. */
export function useOwnerCatalog(owner: DashboardOwner | null): OwnerCatalogState {
  const client = useQueryClient();
  const projects = useMemo<ProjectOut[]>(
    () => (owner === null ? [] : owner.kind === "project" ? [owner.project] : owner.members),
    [owner],
  );
  const results = useQueries({
    queries: projects.map((p) => ({
      queryKey: catalogKey(p.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getCatalog(p.id, false, signal),
      staleTime: CATALOG_STALE_MS,
      retry: false,
    })),
  });
  const ownerKind: OwnerKind = owner?.kind ?? "project";
  const stamp = results.map((r) => `${r.dataUpdatedAt}/${r.errorUpdatedAt}/${r.status}`).join("|");
  const merged = useMemo(() => {
    if (owner === null) return { catalog: null, error: null };
    const parts: CatalogPart[] = projects.map((project, i) => ({
      project,
      catalog: results[i]?.data ?? null,
      error: results[i]?.data ? null : results[i]?.error ? failure(results[i].error, "try again") : null,
    }));
    const readable = parts.some((p) => p.catalog !== null);
    const first = parts.find((p) => p.error !== null);
    return {
      catalog: readable || (projects.length === 0) ? ownerCatalog(parts, ownerKind) : null,
      error: !readable && first ? first.error : null,
    };
    // `results` changes identity every render; `stamp` says when its content changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, projects, ownerKind, stamp]);

  const refresh = useCallback(async () => {
    const settled = await Promise.allSettled(
      projects.map(async (p) => { client.setQueryData(catalogKey(p.id), await getCatalog(p.id, true)); }),
    );
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;
  }, [client, projects]);

  return {
    catalog: merged.catalog,
    loading: owner !== null && results.some((r) => r.isPending && r.fetchStatus !== "idle"),
    error: merged.error,
    refresh,
  };
}
