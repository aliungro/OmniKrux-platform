import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiscoveryOut, FoundTool, SourceOut, SuggestOut } from "../api/types";
import { readRecent } from "../home/recent";
import { BAD_FILTER } from "../projects/FilterField";
import { FAKE_TOOLS_MISSING, installFakeMonitoringApi, type FakeMonitoringSeed } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import type { Plan } from "../../api/types";
import type { InstallPlanOut } from "../install/api";
import { SETTINGS, status, TOOLS } from "../install/toolsFixtures";
import { SECRET_NOT_KEPT, SETUP_DRAFT_PREFIX } from "./setupDraftStore";
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

const GENERATES = "OmniKrux connects to tools that already run there, or writes the files to install them for you to run.";
const METRICS_LINE = "Installs Prometheus, Alertmanager, node-exporter and kube-state-metrics with Helm after you create the project. You review it first.";
const LOGS_LINE = "Installs Loki and Grafana Alloy (collects Pod logs) with Helm after you create the project. You review it first.";
const installPlan = (over: Partial<Plan> = {}): InstallPlanOut => ({
  plan: {
    plan_id: "plan-1", action: "install",
    target: { cluster_id: "c1", kind_key: "omnikrux.monitoring/install", namespace: null, name: "monitoring" },
    kind: "Monitoring tools", cluster: { id: "c1", name: CLUSTER, provider: "kind", environment: "development" },
    title: "Install monitoring tools in monitoring", summary: ["Installs logs into the cluster, namespace monitoring."],
    warnings: [], blocked: [], diff: null, confirm_text: null, apply_label: "Install", expires_at: "2026-11-24T10:05:00Z", ...over,
  },
  settings: SETTINGS, problems: [], facts: { default_storage_class: "standard", kube_version: "1.31.0" },
});

function install(extra: FakeMonitoringSeed = {}) {
  return installFakeMonitoringApi({ discovery: { c1: PROM_AND_LOKI }, ...extra }, clustersFallback);
}
const startFromCluster = () => renderMonitoringApp({ tabs: tabsWith({ page: "setup", clusterId: "c1" }) });
const continueButton = () => screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
const selectedTab = () => screen.getByRole("tab", { selected: true });
const setupPosts = (api: ReturnType<typeof install>) => api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/setup");

