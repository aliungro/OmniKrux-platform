import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Plan } from "../../../api/types";
import type { AlertChangeOut, CapabilityOut, ContactPointOut, DryRunOut } from "../../alerts/api";
import { RANGE_COPY } from "../../alerts/limits";
import { recommendFor } from "../../build/recommend";
import { emptyInstallState, installFakeMonitoringApi, type FakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { intercept, linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import { newAlert, type DashboardSpec, type PanelAlert, type PanelSpec } from "../schema";
import { mixedClustersWords } from "../../alerts/rules/clusterWarning";
import { BAND_NOTE, roundUp2, savedWithWords, startThreshold } from "./AlertTab";
import { ALERT_SAVE_REFUSED } from "./useDashboardEditor";
import { hasUnsavedWork } from "./editorState";
import { editSessions } from "./useDashboardEditor";

// The chart chunk as a stub that keeps what each panel's chart was handed.
const charts = vi.hoisted(() => ({ seen: [] as { panel: { id: string; alert: unknown } }[] }));
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: { panel: { id: string; alert: unknown }; data: { series: unknown[] } }) => {
      charts.seen.push(props);
      return createElement("span", null, `chart ${props.data.series.length}`);
    },
  };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); charts.seen.length = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const latency = { result_type: "matrix" as const, series: [{ labels: { route: "/a" }, points: [[1, 0.2], [2, 0.312]] as [number, number][] }] };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

const withAlert = (p: PanelSpec, over: Partial<PanelAlert> = {}): PanelSpec => ({ ...p, alert: { ...newAlert(p, 0.3), ...over } });
const doc = (first: (p: PanelSpec) => PanelSpec = (p) => p): DashboardSpec => spec("API latency", [
  first(panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 })),
  panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 }),
]);

function shop(d: DashboardSpec = doc(), more: Partial<FakeMonitoringState> = {}, fallback = async (_url: string, _init?: RequestInit) => json([])): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, d) },
    queryAnswers: { up: latency, errors: ok },
    ...more,
  }, fallback);
}

const draftPanel = (id: string): PanelSpec => {
  const s = editSessions.get("start0");
  if (s?.mode !== "edit") throw new Error("not editing");
  return s.draft.panels.find((p) => p.id === id)!;
};
const settings = () => screen.getByRole("complementary", { name: "Panel settings" });
const tabNamed = (name: string) => within(settings()).getByRole("tab", { name });
const threshold = () => within(settings()).getByRole("textbox", { name: "Threshold" }) as HTMLInputElement;
const dryRuns = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/alerts/dry-run");

async function editing(charted = true) {
  const user = userEvent.setup();
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1 });
  await waitFor(() => expect(document.activeElement).toBe(title));
  if (charted) await screen.findAllByText(/^chart /);
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  return { user, app };
}

/** Edit mode with the first tile's settings open on the Alert tab. */
async function alertTab() {
  const out = await editing();
  await out.user.keyboard("{Enter}");
  await screen.findByRole("complementary", { name: "Panel settings" });
  await out.user.click(tabNamed("Alert"));
  return out;
}

/** The dashboard opened by an alert's "Edit on its panel". */
async function openedOnAlert(panelId = "p-1") {
  const user = userEvent.setup();
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1", panel: panelId, editAlert: true }) });
  await screen.findByRole("complementary", { name: "Panel settings" });
  return { user, app };
}

const dryRun = (fired: number, candidates: { threshold: number; fired: number }[] = [], error = false): DryRunOut => ({
  start: 0, end: 21600, step: 60, fired, firing_now: false, periods: [], candidates, took_ms: 1,
  projects: [{
    project_id: "p1", project_name: "Shop", fired, firing_now: false, periods: [], series: 1,
    error: error ? { code: "unreachable", message: "Prometheus didn't answer." } : null,
  }],
});

