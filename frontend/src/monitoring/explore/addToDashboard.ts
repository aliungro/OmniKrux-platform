// Add an Explore query to a dashboard as a new panel (X5): which dashboards can take it, the panel
// it becomes, and the two writes (append to a saved dashboard; create one with the panel in it).
// The query text is the text in the field, as it stands: never rewritten here.

import type { GroupOut, LinkOut, ProjectOut } from "../api/types";
import {
  createDashboard, DashboardRequestError, getDashboard, saveDashboard, type DashboardOut, type DashboardSummaryOut,
} from "../dashboards/api";
import { appendPanel, type NewPanel } from "../dashboards/layout";
import { DEFAULT_SIZES, emptyDashboard, newPanel, type DashboardSpec, type OwnerKind, type PanelType, type Unit } from "../dashboards/schema";

export const CHANGED_TWICE = "That dashboard changed twice while adding. Try again.";

export type DashboardTarget = { id: string; title: string; ownerKind: OwnerKind; ownerName: string };

const byTitle = (a: DashboardSummaryOut, b: DashboardSummaryOut) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/**
 * The saved dashboards that can take the panel: the project's own, then each group that holds the
 * project with its dashboards. Each list is by title. Ready-made views are never targets (they are
 * read-only and generated on request).
 */
export function dashboardTargets(project: ProjectOut, groups: GroupOut[], dashboards: DashboardSummaryOut[]): DashboardTarget[] {
  const saved = dashboards.filter((d) => !d.ready_made && !d.id.startsWith("ready:"));
  const of = (kind: OwnerKind, id: string, name: string): DashboardTarget[] =>
    saved
      .filter((d) => d.owner_kind === kind && d.owner_id === id)
      .sort(byTitle)
      .map((d) => ({ id: d.id, title: d.title, ownerKind: kind, ownerName: name }));
  const own = of("project", project.id, project.name);
  const held = groups
    .filter((g) => g.project_ids.includes(project.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [...own, ...held.flatMap((g) => of("group", g.id, g.name))];
}

/** "Explore", or "Explore (2)"… when a dashboard of that owner already has the title. */
export function freshTitle(taken: string[], base = "Explore"): string {
  const used = new Set(taken);
  let title = base;
  for (let n = 2; used.has(title); n++) title = `${base} (${n})`;
  return title;
}

/**
 * The panel Explore's query becomes: one query on the chosen source (a group's panel never pins a
 * source: each of its projects uses its own). `unit` only goes where the type's options have one.
 */
export function explorePanel(
  input: { expr: string; source: Pick<LinkOut, "source_id" | "source_type">; title: string; panelType: PanelType; unit: Unit },
  id: string,
  ownerKind: OwnerKind,
): NewPanel {
  const base = newPanel(input.panelType, id, { x: 0, y: 0, ...DEFAULT_SIZES[input.panelType] });
  const options: Record<string, unknown> = { ...base.options };
  if ("unit" in options) options.unit = input.unit; // logs options have no unit (the schema refuses it)
  const { layout: _layout, ...rest } = base;
  void _layout;
  return {
    ...rest,
    title: input.title,
    queries: [{
      ref: "A",
      source: { type: input.source.source_type, id: ownerKind === "group" ? null : input.source.source_id },
      expr: input.expr,
      legend: "",
      hidden: false,
    }],
    options,
  } as unknown as NewPanel;
}

const isConflict = (err: unknown): err is DashboardRequestError => err instanceof DashboardRequestError && err.code === "version_conflict";

/**
 * Reads the dashboard, appends the panel it builds and saves over the version read. When another
 * save landed first (409) it reads again and appends to the newer document, once; a second
 * conflict stops. A refused save changed nothing, so the panel is never added twice.
 */
export async function addPanelToDashboard(
  target: DashboardTarget,
  build: (spec: DashboardSpec) => NewPanel,
): Promise<{ title: string; version: number }> {
  for (let attempt = 0; ; attempt++) {
    const current = await getDashboard(target.id);
    const next = appendPanel(current.spec, build(current.spec));
    try {
      const saved = await saveDashboard(target.id, current.version, next, "explore");
      return { title: saved.title, version: saved.version };
    } catch (err) {
      if (!isConflict(err)) throw err;
      if (attempt > 0) throw new DashboardRequestError(409, "version_conflict", CHANGED_TWICE, [], err.currentVersion);
    }
  }
}

/** A new dashboard of the project with the panel in it, in one create. */
export function createDashboardWithPanel(
  owner: { kind: "project"; id: string },
  title: string,
  build: (spec: DashboardSpec) => NewPanel,
): Promise<DashboardOut> {
  const empty = emptyDashboard(title);
  return createDashboard({ owner_kind: owner.kind, owner_id: owner.id, spec: appendPanel(empty, build(empty)) });
}