const PROD = "prod-east";
const twoClusters = [...clusters, { id: "c2", name: PROD, provider: "aks", state: "ready" }];
function installTwo(extra: FakeMonitoringSeed = {}) {
  return installFakeMonitoringApi({
    discovery: { c1: PROM_AND_LOKI, c2: { ...found(tool("prometheus", "reachable")), cluster_id: "c2", cluster_name: PROD } },
    suggestion: KEEPS, ...extra,
  }, async (url: string) => json(url === "/api/clusters" ? twoClusters : []));
}
const pickCluster = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole("radio", { name: /A Kubernetes cluster/ }));
  await user.click(await screen.findByRole("radio", { name: new RegExp(name) }));
};

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
    expect(within(steps).getByText("Nothing to import")).toBeTruthy();

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

  // M5 (F18): replaces M1's "missing tools say install comes later"; its Grafana line (M6's) stays.
  it("missing rows offer install and the footer counts it", async () => {
    const user = userEvent.setup();
    install({
      sources: [source("s9", "Loki · central")],
      discovery: { c1: found(tool("prometheus", "reachable", { existing_source_id: "s9" }), tool("grafana", "reachable"), tool("loki", "missing")) },
      install: { tools: TOOLS },
    });
    startFromCluster();
    const loki = await screen.findByRole("group", { name: "Loki" });
    expect(within(loki).getByText("Missing")).toBeTruthy();
    expect(within(loki).getByText("Not found in this cluster")).toBeTruthy();
    expect(within(loki).queryByRole("checkbox")).toBeNull();
    const toggle = await within(loki).findByRole("button", { name: "Install Loki…" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("OmniKrux looked inside the cluster. Use what's there, install what's missing, or add a source by hand.")).toBeTruthy();
    expect(screen.getByText("1 source in use")).toBeTruthy();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(loki).getByText("To install")).toBeTruthy();
    expect(within(loki).queryByText("Missing")).toBeNull();
    expect(within(loki).getByText(LOGS_LINE)).toBeTruthy();
    expect(screen.getByText("1 source in use · 1 to install")).toBeTruthy();
    expect(document.activeElement).toBe(toggle);

    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(within(loki).queryByText(LOGS_LINE)).toBeNull();
    expect(screen.getByText("1 source in use")).toBeTruthy();

    const grafana = screen.getByRole("group", { name: "Grafana" });
    expect(within(grafana).getByText("Found")).toBeTruthy();
    expect(within(grafana).getByText("You can copy its dashboards in the next step.")).toBeTruthy();
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

  it("setup says a Loki source comes with Logs overview", async () => {
    install({ discovery: { c1: found(tool("prometheus", "reachable"), tool("loki", "reachable")) } });
    startFromCluster();
    const loki = await screen.findByRole("group", { name: "Loki" });
    expect(within(loki).getByText("Comes with the ready-made view Logs overview.")).toBeTruthy();
    const prom = screen.getByRole("group", { name: "Prometheus" });
    expect(within(prom).getByText("Comes with the ready-made views Cluster health, Node health, Namespace health, Workload health, Pod health.")).toBeTruthy();
    // A source that isn't used brings nothing.
    fireEvent.click(within(loki).getByRole("checkbox", { name: "Use" }));
    expect(within(loki).queryByText(/Comes with/)).toBeNull();
  });

  it("the review lists the ready-made views", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: found(tool("prometheus", "reachable"), tool("loki", "reachable")) } });
    startFromCluster();
    await screen.findByRole("group", { name: "Loki" });
    await user.click(continueButton());
    await screen.findByRole("heading", { name: "Name and review" });
    const summary = screen.getByRole("list", { name: "Summary" });
    expect(within(summary).getByText("Ready-made views: Cluster health, Node health, Namespace health, Workload health, Pod health, Logs overview")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Prometheus" })).getByRole("checkbox", { name: "Use" }));
    await user.click(continueButton());
    expect(within(screen.getByRole("list", { name: "Summary" })).getByText("Ready-made views: Logs overview")).toBeTruthy();
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
    // M5 (F18): the Docker host line now says OmniKrux writes the files to install the tools.
    expect(screen.getByText(GENERATES)).toBeTruthy();
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

  it("suggestions are asked again after going back to the same cluster", async () => {
    const user = userEvent.setup();
    installTwo();
    renderMonitoringApp({ tabs: tabsWith({ page: "setup" }) });
    await screen.findByRole("heading", { name: "What to monitor" });
    await pickCluster(user, CLUSTER);
    await user.click(continueButton());
    const first = await screen.findByRole("textbox", { name: "Filter for Prometheus" }) as HTMLInputElement;
    await waitFor(() => expect(first.value).toBe('cluster="kind"'));
    await user.click(screen.getByRole("button", { name: "+ Add a source by hand" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.click(screen.getByRole("button", { name: "Use this source" }));
    const hand = await screen.findByRole("textbox", { name: "Filter for Prometheus · prom.example" }) as HTMLInputElement;
    await waitFor(() => expect(hand.value).toBe('cluster="kind"'));

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("radio", { name: new RegExp(PROD) }));
    await user.click(screen.getByRole("radio", { name: new RegExp(CLUSTER) }));
    await user.click(continueButton());
    await screen.findByRole("heading", { name: `What we found in ${CLUSTER}` });
    const again = await screen.findByRole("textbox", { name: "Filter for Prometheus" }) as HTMLInputElement;
    await waitFor(() => expect(again.value).toBe('cluster="kind"'));
    const handAgain = screen.getByRole("textbox", { name: "Filter for Prometheus · prom.example" }) as HTMLInputElement;
    await waitFor(() => expect(handAgain.value).toBe('cluster="kind"'));
    expect(within(screen.getByRole("group", { name: "Prometheus" })).getByText(KEEPS.reason as string)).toBeTruthy();
  });

  it("the default name follows the cluster until a name is typed", async () => {
    const user = userEvent.setup();
    installTwo({ sources: [source("s1", "Central Prometheus")] });
    renderMonitoringApp({ tabs: tabsWith({ page: "setup" }) });
    await screen.findByRole("heading", { name: "What to monitor" });
    const toReview = async () => {
      await user.click(continueButton());
      await waitFor(() => expect(continueButton().disabled).toBe(false));
      await user.click(continueButton());
      return await screen.findByRole("textbox", { name: "Name" }) as HTMLInputElement;
    };
    const backToStart = async () => {
      await user.click(screen.getByRole("button", { name: "Back" }));
      await user.click(screen.getByRole("button", { name: "Back" }));
    };
    await pickCluster(user, CLUSTER);
    expect((await toReview()).value).toBe(CLUSTER);
    await backToStart();
    await user.click(screen.getByRole("radio", { name: new RegExp(PROD) }));
    expect((await toReview()).value).toBe(PROD);
    await backToStart();
    await user.click(screen.getByRole("radio", { name: /Something of your own/ }));
    await user.click(continueButton());
    await user.click(within(screen.getByRole("group", { name: "Use an existing source" })).getByRole("checkbox", { name: /Central Prometheus/ }));
    await user.click(continueButton());
    const empty = await screen.findByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(empty.value).toBe("");
    await user.type(empty, "Shop");
    await backToStart();
    await pickCluster(user, CLUSTER);
    expect((await toReview()).value).toBe("Shop");
  });

  it("removing a row while the form is open keeps the keyboard on the page", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: found(tool("loki", "missing")) } });
    startFromCluster();
    await user.click(await screen.findByRole("button", { name: "+ Add a source by hand" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.click(screen.getByRole("button", { name: "Use this source" }));
    const row = await screen.findByRole("group", { name: "Prometheus · prom.example" });
    await user.click(screen.getByRole("button", { name: "+ Add a source by hand" }));
    expect(screen.getByLabelText("Address")).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("group", { name: "Prometheus · prom.example" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: `What we found in ${CLUSTER}` }));
  });

  it("look again says it is looking and keeps the keyboard on its button", async () => {
    const user = userEvent.setup();
    const api = install();
    startFromCluster();
    expect(within(await screen.findByRole("group", { name: "Prometheus" })).getByText("Reachable")).toBeTruthy();
    // The second look finds Prometheus down, and is held until released.
    api.state.discovery.c1 = found(tool("prometheus", "unreachable"), tool("loki", "unreachable"));
    const inner = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/monitoring/discovery/")) await held;
      return inner(input, init);
    }));
    const button = screen.getByRole("button", { name: "Look again" });
    await user.click(button);
    expect(await screen.findByText(`Looking inside ${CLUSTER}…`)).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    release();
    const prom = screen.getByRole("group", { name: "Prometheus" });
    expect(await within(prom).findByText("Can't be reached")).toBeTruthy();
    expect(screen.queryByText(`Looking inside ${CLUSTER}…`)).toBeNull();
    expect(screen.getByRole("group", { name: "Prometheus" })).toBe(prom);
    expect(document.activeElement).toBe(button);
    expect(api.requests.filter((r) => r.url === "/api/monitoring/discovery/c1")).toHaveLength(2);
  });
});