describe("The Alert tab", () => {
  it("Add an alert fills a sentence from the panel", async () => {
    shop();
    const { user } = await alertTab();
    await user.click(within(settings()).getByRole("button", { name: "Add an alert" }));
    // The title as its name, query A, the data's maximum (0.312) rounded up to two digits.
    expect(document.activeElement).toBe(threshold());
    expect(threshold().value).toBe("0.32");
    const alert = draftPanel("p-1").alert!;
    expect(alert).toMatchObject({ name: "Requests", query: "A", op: "above", threshold: 0.32, for: "5m", every: "1m", engine: "omnikrux" });
    expect(within(settings()).getByRole("textbox", { name: "Name" })).toHaveProperty("value", "Requests");
    expect(within(settings()).getByText(BAND_NOTE)).toBeTruthy();
    expect(within(settings()).getByText(savedWithWords("Shop"))).toBeTruthy();
    // One query: no Query picker; nothing saved yet: no state and no removal note.
    expect(within(settings()).queryByRole("combobox", { name: "Query" })).toBeNull();
    expect(within(settings()).queryByText(/^Now:/)).toBeNull();
    // An alert edit is unsaved work: the JSON tab's draft has it.
    const session = editSessions.get("start0")!;
    expect(hasUnsavedWork(session)).toBe(true);
    expect(session.mode === "edit" && JSON.parse(JSON.stringify(session.draft)).panels[0].alert.threshold).toBe(0.32);
    // Only the query the new alert reads (the first visible) sets where it starts.
    const two = { ...panel("p-9", "Two", "up"), queries: [panel("x", "", "up").queries[0], { ...panel("x", "", "errors").queries[0], ref: "B" }] } as PanelSpec;
    const data = { state: "ready" as const, logs: [], problems: [], summary: { series: 2, points: 4, tookMs: 1 }, editId: 0, series: [
      { key: "a", name: "a", labels: {}, queryRef: "A", projectName: null, points: [[1, 0.312]] as [number, number | null][] },
      { key: "b", name: "b", labels: {}, queryRef: "B", projectName: null, points: [[1, 5]] as [number, number | null][] },
    ] };
    expect(startThreshold(two, data)).toBe(0.32);
    expect(roundUp2(0.312)).toBe(0.32);
    expect(roundUp2(1234)).toBe(1300);
    expect(roundUp2(0.3)).toBe(0.3);
  });

  it("a panel's alert draws its band", async () => {
    shop();
    const { user } = await alertTab();
    await user.click(within(settings()).getByRole("button", { name: "Add an alert" }));
    // The panel's chart is handed the panel with its alert: the chart draws the band from it.
    await waitFor(() => {
      const last = charts.seen.filter((c) => c.panel.id === "p-1").at(-1);
      expect(last?.panel.alert).toMatchObject({ op: "above", threshold: 0.32, query: "A" });
    });
    await user.clear(threshold());
    await user.type(threshold(), "0.5");
    await waitFor(() => expect(charts.seen.filter((c) => c.panel.id === "p-1").at(-1)?.panel.alert).toMatchObject({ threshold: 0.5 }));
    expect(draftPanel("p-1").alert!.threshold).toBe(0.5);
  });

  it("a table panel can't have an alert", async () => {
    shop(spec("API latency", [panel("p-1", "Routes", "up", { x: 0, y: 0, w: 12, h: 8 }, "table")]));
    await alertTab();
    const body = within(settings()).getByRole("tabpanel");
    expect(body.textContent).toBe("A table panel can't have an alert. Use a time series, stat, gauge or bar panel.");
    expect(within(body).queryAllByRole("button")).toHaveLength(0);
  });

  it("a query with $__range says why", async () => {
    const api = shop(spec("API latency", [panel("p-1", "Requests", "sum(rate(http_requests_total[$__range]))", { x: 0, y: 0, w: 12, h: 8 })]));
    const { user } = await editing(false);
    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: "Panel settings" });
    await user.click(tabNamed("Alert"));
    await user.click(within(settings()).getByRole("button", { name: "Add an alert" }));
    // The rule's query can't be run: its words stand where the dry run would, once.
    expect(within(settings()).getAllByText(RANGE_COPY)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 650));
    expect(dryRuns(api)).toHaveLength(0);
  });

  it("an unknown contact point opens the Alert tab with the copy", async () => {
    const GONE = "That contact point no longer exists. Pick another.";
    shop(doc((p) => withAlert(p, { notify: ["cp-gone"] })));
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/monitoring/dashboards/d1" && init?.method === "PUT") {
        return Promise.resolve(json({
          detail: { code: "invalid_dashboard", message: GONE, problems: [{ path: "panels[0].alert.notify[0]", message: GONE }] },
        }, 422));
      }
      return inner(input, init);
    }));
    const { user } = await editing();
    // An edit elsewhere (the second panel's title), then Save.
    await user.keyboard("{ArrowRight}{Enter}");
    await screen.findByRole("complementary", { name: "Panel settings" });
    await user.click(tabNamed("Options"));
    await user.type(within(settings()).getByLabelText("Title"), "!");
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));

    await waitFor(() => expect(within(settings()).getByRole("heading", { name: "Requests" })).toBeTruthy());
    expect(tabNamed("Alert").getAttribute("aria-selected")).toBe("true");
    const notify = within(settings()).getByRole("group", { name: "Notify" });
    expect(within(notify).getByText(GONE)).toBeTruthy();
    // The contact point that's gone is listed, ticked, so it can be unticked; the keyboard is on it.
    const gone = within(notify).getByRole("checkbox", { name: /A contact point that no longer exists/ }) as HTMLInputElement;
    expect(gone.checked).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(gone));
    await user.click(gone);
    expect(draftPanel("p-1").alert!.notify).toEqual([]);
    // Unticked: the alert names no contact point that's gone, so the refusal no longer applies.
    expect(within(notify).queryByText(GONE)).toBeNull();
    expect(document.activeElement).toBe(gone);
    expect(gone.checked).toBe(false);
  });

  it("Edit on its panel opens the Alert tab", async () => {
    shop(doc((p) => withAlert(p)));
    const { app } = await openedOnAlert();
    expect(within(settings()).getByRole("heading", { name: "Requests" })).toBeTruthy();
    expect(tabNamed("Alert").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Editing")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(threshold()));
    expect(threshold().value).toBe("0.3");
    // Acted on once: the view no longer asks for it (a replace, so Back still leaves the dashboard).
    const view = app.current().tabs[0].view;
    expect(view).toEqual({ page: "dashboard", id: "d1" });
    expect(app.current().tabs[0].back).toHaveLength(0);
  });

  it("a threshold that isn't a number is never saved as another number", async () => {
    const api = shop(doc((p) => withAlert(p)));
    const { user, app } = await openedOnAlert();
    await waitFor(() => expect(document.activeElement).toBe(threshold()));
    await user.clear(threshold());
    await user.type(threshold(), "1,5");
    // The draft holds the last number typed ("1"); the text stays with the session.
    expect(draftPanel("p-1").alert!.threshold).toBe(1);
    await user.click(tabNamed("Query"));
    await user.click(tabNamed("Alert"));
    expect(threshold().value).toBe("1,5");

    // Save is refused: nothing is sent, the edit bar says why, and the keyboard is on Threshold.
    const puts = () => api.requests.filter((r) => r.method === "PUT");
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    expect(await screen.findByText(ALERT_SAVE_REFUSED)).toBeTruthy();
    expect(puts()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(threshold()));
    expect(screen.getByText("Editing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show in JSON" })).toBeNull();

    // It is unsaved work: leaving asks first.
    app.navigate({ page: "home" }, "push");
    const leave = await screen.findByRole("alertdialog", { name: 'Leave "API latency" with unsaved changes?' });
    fireEvent.click(within(leave).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    // A number again: the refusal goes, and Save writes what the field shows.
    await user.clear(threshold());
    await user.type(threshold(), "1.5");
    expect(screen.queryByText(ALERT_SAVE_REFUSED)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0].body as { spec: DashboardSpec }).spec.panels[0].alert!.threshold).toBe(1.5);
    await waitFor(() => expect(screen.queryByText("Editing")).toBeNull());
  });

  it("the warn-harder warning shows when the owner's link may mix clusters", async () => {
    const project = { ...linkedProject("p1", "Shop", "s1"), kind: "kubernetes" as const, cluster_id: "c1" };
    shop(doc((p) => withAlert(p)), { projects: [project] });
    await openedOnAlert();
    const warning = await waitFor(() => {
      const el = settings().querySelector("[data-cluster-warning]");
      if (!el) throw new Error("no warning yet");
      return el;
    });
    expect(warning.textContent).toBe(mixedClustersWords("Shop", "s1 name"));
  });

  it("a threshold that would fire often recommends a calmer one", async () => {
    const p = withAlert(panel("p-1", "Latency", "histogram_quantile(0.95, sum by (le) (rate(http_seconds_bucket[5m])))"));
    const often = dryRun(5, [{ threshold: 0.35, fired: 3 }, { threshold: 0.5, fired: 1 }, { threshold: 0.8, fired: 0 }]);
    const ctx = (out: DryRunOut, alert: PanelAlert = p.alert!) => ({ panel: p, data: null, catalog: null, stepSeconds: 0, alert: { alert, dryRun: out } });
    const rec = recommendFor(ctx(often), new Set());
    expect(rec?.id).toBe("calmerThreshold");
    expect(rec?.key).toBe("calmerThreshold:p-1:0.3");
    expect(rec?.text.map((t) => (typeof t === "string" ? t : t.strong)).join("")).toBe("That's often. At 0.5 it would have fired once.");
    expect(rec?.apply(p).alert?.threshold).toBe(0.5);
    expect(rec?.applyLabel).toBe("Use 0.5");
    const quiet = recommendFor(ctx(dryRun(5, [{ threshold: 0.8, fired: 0 }])), new Set());
    expect(quiet?.text.map((t) => (typeof t === "string" ? t : t.strong)).join("")).toBe("That's often. At 0.8 it wouldn't have fired.");
    // Not often enough, part of the data unread, or a dry run of another threshold: nothing.
    expect(recommendFor(ctx(dryRun(2, often.candidates)), new Set())).toBeNull();
    expect(recommendFor(ctx(dryRun(5, often.candidates, true)), new Set())).toBeNull();
    expect(recommendFor(ctx(often, { ...p.alert!, threshold: 0.25 }), new Set())).toBeNull();

    // In the editor: the bar above the tabs says it, and Apply sets the draft's threshold.
    const api = shop(doc((x) => withAlert(x)), { dryRun: often });
    const { user } = await openedOnAlert();
    await waitFor(() => expect(within(settings()).getByRole("region", { name: "Recommendation" }).textContent)
      .toContain("That's often. At 0.5 it would have fired once."), { timeout: 3000 });
    // The tab doesn't say it a second time.
    expect(within(settings()).getAllByText(/That's often/)).toHaveLength(1);
    const body = dryRuns(api)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ scope: { kind: "project", id: "p1" }, source: { type: "prometheus", id: null }, expr: "up", op: "above", threshold: 0.3, suggest: true });
    await user.click(within(settings()).getByRole("button", { name: "Use 0.5" }));
    expect(draftPanel("p-1").alert!.threshold).toBe(0.5);
    await waitFor(() => expect(threshold().value).toBe("0.5"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a panel alert on tools OmniKrux installed notifies contact points", async () => {
    const ops: ContactPointOut = {
      id: "c1", name: "Slack #ops", type: "slack", settings: {}, secrets_set: ["url"], summary: "Slack, #ops", used_by: [], last_delivery: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    };
    const cap: CapabilityOut = {
      project_id: "p1", project_name: "Shop", source_id: "s1", source_name: "Prometheus", tool: "prometheus_rule", reason: null, installed_by_omnikrux: true,
    };
    const contactsPlan: Plan = {
      plan_id: "plan-c", action: "edit",
      target: { cluster_id: "k1", kind_key: "alertmanagerconfigs.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-contact-points" },
      kind: "AlertmanagerConfig", cluster: { id: "k1", name: "kind-install", provider: "kind", environment: "development" },
      title: "Update contact points in monitoring", summary: ["Routes 1 rule to 1 contact point."], warnings: [], blocked: [], diff: null,
      confirm_text: null, apply_label: "Update", expires_at: "2026-11-24T10:05:00Z",
    };
    const contacts: AlertChangeOut = { target_id: "", rule_id: "", rule_name: "", project_id: "", project_name: "kind-install", kind: "contacts", message: null, cluster_id: "k1" };
    const api = shop(doc((p) => withAlert(p)), {
      contactPoints: [ops], capabilities: [cap], alertChangesOnSave: [contacts],
      install: { ...emptyInstallState(), contacts: { k1: { kind: "review", plan: contactsPlan } } },
    });
    const { user } = await openedOnAlert();
    await waitFor(() => expect(document.activeElement).toBe(threshold()));
    // Picked while OmniKrux checks it, kept when it moves into the tool OmniKrux installed.
    const notify = await within(settings()).findByRole("group", { name: "Notify" });
    await user.click(within(notify).getByRole("checkbox", { name: /Slack #ops/ }));
    await waitFor(() => expect((within(settings()).getByRole("radio", { name: "In the tool" }) as HTMLInputElement).disabled).toBe(false));
    await user.click(within(settings()).getByRole("radio", { name: "In the tool" }));
    const still = within(settings()).getByRole("group", { name: "Notify" });
    expect(within(still).getByText(
      "These contact points are sent from the Alertmanager OmniKrux installed; saving asks you to review that change.",
    )).toBeTruthy();
    expect((within(still).getByRole("checkbox", { name: /Slack #ops/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(settings()).queryByLabelText("Channel")).toBeNull();
    expect(draftPanel("p-1").alert).toMatchObject({ engine: "tool", notify: ["c1"] });

    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "PUT" && r.url === "/api/monitoring/dashboards/d1")).toBe(true));
    const sent = api.requests.find((r) => r.method === "PUT" && r.url === "/api/monitoring/dashboards/d1")!.body as { spec: DashboardSpec };
    expect(sent.spec.panels[0].alert).toMatchObject({ engine: "tool", notify: ["c1"] });
    // The save's contacts change opens the review of that Alertmanager's contact points.
    expect(await screen.findByRole("dialog", { name: "Update contact points in monitoring" })).toBeTruthy();
  });

  it("a tool alert's hidden contact points go where OmniKrux didn't install the tools, and stay while that isn't known", async () => {
    const cap: CapabilityOut = { project_id: "p1", project_name: "Shop", source_id: "s1", source_name: "Prometheus", tool: "prometheus_rule", reason: null };
    const saved = (api: FakeMonitoringApi) => {
      const put = api.requests.find((r) => r.method === "PUT" && r.url === "/api/monitoring/dashboards/d1");
      return put ? (put.body as { spec: DashboardSpec }).spec.panels[0].alert : undefined;
    };

    // Known not to be OmniKrux's: the hidden contact point goes from the draft and isn't sent.
    let api = shop(doc((p) => withAlert(p, { engine: "tool", notify: ["c1"] })), { capabilities: [cap] });
    let out = await openedOnAlert();
    await waitFor(() => expect(draftPanel("p-1").alert?.notify).toEqual([]));
    expect(within(settings()).queryByRole("group", { name: "Notify" })).toBeNull();
    await out.user.click(screen.getByRole("button", { name: "Save dashboard" }));
    await waitFor(() => expect(saved(api)).toMatchObject({ engine: "tool", notify: [] }));
    cleanup();
    editSessions.clear();

    // Not known (the read failed): the saved contact point stays as it is.
    api = shop(doc((p) => withAlert(p, { engine: "tool", notify: ["c1"] })));
    intercept((url) => (url.includes("/alerts/capabilities") ? Promise.resolve(json({ detail: "Prometheus didn't answer." }, 502)) : null));
    out = await openedOnAlert();
    await waitFor(() => expect(document.activeElement).toBe(threshold()));
    await within(settings()).findByText(/Prometheus didn't answer/);
    await out.user.clear(threshold());
    await out.user.type(threshold(), "0.4");
    expect(draftPanel("p-1").alert?.notify).toEqual(["c1"]);
    await out.user.click(screen.getByRole("button", { name: "Save dashboard" }));
    await waitFor(() => expect(saved(api)).toMatchObject({ engine: "tool", notify: ["c1"], threshold: 0.4 }));
  });

  it("saving a tool-run alert opens its review after the save", async () => {
    const plan: Plan = {
      plan_id: "plan-1", action: "create",
      target: { cluster_id: "c1", kind_key: "prometheusrules.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-requests-1a2b" },
      kind: "PrometheusRule", cluster: { id: "c1", name: "kind-dev", provider: "kind", environment: "development" },
      title: "Create PrometheusRule omnikrux-requests-1a2b", summary: ["Create PrometheusRule monitoring/omnikrux-requests-1a2b with 1 rule."],
      warnings: [], blocked: [], diff: null, confirm_text: null, apply_label: "Create", expires_at: "2026-11-23T10:05:00Z",
    };
    const change: AlertChangeOut = { target_id: "t1", rule_id: "r1", rule_name: "Requests", project_id: "p1", project_name: "Shop", kind: "review", message: null };
    const seen: string[] = [];
    shop(doc((p) => withAlert(p, { engine: "tool" })), {
      alertChangesOnSave: [change], syncAnswers: { t1: { kind: "review", plan } },
    }, async (url, init) => {
      seen.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      return (init?.method ?? "GET").toUpperCase() === "DELETE" ? new Response(null, { status: 204 }) : json([]);
    });
    const { user } = await openedOnAlert();
    await waitFor(() => expect(document.activeElement).toBe(threshold()));
    await user.clear(threshold());
    await user.type(threshold(), "0.4");
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));

    // The review opens over the saved dashboard: edit mode has ended by then.
    const dialog = await screen.findByRole("dialog", { name: "Create PrometheusRule omnikrux-requests-1a2b" });
    expect(screen.queryByText("Editing")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const status = screen.getByTestId("tool-review-status").querySelector('[role="status"]') as HTMLElement;
    await waitFor(() => expect(status.textContent).toBe(`"Requests" isn't applied in Shop's cluster yet. Review it from its panel or the Alerts page.`));
    expect(seen).toContain("DELETE /api/actions/plan-1");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));
  });
});
