import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut, LinkOut, ProjectOut, SourceOut } from "../api/types";
import type { Plan } from "../../api/types";
import type { AlertChangeOut, RuleOut, TargetOut } from "../alerts/api";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import { panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { editSessions } from "../dashboards/editor/useDashboardEditor";

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);

function source(id: string, name: string, over: Partial<SourceOut> = {}): SourceOut {
  return {
    id, name, type: "prometheus", reach: "url", url: "http://prom.example:9090", cluster_id: null, cluster_name: null, namespace: null,
    service: null, port: null, scheme: "http", path_prefix: "",
    auth: { type: "none", username: null, header_name: null, has_password: false, has_token: false, has_api_key: false, has_client_key: false, has_client_cert: false },
    headers: [], has_ca: false, created_by_project_id: null, used_by: [], health: { state: "unknown", message: null, version: null, checked_at: null },
    created_at: T, updated_at: T, ...over,
  };
}
const link = (s: SourceOut, filter = "", over: Partial<LinkOut> = {}): LinkOut => ({
  source_id: s.id, source_name: s.name, source_type: s.type, filter, filter_origin: filter ? "auto" : "none", created_by_project: false, ...over,
});
function project(id: string, name: string, links: LinkOut[] = [], over: Partial<ProjectOut> = {}): ProjectOut {
  return { ...seedProject(id, name), links, ...over };
}
const group = (id: string, name: string, project_ids: string[]): GroupOut => ({ id, name, project_ids, created_at: T, updated_at: T });

const open = (id: string) => renderMonitoringApp({ tabs: tabsWith({ page: "project", id }) });

