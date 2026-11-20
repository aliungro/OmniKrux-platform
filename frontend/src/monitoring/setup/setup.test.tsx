import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiscoveryOut, FoundTool, SourceOut, SuggestOut } from "../api/types";
import { readRecent } from "../home/recent";
import { BAD_FILTER } from "../projects/FilterField";
import { installFakeMonitoringApi, type FakeMonitoringState } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import { picksFromDiscovery, setupBody, type SetupDraft } from "./setupModel";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const TOKEN = "s3cret-setup-token-value";
const CLUSTER = "kind-omnikrux-dev";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const clusters = [{ id: "c1", name: CLUSTER, provider: "kind", state: "ready" }];
const clustersFallback = async (url: string) => json(url === "/api/clusters" ? clusters : []);

function tool(type: FoundTool["type"], state: FoundTool["state"], over: Partial<FoundTool> = {}): FoundTool {
  const missing = state === "missing";
  return {
    type, state, namespace: missing ? null : "monitoring", service: missing ? null : `${type}-server`, port: missing ? null : "9090",
    scheme: "http", version: state === "reachable" ? "3.1.0" : null, message: state === "unreachable" ? "connection refused" : null,
    existing_source_id: null, detail: null, ...over,
  };
}
const found = (...tools: FoundTool[]): DiscoveryOut =>
  ({ cluster_id: "c1", cluster_name: CLUSTER, state: "ok", message: null, found: tools, checked_at: T });

function source(id: string, name: string): SourceOut {
  return {
    id, name, type: "prometheus", reach: "url", url: "http://central:9090", cluster_id: null, cluster_name: null, namespace: null,
    service: null, port: null, scheme: "http", path_prefix: "",
    auth: { type: "none", username: null, header_name: null, has_password: false, has_token: false, has_api_key: false, has_client_key: false, has_client_cert: false },
    headers: [], has_ca: false, created_by_project_id: null, used_by: [], health: { state: "unknown", message: null, version: null, checked_at: null },
    created_at: T, updated_at: T,
  };
}

const KEEPS: SuggestOut = { filter: 'cluster="kind"', origin: "auto", reason: "This source holds several clusters; the filter keeps kind." };
const PROM_AND_LOKI = found(tool("prometheus", "reachable"), tool("loki", "unreachable"));

function install(extra: Partial<FakeMonitoringState> = {}) {
  return installFakeMonitoringApi({ discovery: { c1: PROM_AND_LOKI }, ...extra }, clustersFallback);
}
const startFromCluster = () => renderMonitoringApp({ tabs: tabsWith({ page: "setup", clusterId: "c1" }) });
const continueButton = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
const selectedTab = () => screen.getByRole("tab", { selected: true });
const setupPosts = (api: ReturnType<typeof install>) => api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/setup");

