import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { FiringOut, OverviewOut } from "../alerts/api";
import type { GroupOut, HealthOut, LinkOut, ProjectOut, SourceOut } from "../api/types";
import { healthSummary } from "./MonitoringHome";
import { recordRecent } from "./recent";
import { installFakeMonitoringApi, type FakeMonitoringState } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject } from "../test/renderMonitoringApp";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const cluster = (id: string, name: string, provider: string) => ({ id, name, provider, state: "ready" });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const clustersFallback = (clusters: unknown[]) => async (url: string) => json(url === "/api/clusters" ? clusters : []);

function source(id: string, name: string): SourceOut {
  return {
    id, name, type: "prometheus", reach: "url", url: "http://x", cluster_id: null, cluster_name: null, namespace: null, service: null,
    port: null, scheme: "http", path_prefix: "",
    auth: { type: "none", username: null, header_name: null, has_password: false, has_token: false, has_api_key: false, has_client_key: false, has_client_cert: false },
    headers: [], has_ca: false, created_by_project_id: null, used_by: [], health: { state: "unknown", message: null, version: null, checked_at: null },
    created_at: T, updated_at: T,
  };
}
const link = (s: SourceOut): LinkOut => ({ source_id: s.id, source_name: s.name, source_type: s.type, filter: "", filter_origin: "none", created_by_project: false });
const withLinks = (p: ProjectOut, ...s: SourceOut[]): ProjectOut => ({ ...p, links: s.map(link) });
const group = (id: string, name: string, ids: string[]): GroupOut => ({ id, name, project_ids: ids, created_at: T, updated_at: T });
const health = (state: HealthOut["state"], minutesAgo = 0, message: string | null = null): HealthOut =>
  ({ state, message, version: null, checked_at: new Date(Date.now() - minutesAgo * 60_000 - 1000).toISOString() });

function seedHealthy(extra: Partial<FakeMonitoringState> = {}, clusters: unknown[] = [cluster("c1", "kind-omnikrux-dev", "kind")]) {
  const prom = source("s1", "Prometheus · kind");
  const loki = source("s2", "Loki · kind");
  return installFakeMonitoringApi({
    sources: [prom, loki],
    projects: [withLinks(seedProject("p1", "Dev cluster", "kubernetes", { id: "c1", provider: "kind" }), prom, loki)],
    groups: [group("g1", "Everything", ["p1"])],
    health: { s1: health("up"), s2: health("down", 0, "connection refused") },
    ...extra,
  }, clustersFallback(clusters));
}


const firingRow = (over: Partial<FiringOut> = {}): FiringOut => ({
  rule_id: "r1", rule_name: "PodCrashLooping", target_id: "t1", project_id: "p1", project_name: "Dev cluster", severity: "critical",
  since: T, instances: 2, summary: "2 pods are restarting", where: "checked by OmniKrux", ...over,
});
const overviewOf = (over: Partial<OverviewOut> = {}, counts: Partial<OverviewOut["counts"]> = {}): OverviewOut => ({
  counts: { rules: 3, firing: 0, pending: 0, cant_check: 0, not_applied: 0, ...counts }, firing: [], by_project: {}, by_group: {},
  engine: { enabled: true, running: true, last_tick_at: T, rules: 3, behind: 0, note: "" }, ...over,
});

const selectedTab = () => screen.getByRole("tab", { selected: true });