describe("Project page", () => {
  it("editing a link filter saves it as the user's", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    const api = installFakeMonitoringApi({ sources: [prom], projects: [project("p1", "Dev", [link(prom, 'cluster="a"')])] }, fallback);
    open("p1");
    const field = await screen.findByRole("textbox", { name: "Filter for Prom" });
    expect((field as HTMLInputElement).value).toBe('cluster="a"');
    await user.clear(field);
    await user.type(field, 'cluster="b"');
    await user.click(screen.getByRole("button", { name: /^Save filter/ }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "PUT")).toBe(true));
    const put = api.requests.find((r) => r.method === "PUT")!;
    expect(put.url).toBe("/api/monitoring/projects/p1/sources/s1");
    expect(put.body).toEqual({ filter: 'cluster="b"', origin: "user" });
    expect(await screen.findByText("Filter saved.")).toBeTruthy();
    // The saved button stays reachable: the keyboard never falls to the page body.
    expect(document.activeElement).not.toBe(document.body);
  });

  it("will not save a filter the server could not read", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    const api = installFakeMonitoringApi({ sources: [prom], projects: [project("p1", "Dev", [link(prom)])] }, fallback);
    open("p1");
    await user.type(await screen.findByRole("textbox", { name: "Filter for Prom" }), "nonsense");
    await user.click(screen.getByRole("button", { name: /^Save filter/ }));
    expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("check data shows what the project sees", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    const loki = source("s2", "Logs", { type: "loki" });
    const api = installFakeMonitoringApi({
      sources: [prom, loki], projects: [project("p1", "Dev", [link(prom), link(loki)])],
      fields: {
        s1: { metrics: [{ name: "up", type: null, help: null, unit: null }, { name: "x", type: null, help: null, unit: null }], labels: ["a", "b", "c"], truncated: false },
        s2: { metrics: [], labels: ["app"], truncated: false },
      },
    }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Check data for Prom" }));
    expect(await screen.findByText("2 metrics and 3 labels visible to this project")).toBeTruthy();
    expect(api.requests.some((r) => r.url === "/api/monitoring/sources/s1/fields?project=p1")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Check data for Logs" }));
    expect(await screen.findByText("1 label visible to this project")).toBeTruthy();
  });

  it("says in words when a check fails", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    installFakeMonitoringApi({ sources: [prom], projects: [project("p1", "Dev", [link(prom)])] }, fallback);
    open("p1");
    const button = await screen.findByRole("button", { name: "Check data for Prom" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    await user.click(button);
    expect(await screen.findByText(/Can't reach the console's server\. Check that it's running, then check again\./)).toBeTruthy();
    expect(document.activeElement).toBe(button);
  });

  it("unlinks a source and keeps the keyboard on the page", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    const api = installFakeMonitoringApi({ sources: [prom], projects: [project("p1", "Dev", [link(prom)])] }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Unlink Prom" }));
    await waitFor(() => expect(api.state.projects[0].links).toHaveLength(0));
    await screen.findByText("No sources yet. Use an existing one or add one by hand.");
    expect(document.activeElement).not.toBe(document.body);
    expect(api.state.sources).toHaveLength(1);
  });

  it("keeps the keyboard on Cancel when every source is already linked", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    installFakeMonitoringApi({ sources: [prom], projects: [project("p1", "Dev", [link(prom)])] }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Use an existing source" }));
    expect(await screen.findByText(/Every source is already linked/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use an existing source" })));
  });

  it("links an existing source with a suggested filter", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    const api = installFakeMonitoringApi({
      sources: [prom], projects: [project("p1", "Dev")],
      suggestion: { filter: 'cluster="dev"', origin: "auto", reason: "Matches the cluster's label." },
    }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Use an existing source" }));
    await user.selectOptions(screen.getByLabelText("Source"), "s1");
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Filter for the new link" }) as HTMLInputElement).value).toBe('cluster="dev"'));
    await user.click(screen.getByRole("button", { name: "Link source" }));
    await waitFor(() => expect(api.state.projects[0].links).toHaveLength(1));
    expect(api.requests.find((r) => r.method === "PUT")!.body).toEqual({ filter: 'cluster="dev"', origin: "auto" });
    expect(await screen.findByRole("button", { name: "Unlink Prom" })).toBeTruthy();
  });

  it("adds a source by hand and links it", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: [project("p1", "Dev")] }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Add a source by hand" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.state.projects[0].links).toHaveLength(1));
    expect(api.state.sources).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /^Unlink/ })).toBeTruthy();
  });

  it("renames, and shows the server's words when the name is taken", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: [project("p1", "Dev"), project("p2", "Stage")] }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Name");
    expect(document.activeElement).toBe(input);
    await user.clear(input);
    await user.type(input, "Stage");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect((await screen.findByRole("alert")).textContent).toContain('A project named "Stage" already exists.');
    await user.clear(input);
    await user.type(input, "Dev 2{Enter}");
    await waitFor(() => expect(api.state.projects[0].name).toBe("Dev 2"));
    expect(await screen.findByRole("heading", { name: "Dev 2" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename" }));
  });

  it("shows the groups it is in, and that the cluster is gone", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({
      projects: [project("p1", "Dev", [], { kind: "kubernetes", cluster_id: "c-gone", cluster_name: "old", group_ids: ["g1"] })],
      groups: [group("g1", "Prod", ["p1"])],
    }, fallback);
    open("p1");
    expect(await screen.findByText("Cluster no longer connected")).toBeTruthy();
    const page = within(document.querySelector("[data-monitoring-page]") as HTMLElement);
    expect(page.getByText("No dashboards yet. Start one with New dashboard, or copy a ready-made view.")).toBeTruthy();
    expect(page.getByText("Link a Prometheus-compatible source to get ready-made views.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Prod" }));
    expect(await screen.findByRole("heading", { name: "Prod" })).toBeTruthy();
  });
  it("project page lists dashboards and ready-made views with notes", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    const DEV = { kind: "project" as const, id: "p1", name: "Dev" };
    const api = installFakeMonitoringApi({
      sources: [prom],
      projects: [project("p1", "Dev", [link(prom)])],
      dashboards: {
        a1: seedDashboard("a1", DEV, spec("API latency", [panel("a", "A", "up"), panel("b", "B", "up", { x: 12 })])),
        a2: seedDashboard("a2", DEV, spec("Errors", [panel("a", "A", "up")])),
        "ready:p1:nodes": seedDashboard("ready:p1:nodes", DEV, spec("Node health", []), true),
      },
      readyMade: { p1: [{
        key: "nodes", id: "ready:p1:nodes", title: "Node health", description: "CPU, memory and disk of each node.",
        missing: ["node_exporter"], notes: ["Node exporter isn't reporting, so node panels stay empty."], checked: true, check_message: null,
      }] },
    }, fallback);
    open("p1");
    const list = await screen.findByRole("list", { name: "Dashboards of Dev" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("button").textContent)).toEqual([
      expect.stringContaining("API latency"), expect.stringContaining("Errors"),
    ]);
    expect(within(rows[0]).getByText("2 panels")).toBeTruthy();
    expect(within(rows[1]).getByText("1 panel")).toBeTruthy();
    expect(within(rows[0]).getByText(/^saved /)).toBeTruthy();
    const ready = screen.getByRole("list", { name: "Ready-made views" });
    expect(within(ready).getByText("Node health")).toBeTruthy();
    expect(within(ready).getByText("CPU, memory and disk of each node.")).toBeTruthy();
    expect(within(ready).getByText("Node exporter isn't reporting, so node panels stay empty.")).toBeTruthy();
    expect(screen.queryByText(/Link a Prometheus-compatible source/)).toBeNull();
    // Ctrl+Enter opens a dashboard in a new tab; a click opens it here.
    fireEvent.keyDown(within(rows[1]).getByRole("button"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab")).toHaveLength(2));
    expect(await screen.findByRole("heading", { level: 1, name: "Errors" })).toBeTruthy();
    await user.click(within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab")[0]);
    await user.click(within(await screen.findByRole("list", { name: "Ready-made views" })).getByRole("button", { name: "Copy to edit Node health" }));
    expect(await screen.findByText('Copied "Node health". Changes go to your copy.')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save dashboard" })).toBeTruthy();
    expect(api.requests.find((r) => r.url === "/api/monitoring/dashboards/copy")?.body).toEqual({ from_id: "ready:p1:nodes", owner_kind: "project", owner_id: "p1" });
  });

  it("New dashboard on the project page goes to the project", async () => {
    const api = installFakeMonitoringApi({ projects: [project("p1", "Dev"), project("p2", "Stage")] }, fallback);
    open("p1");
    fireEvent.click(await screen.findByRole("button", { name: "New dashboard for Dev" }));
    const dialog = await screen.findByRole("dialog", { name: "New dashboard" });
    expect((within(dialog).getByLabelText("Goes to") as HTMLSelectElement).value).toBe("project:p1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dashboard" }));
    expect(await screen.findByRole("heading", { level: 1, name: "New dashboard" })).toBeTruthy();
    expect(Object.values(api.state.dashboards).map((d) => d.out.owner_id)).toEqual(["p1"]);
  });
});

