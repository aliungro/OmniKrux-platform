import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