describe("Setup focus on arrival", () => {
  it("creating a project puts the keyboard on its heading", async () => {
    const user = userEvent.setup();
    install();
    startFromCluster();
    await screen.findByRole("group", { name: "Prometheus" });
    await user.click(continueButton());
    await screen.findByRole("heading", { name: "Name and review" });
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(selectedTab().textContent).toContain(CLUSTER));
    const heading = await screen.findByRole("heading", { level: 1, name: CLUSTER });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("+ New project puts the keyboard on setup's step heading", async () => {
    installFakeMonitoringApi({}, clustersFallback);
    renderMonitoringApp();
    const plus = await screen.findByRole("button", { name: "New project" });
    plus.focus();
    fireEvent.click(plus);
    const heading = await screen.findByRole("heading", { name: "What to monitor" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("Setup installs what's missing", () => {
  const LOKI_MISSING = found(tool("loki", "missing"));
  const BOTH_MISSING = found(tool("prometheus", "missing"), tool("loki", "missing"));
  const PROM_AND_LOKI_MISSING = found(tool("prometheus", "reachable"), tool("loki", "missing"));
  const installPosts = (api: ReturnType<typeof install>) => api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/install/plan");

  it("install alone lets you continue", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: LOKI_MISSING }, install: { tools: TOOLS } });
    startFromCluster();
    const toggle = await screen.findByRole("button", { name: "Install Loki…" });
    expect(screen.getByText("0 sources in use")).toBeTruthy();
    expect(continueButton().disabled).toBe(true);
    expect(screen.getByText("Pick at least one source, install one, or add one by hand.")).toBeTruthy();

    await user.click(toggle);
    expect(screen.getByText("0 sources in use · 1 to install")).toBeTruthy();
    expect(continueButton().disabled).toBe(false);
    expect(screen.queryByText("Pick at least one source, install one, or add one by hand.")).toBeNull();
  });

  it("step 4 lists the install and renames the button", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: BOTH_MISSING }, install: { tools: TOOLS } });
    startFromCluster();
    await user.click(await screen.findByRole("button", { name: "Install Prometheus…" }));
    expect(within(screen.getByRole("group", { name: "Prometheus" })).getByText(METRICS_LINE)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Install Loki…" }));
    expect(screen.getByText("0 sources in use · 2 to install")).toBeTruthy();
    await user.click(continueButton());

    await screen.findByRole("heading", { name: "Name and review" });
    const summary = screen.getByRole("list", { name: "Summary" });
    expect(within(summary).getByText("Install: Prometheus, Alertmanager, node-exporter and kube-state-metrics into the cluster")).toBeTruthy();
    expect(within(summary).getByText("Install: Loki and Grafana Alloy into the cluster")).toBeTruthy();
    expect(screen.getByText("You review the install right after the project is created.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create project and review the install" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Steps" })).getByText("0 sources in use · 2 to install")).toBeTruthy();

    // Back on step 2, nothing to install: the button reads as before.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Install Prometheus…" }));
    await user.click(screen.getByRole("button", { name: "Install Loki…" }));
    expect(continueButton().disabled).toBe(true);
  });

  it("create then opens the install review over the project", async () => {
    const user = userEvent.setup();
    const api = install({ discovery: { c1: PROM_AND_LOKI_MISSING }, install: { tools: TOOLS, plans: [installPlan()], status: { c1: status({ cluster_name: CLUSTER }) } } });
    startFromCluster();
    await user.click(await screen.findByRole("button", { name: "Install Loki…" }));
    await user.click(continueButton());
    await user.click(await screen.findByRole("button", { name: "Create project and review the install" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Install monitoring tools in monitoring")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Install" })));
    expect(selectedTab().textContent).toContain(CLUSTER);
    expect(screen.getByRole("heading", { level: 1, name: CLUSTER })).toBeTruthy();

    expect(setupPosts(api)).toHaveLength(1);
    const plans = installPosts(api);
    expect(plans).toHaveLength(1);
    const projectId = api.state.projects[0].id;
    expect(plans[0].body).toEqual({ cluster_id: "c1", components: ["logs"], project_id: projectId });
    expect(api.requests.indexOf(setupPosts(api)[0])).toBeLessThan(api.requests.indexOf(plans[0]));
    // The setup went with the project: nothing is kept for this tab any more.
    expect(Object.keys(localStorage).filter((k) => k.startsWith(SETUP_DRAFT_PREFIX))).toEqual([]);
  });

  it("a cancelled install review leaves the project and says nothing was installed", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: PROM_AND_LOKI_MISSING }, install: { tools: TOOLS, plans: [installPlan()], status: { c1: status({ cluster_name: CLUSTER }) } } });
    startFromCluster();
    await user.click(await screen.findByRole("button", { name: "Install Loki…" }));
    await user.click(continueButton());
    await user.click(await screen.findByRole("button", { name: "Create project and review the install" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(`Nothing was installed in ${CLUSTER}.`)).toBeTruthy();
    const heading = screen.getByRole("heading", { level: 1, name: CLUSTER });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.activeElement).not.toBe(document.body);
    expect(selectedTab().textContent).toContain(CLUSTER);
  });

  it("a failed install plan after create says so and leaves the keyboard on the page", async () => {
    const user = userEvent.setup();
    const api = install({ discovery: { c1: PROM_AND_LOKI_MISSING }, install: { tools: TOOLS, status: { c1: status({ cluster_name: CLUSTER }) } } });
    startFromCluster();
    await user.click(await screen.findByRole("button", { name: "Install Loki…" }));
    await user.click(continueButton());
    await user.click(await screen.findByRole("button", { name: "Create project and review the install" }));

    expect(await screen.findByText(/^Couldn't review the install in kind-omnikrux-dev: /)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installPosts(api)).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: CLUSTER })).toBeTruthy();
    expect(selectedTab().textContent).toContain(CLUSTER);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a restored install counts only once the tools read says installing is available", async () => {
    // A draft kept with Loki to install and no source in use, restored while the tools read is
    // held, then failed: nothing may be created (it would make an empty project, nothing installed).
    localStorage.setItem(`${SETUP_DRAFT_PREFIX}start0`, JSON.stringify({
      v: 1, start: "c1", named: true,
      draft: { step: 4, kind: "kubernetes", clusterId: "c1", picks: [], name: "Shop", install: { metrics: false, logs: true } },
    }));
    const api = install({ discovery: { c1: LOKI_MISSING } });
    const inner = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/monitoring/install/tools") {
        await held;
        return new Response(JSON.stringify({ detail: "The tools couldn't be read." }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return inner(input, init);
    }));
    startFromCluster();
    await screen.findByRole("heading", { name: "Name and review" });
    const create = () => screen.getByRole("button", { name: /^Create project/ }) as HTMLButtonElement;
    expect(create().disabled).toBe(true);
    expect(screen.getByText("Pick at least one source, or add one by hand.")).toBeTruthy();
    expect(screen.queryByText("Install: Loki and Grafana Alloy into the cluster")).toBeNull();

    release();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(create().disabled).toBe(true);
    fireEvent.click(create());
    expect(setupPosts(api)).toHaveLength(0);
  });

  it("Discard in that question removes the setup draft", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: PROM_AND_LOKI } });
    renderMonitoringApp({ tabs: tabsWith({ page: "setup", clusterId: "c1" }, { page: "home" }) });
    await screen.findByRole("group", { name: "Prometheus" });
    await user.click(continueButton());
    await screen.findByRole("heading", { name: "Name and review" });
    await waitFor(() => expect(localStorage.getItem(`${SETUP_DRAFT_PREFIX}start0`)).not.toBeNull());

    await user.click(screen.getByRole("button", { name: "Close New project" }));
    const ask = screen.getByRole("alertdialog", { name: 'Leave "New project" with unsaved changes?' });
    await user.click(within(ask).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Name and review" })).toBeNull());
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    await waitFor(() => expect(Object.keys(localStorage).filter((k) => k.startsWith(SETUP_DRAFT_PREFIX))).toEqual([]));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("closing the tab with a setup draft asks first", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: PROM_AND_LOKI } });
    renderMonitoringApp({ tabs: tabsWith({ page: "setup", clusterId: "c1" }, { page: "home" }) });
    await screen.findByRole("group", { name: "Prometheus" });
    // Nothing chosen yet: closing doesn't ask (what was found comes back by itself).
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(continueButton());
    await screen.findByRole("heading", { name: "Name and review" });

    // Switching tabs keeps the draft: no question.
    await user.click(screen.getAllByRole("tab")[1]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getAllByRole("tab")[0]);
    await screen.findByRole("heading", { name: "Name and review" });

    const close = screen.getByRole("button", { name: "Close New project" });
    await user.click(close);
    const ask = screen.getByRole("alertdialog", { name: 'Leave "New project" with unsaved changes?' });
    expect(within(ask).getByText("Closing this tab loses the project you started setting up.")).toBeTruthy();
    expect(within(ask).queryByRole("button", { name: "Keep draft and leave" })).toBeNull();
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Name and review" })).toBeTruthy();
    expect(localStorage.getItem(`${SETUP_DRAFT_PREFIX}start0`)).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("unavailable tools replace the install buttons with the reason", async () => {
    install({ discovery: { c1: LOKI_MISSING } });
    startFromCluster();
    const loki = await screen.findByRole("group", { name: "Loki" });
    expect(await within(loki).findByText(`Installing isn't available here: ${FAKE_TOOLS_MISSING}`)).toBeTruthy();
    expect(within(loki).queryByRole("button", { name: /Install/ })).toBeNull();
    expect(screen.getByText("OmniKrux looked inside the cluster. Use what's there, or add a source by hand.")).toBeTruthy();
    expect(screen.getByText("Pick at least one source, or add one by hand.")).toBeTruthy();
  });

  it("installed tools show the chip and link", async () => {
    const user = userEvent.setup();
    const ours = { ...source("s7", "Prometheus · kind"), reach: "cluster" as const, url: null, cluster_id: "c1", installed_by_omnikrux: true };
    install({
      sources: [ours, source("s8", "Central")],
      discovery: { c1: found(tool("prometheus", "reachable", { existing_source_id: "s7" }), tool("loki", "reachable", { existing_source_id: "s8" })) },
      install: { tools: TOOLS, status: { c1: status({ cluster_name: CLUSTER }) } },
    });
    const { current } = startFromCluster();
    const prom = await screen.findByRole("group", { name: "Prometheus" });
    expect(await within(prom).findByText("Installed by OmniKrux")).toBeTruthy();
    expect(within(prom).getByText("Reachable")).toBeTruthy();
    const loki = screen.getByRole("group", { name: "Loki" });
    expect(within(loki).queryByText("Installed by OmniKrux")).toBeNull();
    expect(within(loki).queryByRole("button", { name: "Monitoring tools" })).toBeNull();

    await user.click(within(prom).getByRole("button", { name: "Monitoring tools" }));
    await waitFor(() => expect(current().tabs[0].view).toEqual({ page: "tools", clusterId: "c1" }));
  });

  it("docker and servers line in step 1", async () => {
    const user = userEvent.setup();
    install();
    renderMonitoringApp({ tabs: tabsWith({ page: "setup" }) });
    await screen.findByRole("heading", { name: "What to monitor" });
    await user.click(screen.getByRole("radio", { name: /A Docker host/ }));
    expect(screen.getByText(GENERATES)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Servers/ }));
    expect(screen.getByText(GENERATES)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Something of your own/ }));
    expect(screen.queryByText(GENERATES)).toBeNull();
  });
});