describe("Monitoring Home", () => {
  it("first use offers known clusters as one-click starts", async () => {
    installFakeMonitoringApi({}, clustersFallback([cluster("c1", "kind-omnikrux-dev", "kind"), cluster("c2", "prod-east", "aks")]));
    renderMonitoringApp();
    expect(await screen.findByRole("heading", { name: "Set up your first project" })).toBeTruthy();
    expect(screen.getByText("A project gathers the sources for one thing you run, like a cluster, and shows only its own data.")).toBeTruthy();
    expect(screen.getAllByText("Kubernetes cluster")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /prod-east/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Something else…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /kind-omnikrux-dev/ }));
    await waitFor(() => expect(selectedTab().textContent).toContain("New project"));
    expect(screen.queryByRole("heading", { name: "Set up your first project" })).toBeNull();
  });

  it("first use without clusters points to Settings", async () => {
    installFakeMonitoringApi({}, clustersFallback([]));
    const onOpenSettings = vi.fn();
    renderMonitoringApp({ onOpenSettings });
    expect(await screen.findByText("No Kubernetes clusters are connected yet. Add one in Settings, or set up a project for anything else.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Set up a project" }));
    await waitFor(() => expect(selectedTab().textContent).toContain("New project"));
  });

  it("cards show source health in words", async () => {
    seedHealthy();
    renderMonitoringApp();
    const card = await screen.findByRole("button", { name: /Dev cluster/ });
    expect(within(card).getByText("Kubernetes · kind-omnikrux-dev")).toBeTruthy();
    expect(within(card).getByText("Prometheus · kind · Up")).toBeTruthy();
    const down = within(card).getByText("Loki · kind · Can't be reached");
    expect(down.getAttribute("title")).toBe("connection refused");
    expect(screen.getByText("1 project")).toBeTruthy();
    expect(screen.getByText("1 of 2 sources can't be reached")).toBeTruthy();
    expect(within(card).queryByText(/checked/)).toBeNull();
  });

  it("old health is labelled with its age", async () => {
    seedHealthy({ health: { s1: health("up", 5), s2: health("unknown") } });
    renderMonitoringApp();
    const card = await screen.findByRole("button", { name: /Dev cluster/ });
    expect(within(card).getByText("checked 5 min ago")).toBeTruthy();
    expect(within(card).getByText("Loki · kind · Not checked yet")).toBeTruthy();
  });

  it("names a project whose cluster is gone", async () => {
    seedHealthy({}, [cluster("c9", "other", "aks")]);
    renderMonitoringApp();
    expect(await screen.findByText("Cluster no longer connected")).toBeTruthy();
  });

  it("search opens a project", async () => {
    seedHealthy();
    renderMonitoringApp();
    const search = (await screen.findByRole("combobox", { name: "Search Monitoring" })) as HTMLInputElement;
    expect(search.getAttribute("placeholder")).toBe("Search projects, groups and sources");
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: "dev" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(selectedTab().textContent).toContain("Dev cluster"));
  });

  it("All quiet line is shown", async () => {
    seedHealthy();
    renderMonitoringApp();
    expect(await screen.findByText("All quiet · no alert rules yet")).toBeTruthy();
  });

  it("Home shows firing alerts first and opens them", async () => {
    seedHealthy({ overview: overviewOf({ firing: [firingRow(), firingRow({ rule_id: "r2", target_id: "t2", rule_name: "DiskFull", severity: "warning" })] }, { firing: 2 }) });
    renderMonitoringApp();
    const section = await screen.findByRole("region", { name: "Firing" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.severity).toBe("critical");
    expect(rows[1].dataset.severity).toBe("warning");
    expect(within(rows[0]).getByText("PodCrashLooping")).toBeTruthy();
    expect(within(rows[0]).getByText("Dev cluster")).toBeTruthy();
    expect(within(rows[0]).getByText("2 pods are restarting")).toBeTruthy();
    expect(within(rows[0]).getByText("checked by OmniKrux")).toBeTruthy();
    expect(screen.queryByText(/All quiet/)).toBeNull();
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Open DiskFull" }));
    expect(await screen.findByRole("button", { name: "New alert rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alerts, 2 firing" })).toBeTruthy();
  });

  it("Silence on a firing row opens the Silences view", async () => {
    seedHealthy({ overview: overviewOf({ firing: [firingRow()] }, { firing: 1 }) });
    renderMonitoringApp();
    fireEvent.click(await screen.findByRole("button", { name: "Silence PodCrashLooping" }));
    expect(await screen.findByRole("tab", { name: /Silences/, selected: true })).toBeTruthy();
  });

  it("All quiet counts rules", async () => {
    const api = seedHealthy({ overview: overviewOf({}, { rules: 3 }) });
    const view = renderMonitoringApp();
    expect(await screen.findByText("All quiet · 3 rules, none firing")).toBeTruthy();
    view.unmount();
    api.state.overview = overviewOf({}, { rules: 1 });
    renderMonitoringApp();
    expect(await screen.findByText("All quiet · 1 rule, not firing")).toBeTruthy();
  });

  it("cant-check line appears and opens Alerts", async () => {
    seedHealthy({ overview: overviewOf({}, { cant_check: 2 }) });
    renderMonitoringApp();
    fireEvent.click(await screen.findByRole("button", { name: "2 rules can't be checked right now." }));
    expect(await screen.findByRole("button", { name: "New alert rule" })).toBeTruthy();
  });

  it("one rule that can't be checked reads in the singular", async () => {
    seedHealthy({ overview: overviewOf({}, { cant_check: 1 }) });
    renderMonitoringApp();
    expect(await screen.findByRole("button", { name: "1 rule can't be checked right now." })).toBeTruthy();
  });

  it("says when the alert checks are behind", async () => {
    seedHealthy({ overview: overviewOf({ engine: { enabled: true, running: true, last_tick_at: T, rules: 3, behind: 2, note: "OmniKrux is 2 checks behind." } }) });
    renderMonitoringApp();
    expect(await screen.findByText("OmniKrux is 2 checks behind.")).toBeTruthy();
  });

  it("cards show firing counts", async () => {
    seedHealthy({ overview: overviewOf({ firing: [firingRow()], by_project: { p1: 2 }, by_group: { g1: 3 } }, { firing: 2 }) });
    renderMonitoringApp();
    const card = await screen.findByRole("button", { name: /Dev cluster/ });
    expect(await within(card).findByText("2 firing")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Everything/ })).getByText("3 firing")).toBeTruthy();
  });

  it("no counts and no quiet line when the overview can't be read", async () => {
    seedHealthy({ overview: overviewOf({ by_project: { p1: 2 } }, { firing: 2 }) });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).includes("/alerts/overview") ? Promise.resolve(new Response("{}", { status: 500 })) : real(url, init));
    renderMonitoringApp();
    expect(await screen.findByText(/Alerts couldn't be read, so what is firing isn't shown\./)).toBeTruthy();
    expect(screen.queryByText(/All quiet/)).toBeNull();
    expect(screen.queryByText("2 firing")).toBeNull();
  });

  it("a link with no cluster filter warns that it may include other clusters", async () => {
    seedHealthy();
    renderMonitoringApp();
    const card = await screen.findByRole("button", { name: /Dev cluster/ });
    expect(within(card).getAllByText(
      /may include data from other clusters: OmniKrux couldn't tell which label separates them\. Add a filter so alerts and charts stay on this project\.$/,
    ).length).toBeGreaterThan(0);
  });

  it("recently opened lists existing items only", async () => {
    seedHealthy();
    recordRecent({ kind: "project", id: "gone" }, 1);
    recordRecent({ kind: "group", id: "g1" }, 2);
    recordRecent({ kind: "project", id: "p1" }, 3);
    renderMonitoringApp();
    const section = await screen.findByRole("region", { name: "Recently opened" });
    const items = within(section).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual([expect.stringContaining("Dev cluster"), expect.stringContaining("Everything")]);
    fireEvent.click(items[1]);
    await waitFor(() => expect(selectedTab().textContent).toContain("Everything"));
  });

  it("has no Recently opened section when nothing was opened", async () => {
    seedHealthy();
    renderMonitoringApp();
    await screen.findByRole("button", { name: /Dev cluster/ });
    expect(screen.queryByText("Recently opened")).toBeNull();
  });

  it("a failed load shows the words and Try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "The database is busy." }), { status: 500, headers: { "content-type": "application/json" } })));
    renderMonitoringApp();
    expect((await screen.findAllByText("The database is busy.")).length).toBeGreaterThan(0);
    const page = document.querySelector<HTMLElement>("[data-monitoring-page]")!;
    expect(within(page).getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("healthSummary", () => {
  it("counts up, down and unknown", () => {
    const sources = [source("a", "A"), source("b", "B"), source("c", "C")];
    expect(healthSummary(sources, { a: health("up"), b: health("down") })).toEqual({ up: 1, down: 1, unknown: 1 });
  });
});

describe("Home focus on leaving", () => {
  const onMain = () => document.activeElement?.tagName === "MAIN";

  it("a card hands the keyboard to the workspace", async () => {
    seedHealthy();
    renderMonitoringApp();
    const card = await screen.findByRole("button", { name: /Dev cluster/ });
    card.focus();
    fireEvent.click(card);
    await waitFor(() => expect(selectedTab().textContent).toContain("Dev cluster"));
    expect(onMain()).toBe(true);
  });

  it("Enter in the search hands the keyboard to the workspace", async () => {
    seedHealthy();
    renderMonitoringApp();
    const search = (await screen.findByRole("combobox", { name: "Search Monitoring" })) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: "every" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(selectedTab().textContent).toContain("Everything"));
    expect(onMain()).toBe(true);
  });
});

describe("Home errors in plain words", () => {
  const DOWN = "Can't reach the console's server. Check that it's running, then try again.";

  it("an unreachable server says so on Home, not the browser's words", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderMonitoringApp();
    const page = document.querySelector<HTMLElement>("[data-monitoring-page]")!;
    expect(await within(page).findByText(DOWN)).toBeTruthy();
    expect(page.textContent).not.toContain("Failed to fetch");
  });

  it("first use says so when the clusters can't be read", async () => {
    installFakeMonitoringApi({}, async (url: string) => {
      if (url === "/api/clusters") throw new TypeError("Failed to fetch");
      return json([]);
    });
    renderMonitoringApp();
    expect(await screen.findByRole("heading", { name: "Set up your first project" })).toBeTruthy();
    expect(await screen.findByText(DOWN)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });
});