describe("Setup page", () => {
  it("a cluster start opens on step 2 with what was found", async () => {
    install();
    startFromCluster();
    expect(await screen.findByRole("heading", { name: `What we found in ${CLUSTER}` })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "New project" })).toBeTruthy();
    expect(screen.getByText("OmniKrux looked inside the cluster. Use what's there, or add a source by hand.")).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Steps" });
    const current = within(steps).getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Sources");
    expect(within(steps).getByText("Comes later")).toBeTruthy();

    const prom = await screen.findByRole("group", { name: "Prometheus" });
    expect(within(prom).getByText("monitoring/prometheus-server · v3.1.0")).toBeTruthy();
    expect(within(prom).getByText("Reachable")).toBeTruthy();
    expect((within(prom).getByRole("checkbox", { name: "Use" }) as HTMLInputElement).checked).toBe(true);
    const loki = screen.getByRole("group", { name: "Loki" });
    expect(within(loki).getByText("Can't be reached")).toBeTruthy();
    expect(within(loki).getByText("connection refused")).toBeTruthy();
    expect((within(loki).getByRole("checkbox", { name: "Use" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("1 source in use")).toBeTruthy();
    expect(continueButton().disabled).toBe(false);

    fireEvent.click(within(prom).getByRole("checkbox", { name: "Use" }));
    expect(screen.getByText("0 sources in use")).toBeTruthy();
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText("Pick at least one source, or add one by hand.")).toBeTruthy();
  });

  it("filters are suggested and editable", async () => {
    const user = userEvent.setup();
    install({ suggestion: KEEPS });
    startFromCluster();
    const field = await screen.findByRole("textbox", { name: "Filter for Prometheus" }) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('cluster="kind"'));
    expect(within(screen.getByRole("group", { name: "Prometheus" })).getByText(KEEPS.reason as string)).toBeTruthy();
    expect(screen.queryByText(BAD_FILTER)).toBeNull();

    await user.clear(field);
    await user.type(field, "cluster=kind");
    expect(screen.getByText(BAD_FILTER)).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(continueButton().disabled).toBe(true);

    await user.clear(field);
    await user.type(field, 'cluster="other"');
    expect(screen.queryByText(BAD_FILTER)).toBeNull();
    expect(continueButton().disabled).toBe(false);
  });

  it("missing tools say install comes later", async () => {
    install({
      sources: [source("s9", "Loki · central")],
      discovery: { c1: found(tool("prometheus", "reachable", { existing_source_id: "s9" }), tool("grafana", "reachable"), tool("loki", "missing")) },
    });
    startFromCluster();
    const loki = await screen.findByRole("group", { name: "Loki" });
    expect(within(loki).getByText("Missing")).toBeTruthy();
    expect(within(loki).getByText("Not found in this cluster")).toBeTruthy();
    expect(within(loki).getByText("Installing it from here comes in a later update.")).toBeTruthy();
    expect(within(loki).queryByRole("checkbox")).toBeNull();
    const grafana = screen.getByRole("group", { name: "Grafana" });
    expect(within(grafana).getByText("Found")).toBeTruthy();
    expect(within(grafana).getByText("Importing its dashboards comes in a later update.")).toBeTruthy();
    expect(within(grafana).queryByRole("checkbox")).toBeNull();
    const prom = screen.getByRole("group", { name: "Prometheus" });
    expect(await within(prom).findByText("Already a source: Loki · central")).toBeTruthy();
  });

  it("adding by hand adds a row without saving a source", async () => {
    const user = userEvent.setup();
    const api = install({ discovery: { c1: found(tool("loki", "missing")) } });
    startFromCluster();
    await user.click(await screen.findByRole("button", { name: "+ Add a source by hand" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
    await user.type(screen.getByLabelText("Token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Use this source" }));

    const row = await screen.findByRole("group", { name: "Prometheus · prom.example" });
    expect(within(row).getByText("http://prom.example:9090")).toBeTruthy();
    expect(screen.queryByLabelText("Address")).toBeNull();
    expect(screen.getByText("1 source in use")).toBeTruthy();
    expect(api.requests.some((r) => r.method === "POST" && r.url === "/api/monitoring/sources")).toBe(false);
    expect(api.state.sources).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain(TOKEN);

    await user.click(within(row).getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("group", { name: "Prometheus · prom.example" })).toBeNull();
    expect(screen.getByText("0 sources in use")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("+ Add a source by hand");
  });

  it("create sends one setup request and opens the project", async () => {
    const user = userEvent.setup();
    const api = install({ suggestion: KEEPS });
    const { client } = startFromCluster();
    const field = await screen.findByRole("textbox", { name: "Filter for Prometheus" }) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('cluster="kind"'));
    await user.click(screen.getByRole("button", { name: "+ Add a source by hand" }));
    await user.type(screen.getByLabelText("Address"), "http://loki.example:3100");
    await user.selectOptions(screen.getByLabelText("Type"), "loki");
    await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
    await user.type(screen.getByLabelText("Token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Use this source" }));
    const hand = await screen.findByRole("textbox", { name: "Filter for Loki · loki.example" }) as HTMLInputElement;
    await waitFor(() => expect(hand.value).toBe('cluster="kind"'));
    await user.clear(hand);

    await user.click(continueButton());
    expect(await screen.findByRole("heading", { name: "Name and review" })).toBeTruthy();
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe(CLUSTER);
    expect(screen.getByText(`What: Kubernetes cluster · ${CLUSTER}`)).toBeTruthy();
    expect(screen.getByText("Prometheus · new")).toBeTruthy();
    expect(screen.getByText('Filter: cluster="kind"')).toBeTruthy();
    expect(screen.getByText("Loki · loki.example · new")).toBeTruthy();
    expect(screen.getByText("Filter: none")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TOKEN);

    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(selectedTab().textContent).toContain(CLUSTER));
    const posts = setupPosts(api);
    expect(posts).toHaveLength(1);
    const [prom] = picksFromDiscovery(PROM_AND_LOKI, []);
    const draft: SetupDraft = {
      step: 4, kind: "kubernetes", clusterId: "c1", name: CLUSTER,
      picks: [
        { ...prom, filter: KEEPS.filter, origin: "auto", reason: KEEPS.reason },
        {
          key: "hand", label: "Loki · loki.example", detail: "http://loki.example:3100", use: true, filter: "", origin: "user", reason: null,
          source: { new: { type: "loki", reach: "url", url: "http://loki.example:3100", auth: { type: "bearer", token: TOKEN }, headers: [] } },
        },
      ],
    };
    expect(posts[0].body).toEqual(setupBody(draft));
    expect(api.requests.some((r) => r.method === "POST" && r.url === "/api/monitoring/sources")).toBe(false);
    expect(readRecent().map((r) => [r.kind, r.id])).toEqual([["project", api.state.projects[0].id]]);
    expect(screen.queryByRole("heading", { name: "Name and review" })).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state))).not.toContain(TOKEN);
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state))).not.toContain(TOKEN);
  });

  it("name clash keeps the draft and focuses Name", async () => {
    const user = userEvent.setup();
    const api = install({ projects: [seedProject("p0", CLUSTER)] });
    startFromCluster();
    await screen.findByRole("group", { name: "Prometheus" });
    await user.click(continueButton());
    const name = await screen.findByRole("textbox", { name: "Name" }) as HTMLInputElement;
    name.focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText(`A project named "${CLUSTER}" already exists. Pick another name.`)).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Prometheus · new")).toBeTruthy();
    expect(setupPosts(api)).toHaveLength(1);

    await user.clear(name);
    await user.type(name, "Dev cluster");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(selectedTab().textContent).toContain("Dev cluster"));
    expect(setupPosts(api)).toHaveLength(2);
  });

  it("focus moves to each step heading", async () => {
    const user = userEvent.setup();
    install({ sources: [source("s1", "Central Prometheus")] });
    renderMonitoringApp({ tabs: tabsWith({ page: "setup" }) });
    const first = await screen.findByRole("heading", { name: "What to monitor" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(continueButton().disabled).toBe(true);

    await user.click(screen.getByRole("radio", { name: /A Kubernetes cluster/ }));
    await user.click(await screen.findByRole("radio", { name: new RegExp(CLUSTER) }));
    await user.click(continueButton());
    const found = await screen.findByRole("heading", { name: `What we found in ${CLUSTER}` });
    expect(document.activeElement).toBe(found);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "What to monitor" }));

    await user.click(screen.getByRole("radio", { name: /A Docker host/ }));
    expect(screen.getByText("OmniKrux connects to tools that already run there. Generating files to install them comes in a later update.")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Something of your own/ }));
    await user.click(continueButton());
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Sources" }));
    expect(screen.getByText("Add the tools this project reads from.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Prometheus" })).toBeNull();
    const existing = screen.getByRole("group", { name: "Use an existing source" });
    await user.click(within(existing).getByRole("checkbox", { name: /Central Prometheus/ }));
    await user.click(continueButton());
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Name and review" }));
    expect(screen.getByText("What: Something of your own")).toBeTruthy();
    expect(screen.getByText("Central Prometheus · existing")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