describe("Project delete review", () => {
  const withEverything = (fb: (url: string) => Promise<Response> = fallback) => {
    const own = source("s1", "Own", { created_by_project_id: "p1" });
    const shared = source("s2", "Shared", { created_by_project_id: "p1" });
    const plain = source("s3", "Plain");
    return installFakeMonitoringApi({
      sources: [own, shared, plain],
      projects: [
        project("p1", "Dev", [link(own), link(shared), link(plain)], { group_ids: ["g1"] }),
        project("p2", "Stage", [link(shared)]),
      ],
      groups: [group("g1", "Prod", ["p1", "p2"])],
    }, fb);
  };

  it("project delete review lists only what applies and opens on its button", async () => {
    const user = userEvent.setup();
    withEverything();
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Delete project Dev?" })).toBeTruthy();
    expect(within(dialog).getByText("Sources it created that go with it: Own.")).toBeTruthy();
    expect(within(dialog).getByText("Sources it created that other projects still use stay: Shared (used by Stage).")).toBeTruthy();
    expect(within(dialog).getByText("Other sources stay as they are and are only unlinked: Plain.")).toBeTruthy();
    expect(within(dialog).getByText("It leaves these groups; the groups stay: Prod.")).toBeTruthy();
    expect(within(dialog).queryByText("Only the project itself is removed.")).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Delete project" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete project…" }));
  });

  const clusterRule = (): RuleOut => {
    const target: TargetOut = {
      id: "t1", project_id: "p1", project_name: "Dev", engine: "tool", tool: "prometheus_rule", where: "kind-dev", engine_note: null,
      state: "waiting", state_since: T, last_eval_at: null, message: null, eval_expr: "", rule_text: "", tool_state: "in_sync",
      tool_message: null, leaving: false, instances: [],
    };
    return {
      id: "r1", name: "Slow checkout", scope: { kind: "project", id: "p1", name: "Dev" }, source_type: "prometheus", source_id: null, expr: "up",
      condition: { of: "each", op: "above", threshold: 5, for: "5m", every: "1m" }, severity: "warning", message: "", contact_points: [],
      engine: "tool", channel: null, paused: false, origin: "page", panel: null, state: "waiting", firing_since: null, targets: [target],
      removing: false, version: 1, created_at: T, updated_at: T,
    };
  };

  it("project delete lists its alert rules", async () => {
    const user = userEvent.setup();
    const api = withEverything();
    api.state.ownerRules.p1 = { alert_rules: [{ id: "r1", name: "Slow checkout" }, { id: "r2", name: "Disk full" }] };
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Alert rules that go with it: Slow checkout, Disk full.")).toBeTruthy();
    expect(within(dialog).queryByText(/Remove its rules/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Delete project" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("project delete waits for cluster rules", async () => {
    const user = userEvent.setup();
    const api = withEverything(async (url: string) => json(url === "/api/clusters" ? [{ id: "c1", name: "kind-dev", provider: "kind", state: "ready" }] : []));
    api.state.projects[0] = { ...api.state.projects[0], kind: "kubernetes", cluster_id: "c1", cluster_name: "kind-dev" };
    api.state.rules = [clusterRule()];
    api.state.ownerRules.p1 = { alert_rules: [{ id: "r1", name: "Slow checkout" }], cluster_rules: [{ id: "r1", name: "Slow checkout" }] };
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("Remove its rules that run in kind-dev first: Slow checkout. Each opens its own review.")).toBeTruthy();
    const del = within(dialog).getByRole("button", { name: "Delete project" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    await user.click(del);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(api.requests.some((r) => r.method === "DELETE" && r.url.startsWith("/api/monitoring/projects/"))).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Review Slow checkout" })).toBeTruthy();
  });

  const PLAN: Plan = {
    plan_id: "plan-1", action: "delete", target: { cluster_id: "c1", kind_key: "prometheusrules.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-slow" },
    kind: "PrometheusRule", cluster: { id: "c1", name: "kind-dev", provider: "kind", environment: "development" },
    title: "Remove PrometheusRule omnikrux-slow", summary: ["Remove PrometheusRule monitoring/omnikrux-slow."], warnings: [], blocked: [],
    diff: null, confirm_text: null, apply_label: "Remove", expires_at: "2026-11-23T10:05:00Z",
  };
  const removal = (id: string, rule: string): AlertChangeOut => ({ target_id: `t-${id}`, rule_id: id, rule_name: rule, project_id: "p1", project_name: "Dev", kind: "review", message: null });

  /** A Kubernetes project with the given cluster rules; applying a removal takes that rule out of the review. */
  function withClusterRules(rules: { id: string; name: string }[]) {
    let api: ReturnType<typeof installFakeMonitoringApi>;
    let applied = 0;
    const fb = async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/clusters") return json([{ id: "c1", name: "kind-dev", provider: "kind", state: "ready" }]);
      if (method === "POST" && url.endsWith("/apply")) {
        applied += 1;
        api.state.ownerRules.p1 = { cluster_rules: rules.slice(applied) };
        return json({ outcome: "succeeded", message: "Removed.", job_id: null, audit_id: 1 });
      }
      if (method === "DELETE" && url.startsWith("/api/actions/")) return new Response(null, { status: 204 });
      return json([]);
    };
    api = withEverything(fb);
    api.state.projects[0] = { ...api.state.projects[0], kind: "kubernetes", cluster_id: "c1", cluster_name: "kind-dev" };
    api.state.rules = rules.map((r) => ({ ...clusterRule(), id: r.id, name: r.name, targets: [{ ...clusterRule().targets[0], id: `t-${r.id}` }] }));
    api.state.ownerRules.p1 = { cluster_rules: rules };
    api.state.ruleDeleteChanges = rules.map((r) => removal(r.id, r.name));
    api.state.syncAnswers = Object.fromEntries(rules.map((r) => [`t-${r.id}`, { kind: "review", plan: { ...PLAN, plan_id: `plan-${r.id}` } }]));
    return api;
  }

  it("Review removes the project's own rule, opens its removal, and unblocks the delete", async () => {
    const user = userEvent.setup();
    const api = withClusterRules([{ id: "r1", name: "Slow checkout" }]);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(await within(dialog).findByRole("button", { name: "Review Slow checkout" }));
    const review = await screen.findByRole("dialog", { name: /Remove PrometheusRule omnikrux-slow/ });
    await user.click(within(review).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete project" }).getAttribute("aria-disabled")).toBeNull());
    expect(api.requests.some((r) => r.method === "DELETE" && r.url.startsWith("/api/monitoring/alerts/rules/r1"))).toBe(true);
    expect(within(screen.getByRole("alertdialog")).queryByText(/Remove its rules/)).toBeNull();
    // The keyboard is on the action, never on the body.
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete project" })));
  });

  it("when a rule's Review goes, the keyboard moves to the next rule's button", async () => {
    const user = userEvent.setup();
    withClusterRules([{ id: "r1", name: "Slow checkout" }, { id: "r2", name: "Disk full" }]);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(await within(dialog).findByRole("button", { name: "Review Slow checkout" }));
    const review = await screen.findByRole("dialog", { name: /Remove PrometheusRule/ });
    await user.click(within(review).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Review Slow checkout" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Review Disk full" })));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a review that can't be read again says so in the dialog", async () => {
    const user = userEvent.setup();
    withClusterRules([{ id: "r1", name: "Slow checkout" }]);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(await within(dialog).findByRole("button", { name: "Review Slow checkout" }));
    const review = await screen.findByRole("dialog", { name: /Remove PrometheusRule/ });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).includes("/delete-review") && String(url).includes("/projects/") ? Promise.resolve(new Response("{}", { status: 500 })) : real(url, init));
    await user.click(within(review).getByRole("button", { name: "Remove" }));
    const alert = await within(screen.getByRole("alertdialog")).findByText(/Something changed since the review\. Review it again\./);
    expect(alert.getAttribute("role")).toBe("alert");
  });

  it("a group's rule is opened on the Alerts page, not removed from the project", async () => {
    const user = userEvent.setup();
    const api = withClusterRules([{ id: "r1", name: "Slow checkout" }]);
    api.state.rules[0] = { ...api.state.rules[0], scope: { kind: "group", id: "g1", name: "Prod" } };
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("A group's rule can't be removed from a project. Open it to remove it there, or take this project out of the group.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Open rule Slow checkout" }));
    expect(await screen.findByRole("button", { name: "New alert rule" })).toBeTruthy();
    expect(api.requests.some((r) => r.method === "DELETE" && r.url.includes("/rules/"))).toBe(false);
  });

  it("an answer without rule lists reads as none", async () => {
    const user = userEvent.setup();
    withEverything();
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByText(/Alert rules that go with it/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Delete project" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("a link with no filter because the cluster label is unknown warns on the project page", async () => {
    const prom = source("s1", "Prometheus main");
    installFakeMonitoringApi({
      sources: [prom], projects: [project("p1", "Dev", [link(prom)], { kind: "kubernetes", cluster_id: "c1" })],
    }, fallback);
    open("p1");
    expect(await screen.findByText(
      "Prometheus main may include data from other clusters: OmniKrux couldn't tell which label separates them. Add a filter so alerts and charts stay on this project.",
    )).toBeTruthy();
  });

  it("an Alertmanager link carries no cluster warning", async () => {
    const am = source("s1", "Alertmanager main", { type: "alertmanager" });
    installFakeMonitoringApi({
      sources: [am], projects: [project("p1", "Dev", [link(am)], { kind: "kubernetes", cluster_id: "c1" })],
    }, fallback);
    open("p1");
    await screen.findByText("Alertmanager main");
    expect(screen.queryByText(/may include data from other clusters/)).toBeNull();
  });

  it("a link with a filter, or on a project that isn't Kubernetes, carries no such warning", async () => {
    const prom = source("s1", "Prometheus main");
    installFakeMonitoringApi({
      sources: [prom],
      projects: [project("p1", "Dev", [link(prom, 'cluster="a"')], { kind: "kubernetes", cluster_id: "c1" }), project("p2", "Mine", [link(prom)])],
    }, fallback);
    open("p1");
    await screen.findByText("Prometheus main");
    expect(screen.queryByText(/may include data from other clusters/)).toBeNull();
  });

  it("project delete review lists dashboards", async () => {
    const user = userEvent.setup();
    const DEV = { kind: "project" as const, id: "p1", name: "Dev" };
    const api = installFakeMonitoringApi({
      projects: [project("p1", "Dev"), project("p2", "Stage")],
      dashboards: { a1: seedDashboard("a1", DEV, spec("API latency", [])), a2: seedDashboard("a2", DEV, spec("Errors", [])) },
    }, fallback);
    const d2 = api.state.dashboards.a2;
    d2.versions.push({ ...d2.versions[0], out: { ...d2.versions[0].out, version: 2 } });
    d2.out.version = 2;
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    const lines = [...dialog.querySelectorAll("p")].map((p) => p.textContent);
    // First, before what happens to its sources.
    expect(lines[0]).toBe("Dashboards that go with it: API latency (1 version), Errors (2 versions).");
    expect(lines).not.toContain("Only the project itself is removed.");
  });

  it("says plainly when only the project goes", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: [project("p1", "Dev"), project("p2", "Stage")] }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Only the project itself is removed.")).toBeTruthy();
    expect(within(dialog).queryByText(/go with it/)).toBeNull();
  });

  it("deleting a project returns the tab to Home", async () => {
    const user = userEvent.setup();
    const api = withEverything();
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete project" }));
    expect(await screen.findByRole("heading", { name: "Monitoring" })).toBeTruthy();
    expect(api.state.projects.map((p) => p.id)).toEqual(["p2"]);
    expect(api.state.groups).toHaveLength(1);
    expect(api.state.sources.map((x) => x.id).sort()).toEqual(["s2", "s3"]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Ctrl+Enter confirms", async () => {
    const user = userEvent.setup();
    const api = withEverything();
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.state.projects).toHaveLength(1));
  });

  it("keeps the stale words when the review cannot be reloaded", async () => {
    const user = userEvent.setup();
    withEverything();
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (init?.method === "DELETE" && url.includes("/projects/p1")) {
        return new Response(JSON.stringify({ detail: "That changed since you looked. Review it again." }), { status: 409, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/projects/p1/delete-review")) throw new TypeError("down");
      return real(input, init);
    }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert.textContent).toContain("Something changed since the review. Review it again.");
    expect(alert.textContent).toContain("Can't reach the console's server.");
  });

  it("a stale review says so and reloads", async () => {
    const user = userEvent.setup();
    const api = withEverything();
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Delete project…" }));
    const dialog = await screen.findByRole("alertdialog");
    // Something changes under the review: its token no longer matches.
    const real = globalThis.fetch;
    let stale = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (stale && init?.method === "DELETE" && url.includes("/projects/p1")) {
        stale = false;
        return new Response(JSON.stringify({ detail: "That changed since you looked. Review it again." }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return real(input, init);
    }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
    expect(await screen.findByText("Something changed since the review. Review it again.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete project" })));
    expect(api.state.projects).toHaveLength(2);
    // Confirming the reloaded review works.
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(api.state.projects).toHaveLength(1));
  });
});

