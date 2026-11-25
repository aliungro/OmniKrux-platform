// Seeds for dashboard page tests: dashboards as the fake API holds them, panels and links; and a
// way to hold or fail chosen requests in front of the fake.
import { vi } from "vitest";
import { act } from "@testing-library/react";
import type { LinkOut, ProjectOut } from "../api/types";
import { emptyDashboard, newPanel, type DashboardSpec, type Layout, type OwnerKind, type PanelSpec, type PanelType, type VariableSpec } from "../dashboards/schema";
import type { FakeDashboard } from "./fakeMonitoringApi";
import { seedProject } from "./renderMonitoringApp";

const T = "2026-01-01T00:00:00Z";

/** A Prometheus (or Loki) source linked to a project. */
export const linkTo = (sourceId: string, type: LinkOut["source_type"] = "prometheus"): LinkOut => ({
  source_id: sourceId, source_name: `${sourceId} name`, source_type: type, filter: "", filter_origin: "none", created_by_project: false,
});

/** A project with these sources linked. */
export function linkedProject(id: string, name: string, ...sources: string[]): ProjectOut {
  return { ...seedProject(id, name), links: sources.map((s) => linkTo(s)) };
}

/** A panel with one query (`expr`), at `layout` (default: half width, eight rows, top left). */
export function panel(id: string, title: string, expr: string, layout: Partial<Layout> = {}, type: PanelType = "timeseries"): PanelSpec {
  const p = newPanel(type, id, { x: 0, y: 0, w: 12, h: 8, ...layout });
  p.title = title;
  p.queries[0].expr = expr;
  return p;
}

/** A label-values variable read from the owner's first Prometheus source. */
export function variable(name: string, label: string, over: Partial<VariableSpec> = {}): VariableSpec {
  return {
    name, label, type: "labelValues", source: { type: "prometheus", id: null }, labelName: name, match: "",
    multi: false, includeAll: false, default: [], ...over,
  };
}

export function spec(title: string, panels: PanelSpec[], variables: VariableSpec[] = []): DashboardSpec {
  return { ...emptyDashboard(title), panels, variables };
}

/** A saved dashboard (version 1), or a ready-made view (`readyMade`: version 0, no versions). */
export function seedDashboard(
  id: string, owner: { kind: OwnerKind; id: string; name: string }, doc: DashboardSpec, readyMade = false,
): FakeDashboard {
  const out: FakeDashboard["out"] = {
    id, owner_kind: owner.kind, owner_id: owner.id, owner_name: owner.name, title: doc.title, version: readyMade ? 0 : 1,
    spec: doc, ready_made: readyMade, created_at: readyMade ? null : T, updated_at: readyMade ? null : T,
  };
  const versions = readyMade ? [] : [{
    out: { version: 1, saved_at: T, title: doc.title, panel_count: doc.panels.length, origin: "created" as const, restored_from: null, copied_from: null },
    spec: doc,
  }];
  return { out, versions };
}

/**
 * Puts a rule in front of the fake API (install it first): for a request it matches, the rule's
 * answer; otherwise the fake's. `pass()` sends a request on to the fake (recorded there as usual).
 */
export function intercept(rule: (url: string, pass: () => Promise<Response>) => Promise<Response> | null) {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return rule(url, () => inner(input, init)) ?? inner(input, init);
  }));
}

/**
 * Watches the requests to one route (put it in front of the fake and any other rule): how many went
 * out, and `settled()`, which waits until each has answered and React has taken the answers in. For
 * "nothing changed after the answer" checks, without a guessed sleep.
 */
export function watchCalls(path: string) {
  const answers: Promise<unknown>[] = [];
  intercept((url, pass) => {
    if (!url.includes(path)) return null;
    const res = pass();
    answers.push(res.then((r) => r.clone().text()).catch(() => undefined));
    return res;
  });
  return {
    get count() { return answers.length; },
    async settled() {
      await Promise.all(answers);
      // One task after the last answer: the query has stored it and React has rendered it.
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    },
  };
}

/** A server failure in the dashboard routes' shape. */
export const serverFailure = (status: number, code: string, message: string) =>
  Promise.resolve(new Response(JSON.stringify({ detail: { code, message } }), { status, headers: { "content-type": "application/json" } }));

/** A gate: requests held behind it wait until `open()`. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