describe("Setup draft in this browser", () => {
  const PASSWORD = "pa55-word-typed-here";
  const HEADER_VALUE = "header-value-typed-here";
  const LOKI_MISSING = found(tool("prometheus", "reachable"), tool("loki", "missing"));
  const stored = () => Object.entries(localStorage).filter(([k]) => k.startsWith(SETUP_DRAFT_PREFIX));

  async function addByHand(user: ReturnType<typeof userEvent.setup>, url: string, fill?: () => Promise<void>) {
    await user.click(await screen.findByRole("button", { name: "+ Add a source by hand" }));
    await user.type(screen.getByLabelText("Address"), url);
    if (fill) await fill();
    await user.click(screen.getByRole("button", { name: "Use this source" }));
    await screen.findByRole("button", { name: "+ Add a source by hand" });
  }

  it("a setup left mid-way comes back", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: LOKI_MISSING }, install: { tools: TOOLS } });
    const { navigate } = startFromCluster();
    const field = await screen.findByRole("textbox", { name: "Filter for Prometheus" });
    await user.type(field, 'job="api"');
    await user.click(screen.getByRole("button", { name: "Install Loki…" }));
    await addByHand(user, "http://prom.example:9090");
    expect(screen.getByText("2 sources in use · 1 to install")).toBeTruthy();
    await user.click(continueButton());
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Shop");

    navigate({ page: "home" }, "push");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Name and review" })).toBeNull());
    navigate({ page: "setup", clusterId: "c1" }, "push");

    expect(await screen.findByRole("heading", { name: "Name and review" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Shop");
    expect(screen.getByText("Install: Loki and Grafana Alloy into the cluster")).toBeTruthy();
    expect(screen.getByText("Prometheus · prom.example · new")).toBeTruthy();
    expect(screen.getByText('Filter: job="api"')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create project and review the install" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: `What we found in ${CLUSTER}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install Loki…" }).getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByRole("textbox", { name: "Filter for Prometheus" }) as HTMLInputElement).value).toBe('job="api"');
    expect(screen.getByText("2 sources in use · 1 to install")).toBeTruthy();
    // The name typed stays the user's: it doesn't follow the cluster again.
    await user.click(continueButton());
    expect(((await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement).value).toBe("Shop");
  });

  it("secrets never reach browser storage", async () => {
    const user = userEvent.setup();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    // M6 (F26): a Grafana token typed on step 3 never reaches storage either.
    const GRAFANA_TOKEN = "glsa_typed-grafana-token-value";
    const SIGN_IN = `Grafana · ${CLUSTER} needs a sign-in, and a Grafana reached through its cluster can't take one. Reach it by its address instead, with a service account token.`;
    try {
      const api = install({
        discovery: { c1: found(tool("prometheus", "reachable"), tool("loki", "missing"), tool("grafana", "reachable", { service: "grafana", port: "80" })) },
        transfer: { grafanaDashboards: { new: { status: 502, detail: { code: "grafana", message: SIGN_IN, key: null, problems: [] } } } },
      });
      const { navigate } = startFromCluster();
      await screen.findByRole("group", { name: "Prometheus" });
      await addByHand(user, "http://basic.example:9090", async () => {
        await user.selectOptions(screen.getByLabelText("Authentication"), "basic");
        await user.type(screen.getByLabelText("User name"), "reader");
        await user.type(screen.getByLabelText("Password"), PASSWORD);
      });
      await addByHand(user, "http://bearer.example:9090", async () => {
        await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
        await user.type(screen.getByLabelText("Token"), TOKEN);
      });
      await addByHand(user, "http://header.example:9090", async () => {
        await user.click(screen.getByRole("button", { name: "Add header" }));
        await user.type(screen.getByLabelText("Header 1 name"), "X-Scope-OrgID");
        await user.type(screen.getByLabelText("Header 1 value"), HEADER_VALUE);
      });
      // A form being typed is never kept either.
      await user.click(screen.getByRole("button", { name: "+ Add a source by hand" }));
      await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
      await user.type(screen.getByLabelText("Token"), "half-typed-token-value");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(continueButton());
      await screen.findByRole("heading", { name: "Import from Grafana" });
      await user.click(await screen.findByRole("button", { name: "Use its address instead" }));
      await user.type(await screen.findByLabelText("Address"), "http://grafana.example.invalid:3000");
      await user.selectOptions(screen.getByLabelText("Sign-in"), "bearer");
      await user.type(screen.getByLabelText("Token"), GRAFANA_TOKEN);
      api.state.transfer.grafanaDashboards.new = { items: [{ uid: "u1", title: "Node overview", folder: null, tags: [] }], truncated: false };
      await user.click(screen.getByRole("button", { name: "Use it" }));
      await screen.findByRole("checkbox", { name: "Node overview" });
      await user.click(continueButton());
      await screen.findByRole("heading", { name: "Name and review" });
      navigate({ page: "home" }, "push");
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Name and review" })).toBeNull());

      const drafts = setItem.mock.calls.filter(([k]) => String(k).startsWith(SETUP_DRAFT_PREFIX));
      expect(drafts.length).toBeGreaterThan(0);
      for (const [k, v] of setItem.mock.calls) {
        for (const secret of [PASSWORD, TOKEN, HEADER_VALUE, "half-typed-token-value", GRAFANA_TOKEN]) {
          expect(String(k)).not.toContain(secret);
          expect(String(v)).not.toContain(secret);
        }
      }
      for (const [, v] of Object.entries(localStorage)) {
        for (const secret of [PASSWORD, TOKEN, HEADER_VALUE, "half-typed-token-value", GRAFANA_TOKEN]) expect(v).not.toContain(secret);
      }
      const [[, last]] = stored();
      const kept = JSON.parse(last) as { draft: SetupDraft };
      const hand = kept.draft.picks.filter((p) => p.key.startsWith("hand:"));
      expect(hand.map((p) => p.secretsDropped)).toEqual([true, true, true]);
      expect(hand.map((p) => ("new" in p.source ? p.source.new.auth : null))).toEqual([
        { type: "basic", username: "reader" }, { type: "bearer" }, { type: "none" },
      ]);
      expect("new" in hand[2].source && hand[2].source.new.headers).toEqual([{ name: "X-Scope-OrgID" }]);
      expect(kept.draft.importFrom).toEqual({
        connection: { reach: "url", name: `Grafana · ${CLUSTER}`, url: "http://grafana.example.invalid:3000", auth: { type: "bearer" } },
        label: `Grafana · ${CLUSTER}`, uids: ["u1"], preview: null, secretsDropped: true, chosen: true,
      });
    } finally {
      setItem.mockRestore();
    }
  }, 15_000); // M6 (F26) made it longer: a Grafana sign-in typed on step 3.

  it("a restored pick without its secret isn't used", async () => {
    const user = userEvent.setup();
    install({ discovery: { c1: found(tool("loki", "missing")) } });
    const { navigate } = startFromCluster();
    await screen.findByRole("group", { name: "Loki" });
    await addByHand(user, "http://bearer.example:9090", async () => {
      await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
      await user.type(screen.getByLabelText("Token"), TOKEN);
    });
    await addByHand(user, "http://open.example:9090");
    expect(screen.getByText("2 sources in use")).toBeTruthy();

    navigate({ page: "home" }, "push");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Loki" })).toBeNull());
    navigate({ page: "setup", clusterId: "c1" }, "push");

    const lost = await screen.findByRole("group", { name: "Prometheus · bearer.example" });
    expect(within(lost).getByText(SECRET_NOT_KEPT)).toBeTruthy();
    expect(within(lost).queryByRole("textbox")).toBeNull();
    const kept = screen.getByRole("group", { name: "Prometheus · open.example" });
    expect(within(kept).queryByText(SECRET_NOT_KEPT)).toBeNull();
    expect(screen.getByText("1 source in use")).toBeTruthy();

    await user.click(within(lost).getByRole("button", { name: "Enter it again" }));
    expect(screen.queryByRole("group", { name: "Prometheus · bearer.example" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Address")));
  });
});