describe("Check data stays current", () => {
  it("an old count goes away when the filter is edited or saved", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    installFakeMonitoringApi({
      sources: [prom], projects: [project("p1", "Dev", [link(prom)])],
      fields: { s1: { metrics: [{ name: "up", type: null, help: null, unit: null }], labels: ["a"], truncated: false } },
    }, fallback);
    open("p1");
    const check = await screen.findByRole("button", { name: "Check data for Prom" });
    await user.click(check);
    expect(await screen.findByText("1 metric and 1 label visible to this project")).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Filter for Prom" });
    await user.type(field, 'job="a"');
    expect(screen.queryByText("1 metric and 1 label visible to this project")).toBeNull();

    // A count asked for before the save belongs to the old filter: it is never shown under the new one.
    await user.click(check);
    expect(await screen.findByText("1 metric and 1 label visible to this project")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Save filter/ }));
    expect(await screen.findByText("Filter saved.")).toBeTruthy();
    expect(screen.queryByText("1 metric and 1 label visible to this project")).toBeNull();
  });
});

/** Records every Escape that gets past the page to the document, where the shell's keys live. */
function escapesToDocument() {
  const seen: string[] = [];
  const listen = (e: KeyboardEvent) => { if (e.key === "Escape") seen.push(e.key); };
  document.addEventListener("keydown", listen);
  return { seen, stop: () => document.removeEventListener("keydown", listen) };
}

describe("Esc closes the add panels", () => {
  it("Esc closes Use an existing source and returns the keyboard to its button", async () => {
    const user = userEvent.setup();
    const prom = source("s1", "Prom");
    installFakeMonitoringApi({ sources: [prom], projects: [project("p1", "Dev")] }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Use an existing source" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Source")));
    const doc = escapesToDocument();
    await user.keyboard("{Escape}");
    doc.stop();
    expect(screen.queryByLabelText("Source")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use an existing source" })));
    expect(doc.seen).toEqual([]);
  });

  it("Esc closes Add a source by hand and returns the keyboard to its button", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: [project("p1", "Dev")] }, fallback);
    open("p1");
    await user.click(await screen.findByRole("button", { name: "Add a source by hand" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    const doc = escapesToDocument();
    await user.keyboard("{Escape}");
    doc.stop();
    expect(screen.queryByLabelText("Address")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a source by hand" })));
    expect(doc.seen).toEqual([]);
    expect(api.state.sources).toHaveLength(0);
  });
});

describe("An empty filter", () => {
  it("says there is no filter rather than showing an example value", async () => {
    const prom = source("s1", "Prom");
    installFakeMonitoringApi({ sources: [prom], projects: [project("p1", "Dev", [link(prom)])] }, fallback);
    open("p1");
    const field = await screen.findByRole("textbox", { name: "Filter for Prom" });
    expect(field.getAttribute("placeholder")).toBe('No filter · label="value", …');
  });
});
