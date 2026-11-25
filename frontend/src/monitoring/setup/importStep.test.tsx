import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AlertChangeOut } from "../alerts/api";
import type { DiscoveryOut, FoundTool } from "../api/types";
import { TOOLS } from "../install/toolsFixtures";
import { installFakeMonitoringApi, type FakeMonitoringSeed } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import type { GrafanaDashboardsOut, GrafanaIn, ImportCommitIn, ImportPreviewIn, ImportPreviewOut, ImportResultOut, PreviewDashboardOut } from "../transfer/api";

// The tool review queue and the install reviews as setup sees them: spies (their dialogs are M4's
// and M5's tests).
const enqueue = vi.hoisted(() => vi.fn());
const install = vi.hoisted(() => vi.fn(async () => "applied" as const));
vi.mock("../alerts/reviews/useToolReviews", async (orig) => {
  const real = await orig<typeof import("../alerts/reviews/useToolReviews")>();
  return { ...real, useToolReviews: () => ({ enqueue, reviewTarget: () => Promise.resolve("cancelled"), pending: 0 }) };
});
vi.mock("../install/useInstallReviews", async (orig) => {
  const real = await orig<typeof import("../install/useInstallReviews")>();
  const cancelled = () => Promise.resolve("cancelled" as const);
  return { ...real, useInstallReviews: () => ({ install, uninstall: cancelled, contacts: cancelled, turn: () => Promise.resolve(() => {}) }) };
});

beforeEach(() => {
  localStorage.clear();
  enqueue.mockClear();
  install.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const CLUSTER = "kind-omnikrux-dev";
const TOKEN = "glsa_setup-typed-grafana-token";
const SIGN_IN = `Grafana · ${CLUSTER} needs a sign-in, and a Grafana reached through its cluster can't take one. Reach it by its address instead, with a service account token.`;
const FIRST_SOURCE = "Each Grafana data source uses this project's first source of the same type.";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const clusters = [{ id: "c1", name: CLUSTER, provider: "kind", state: "ready" }];

function tool(type: FoundTool["type"], state: FoundTool["state"], over: Partial<FoundTool> = {}): FoundTool {
  const missing = state === "missing";
  return {
    type, state, namespace: missing ? null : "monitoring", service: missing ? null : `${type}-server`, port: missing ? null : "9090",
    scheme: "http", version: state === "reachable" ? "3.1.0" : null, message: null, existing_source_id: null, detail: null, ...over,
  };
}
const found = (...tools: FoundTool[]): DiscoveryOut => ({ cluster_id: "c1", cluster_name: CLUSTER, state: "ok", message: null, found: tools, checked_at: T });
const GRAFANA = tool("grafana", "reachable", { service: "grafana", port: "80", version: "12.1.0" });
const WITH_GRAFANA = found(tool("prometheus", "reachable"), GRAFANA);

const DASHBOARDS: GrafanaDashboardsOut = {
  items: [
    { uid: "u1", title: "Node overview", folder: "Infra", tags: [] },
    { uid: "u2", title: "API latency", folder: null, tags: [] },
    { uid: "u3", title: "Ingress", folder: null, tags: [] },
  ],
  truncated: false,
};
const SKIPPED = [
  { where: 'Panel "Errors"', what: "Its unit", reason: "Grafana's unit percentunit has no match; it shows plain numbers." },
  { where: 'Panel "Errors"', what: "Its links", reason: "Panel links aren't copied." },
  { where: "The dashboard", what: "Annotations", reason: "Annotations aren't copied." },
];
const dash = (key: string, title: string, over: Partial<PreviewDashboardOut> = {}): PreviewDashboardOut => ({
  key, title, suggested_title: title, title_taken: false, panels: 4, alerts: 0, skipped: [], problems: [], importable: true, digest: `dg-${key}`, ...over,
});
const preview = (dashboards: PreviewDashboardOut[]): ImportPreviewOut => ({
  format: "grafana_instance", format_label: "Grafana dashboards", target_kinds: ["project"], suggested_target: null, bundle: null,
  sources: [
    { key: "prom", type: "prometheus", type_guessed: false, name: "Prometheus", detail: null, suggestion: null, leave_out: false, reason: "" },
    { key: "logs", type: "loki", type_guessed: false, name: "Loki", detail: null, suggestion: null, leave_out: false, reason: "" },
  ],
  dashboards, skipped_total: dashboards.reduce((n, d) => n + d.skipped.length, 0),
});
const ALL = preview([dash("u1", "Node overview"), dash("u2", "API latency", { skipped: SKIPPED }), dash("u3", "Ingress (2)", { title: "Ingress" })]);
const TWO = preview([dash("u1", "Node overview"), dash("u3", "Ingress")]);
const PREVIEWS = { "grafana:new:u1,u2,u3": ALL, "grafana:new:u1,u3": TWO };

const contacts: AlertChangeOut = {
  target_id: "t1", rule_id: "r1", rule_name: "High error rate", project_id: "p1", project_name: CLUSTER, kind: "contacts", message: null, cluster_id: "c1",
};
const result = (over: Partial<ImportResultOut> = {}): ImportResultOut => ({
  dashboards: [{ key: "u1", id: "d1", title: "Node overview", owner_kind: "project", owner_id: "p1" }],
  group_id: null, grafana_id: null, warnings: [], alert_changes: [], ...over,
});
const failed = (status: number, code: string, message: string) => ({ status, detail: { code, message, key: null, problems: [] } });

function setUp(seed: FakeMonitoringSeed = {}) {
  const api = installFakeMonitoringApi({
    discovery: { c1: WITH_GRAFANA }, ...seed,
    transfer: { grafanaDashboards: { new: DASHBOARDS }, previews: PREVIEWS, commits: [result()], ...seed.transfer },
  }, async (url: string) => json(url === "/api/clusters" ? clusters : []));
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "setup", clusterId: "c1" }) });
  return { api, app };
}
type Api = ReturnType<typeof setUp>["api"];
const posts = (api: Api, path: string) => api.requests.filter((r) => r.method === "POST" && r.url === `/api/monitoring/${path}`);
const listLoads = (api: Api) => posts(api, "grafana/dashboards").map((r) => r.body as GrafanaIn);
const previewsSent = (api: Api) => posts(api, "import/preview").map((r) => r.body as ImportPreviewIn);
const commitsSent = (api: Api) => posts(api, "import/commit").map((r) => r.body as ImportCommitIn);
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const steps = () => screen.getByRole("list", { name: "Steps" });
const selectedTab = () => screen.getByRole("tab", { selected: true });
const boxes = () => within(screen.getByRole("group", { name: "Dashboards in Grafana" })).getAllByRole("checkbox") as HTMLInputElement[];

/** Step 2 → step 3, its dashboards listed and checked. */
async function toImport(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("group", { name: "Prometheus" });
  await user.click(button("Continue"));
  return await screen.findByRole("heading", { name: "Import from Grafana" });
}
const summaryOf = (text: string) => screen.findByText(text, {}, { timeout: 3000 });

describe("Setup step 3: import from Grafana", () => {
  it("step 3 appears when Grafana was found and lists its dashboards checked", async () => {
    const user = userEvent.setup();
    const { api } = setUp();
    const grafanaRow = await screen.findByRole("group", { name: "Grafana" });
    expect(within(grafanaRow).getByText("You can copy its dashboards in the next step.")).toBeTruthy();
    expect(within(steps()).queryByText("Nothing to import")).toBeNull();

    const heading = await toImport(user);
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText(`OmniKrux found Grafana in ${CLUSTER}. Copy its dashboards into this project. Nothing in Grafana changes.`)).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Grafana" })).getByText("monitoring/grafana · v12.1.0")).toBeTruthy();
    const current = within(steps()).getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "step");
    expect(current[0].textContent).toContain("Import");

    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect(listLoads(api)).toEqual([{ name: `Grafana · ${CLUSTER}`, reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "grafana", port: "80", scheme: "http", auth: { type: "none" } }]);

    expect(await summaryOf("3 dashboards to copy · 3 things won't be copied")).toBeTruthy();
    expect(previewsSent(api)).toHaveLength(1);
    expect(previewsSent(api)[0]).toEqual({ input: { kind: "grafana", connection: listLoads(api)[0], uids: ["u1", "u2", "u3"] }, target: null });
    expect(screen.getByText(FIRST_SOURCE)).toBeTruthy();
    const copy = screen.getByRole("list", { name: "Dashboards to copy" });
    const skipped = within(copy).getByRole("button", { name: "Skipped (3)" });
    await user.click(skipped);
    expect(skipped.getAttribute("aria-expanded")).toBe("true");
    expect(within(copy).getByText("Annotations")).toBeTruthy();
    expect(screen.getByText("1 source in use · 3 dashboards to copy")).toBeTruthy();
    expect(button("Continue")).toBeTruthy();
  });

  it("without Grafana step 3 is skipped and says nothing to import", async () => {
    const user = userEvent.setup();
    const { api } = setUp({ discovery: { c1: found(tool("prometheus", "reachable"), tool("grafana", "unreachable", { message: "connection refused" })) } });
    const grafanaRow = await screen.findByRole("group", { name: "Grafana" });
    expect(within(grafanaRow).queryByText("You can copy its dashboards in the next step.")).toBeNull();
    expect(within(steps()).getByText("Nothing to import")).toBeTruthy();
    const importStep = within(steps()).getAllByRole("listitem")[2];
    expect(importStep.getAttribute("data-state")).toBe("later");

    await user.click(button("Continue"));
    expect(await screen.findByRole("heading", { name: "Name and review" })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Summary" })).getByText("Import: none")).toBeTruthy();
    expect(button("Create project")).toBeTruthy();
    await user.click(button("Back"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: `What we found in ${CLUSTER}` }));
    expect(listLoads(api)).toHaveLength(0);
  });

  it("skip import goes on with nothing to import", async () => {
    const user = userEvent.setup();
    setUp({ transfer: { grafanaDashboards: { new: failed(502, "grafana", SIGN_IN) } } });
    await toImport(user);
    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.click(button("Skip import"));
    expect(await screen.findByRole("heading", { name: "Name and review" })).toBeTruthy();
    expect(screen.getByText("Import: none")).toBeTruthy();
  });

  it("the skipped summary follows the selection", async () => {
    const user = userEvent.setup();
    const { api } = setUp();
    await toImport(user);
    expect(await summaryOf("3 dashboards to copy · 3 things won't be copied")).toBeTruthy();
    expect(previewsSent(api)).toHaveLength(1);

    await user.click(within(screen.getByRole("group", { name: "Dashboards in Grafana" })).getByRole("checkbox", { name: "API latency" }));
    expect(await screen.findByText("Checking what converts…")).toBeTruthy();
    expect(await summaryOf("2 dashboards to copy · everything converts")).toBeTruthy();
    const sent = previewsSent(api);
    expect(sent).toHaveLength(2);
    expect(sent[1].input).toEqual({ kind: "grafana", connection: listLoads(api)[0], uids: ["u1", "u3"] });
    expect(sent[1].target).toBeNull();
    expect(screen.queryByRole("button", { name: /^Skipped/ })).toBeNull();
  });

  it("a Grafana that wants a sign-in offers its address or skipping", async () => {
    const user = userEvent.setup();
    const { api, app } = setUp({ transfer: { grafanaDashboards: { new: failed(502, "grafana", SIGN_IN) } } });
    await toImport(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SIGN_IN);
    expect(button("Skip import")).toBeTruthy();
    expect(button("Continue without importing")).toBeTruthy();

    await user.click(button("Use its address instead"));
    const address = await screen.findByLabelText("Address");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("radio", { name: "By its address" })));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(`Grafana · ${CLUSTER}`);
    await user.type(address, "http://grafana.example.invalid:3000");
    await user.selectOptions(screen.getByLabelText("Sign-in"), "bearer");
    await user.type(screen.getByLabelText("Token"), TOKEN);
    api.state.transfer.grafanaDashboards.new = DASHBOARDS;
    await user.click(button("Use it"));

    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(boxes().every((b) => b.checked)).toBe(true);
    const loads = listLoads(api);
    expect(loads).toHaveLength(2);
    expect(loads[1]).toEqual({ reach: "url", name: `Grafana · ${CLUSTER}`, url: "http://grafana.example.invalid:3000", auth: { type: "bearer", token: TOKEN } });
    expect(within(screen.getByRole("group", { name: "Grafana" })).getByText("http://grafana.example.invalid:3000")).toBeTruthy();
    await waitFor(() => expect(previewsSent(api)).toHaveLength(1));
    expect(previewsSent(api)[0].input).toEqual({ kind: "grafana", connection: loads[1], uids: ["u1", "u2", "u3"] });

    // The token went in the requests' bodies only: never a cache, the page's text or a URL.
    const { client } = app;
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => [q.queryKey, q.state]))).not.toContain(TOKEN);
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state))).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(api.requests.some((r) => r.url.includes(TOKEN))).toBe(false);
  });

  it("create project then imports the chosen dashboards", async () => {
    const user = userEvent.setup();
    const { api, app } = setUp({ transfer: { commits: [result({ alert_changes: [contacts] })] } });
    await toImport(user);
    expect(await summaryOf("3 dashboards to copy · 3 things won't be copied")).toBeTruthy();
    await user.click(button("Continue"));
    await screen.findByRole("heading", { name: "Name and review" });

    // The commit is held to see the button's words while it runs.
    const inner = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/monitoring/import/commit") await held;
      return inner(input, init);
    }));
    await user.click(button("Create project"));
    expect(await screen.findByRole("button", { name: "Importing dashboards…" })).toBeTruthy();
    release();

    await waitFor(() => expect(app.current().tabs[0].view).toEqual({ page: "project", id: api.state.projects[0].id }));
    const projectId = api.state.projects[0].id;
    const [setup] = posts(api, "setup");
    const [commit] = posts(api, "import/commit");
    expect(api.requests.indexOf(setup)).toBeLessThan(api.requests.indexOf(commit));
    expect(commitsSent(api)).toEqual([{
      input: { kind: "grafana", connection: listLoads(api)[0], uids: ["u1", "u2", "u3"] },
      target: { kind: "project", id: projectId },
      new_group: null,
      mapping: [{ key: "prom", source_id: null }, { key: "logs", source_id: null }],
      dashboards: [
        { key: "u1", title: "Node overview", digest: "dg-u1" },
        { key: "u2", title: "API latency", digest: "dg-u2" },
        { key: "u3", title: "Ingress (2)", digest: "dg-u3" },
      ],
    }]);
    const heading = await screen.findByRole("heading", { level: 1, name: CLUSTER });
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith([contacts], { focus: heading }));
    expect(install).not.toHaveBeenCalled();
  });

  it("a failed import after setup keeps the project and offers a retry", async () => {
    const user = userEvent.setup();
    const NO_ANSWER = `Grafana · ${CLUSTER} didn't answer in time. Try again.`;
    const { api, app } = setUp({ transfer: { commits: failed(502, "grafana", NO_ANSWER) } });
    await toImport(user);
    expect(await summaryOf("3 dashboards to copy · 3 things won't be copied")).toBeTruthy();
    await user.click(button("Continue"));
    await screen.findByRole("heading", { name: "Name and review" });
    await user.click(button("Create project"));

    const alert = await screen.findByText(`The project was created, but its dashboards weren't imported: ${NO_ANSWER}`);
    expect(alert.getAttribute("role")).toBe("alert");
    const retry = button("Try the import again");
    await waitFor(() => expect(document.activeElement).toBe(retry));
    expect(button("Open the project")).toBeTruthy();
    expect(api.state.projects).toHaveLength(1);
    expect(app.current().tabs[0].view.page).toBe("setup");
    expect(commitsSent(api)).toHaveLength(1);

    await user.click(retry);
    await waitFor(() => expect(commitsSent(api)).toHaveLength(2));
    await waitFor(() => expect(button("Try the import again").getAttribute("aria-disabled")).toBeNull());
    expect(document.activeElement).toBe(button("Try the import again"));
    expect(posts(api, "setup")).toHaveLength(1);

    // Changed since the check: what converts is checked again for the project and shown; nothing
    // is imported until the next try.
    const NOW = preview([
      dash("u1", "Node overview", { digest: "dg2-u1", skipped: [SKIPPED[2]] }),
      dash("u2", "API latency", { digest: "dg2-u2", skipped: SKIPPED }),
      dash("u3", "Ingress", { importable: false, problems: [{ path: "", message: "Grafana couldn't send it" }] }),
    ]);
    api.state.transfer.previews = { ...PREVIEWS, "grafana:new:u1,u2,u3": NOW };
    api.state.transfer.commits = failed(409, "changed", '"Ingress" changed since you checked it. Check again.');
    const before = previewsSent(api).length;
    await user.click(button("Try the import again"));
    expect(await screen.findByText("2 dashboards to copy · 4 things won't be copied")).toBeTruthy();
    expect(screen.getByText("Something changed since you checked. Here is the new result.")).toBeTruthy();
    expect(screen.getByText("This dashboard can't be imported: Grafana couldn't send it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skipped (3)" })).toBeTruthy();
    const rechecks = previewsSent(api).slice(before);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0].target).toEqual({ kind: "project", id: api.state.projects[0].id });
    expect(commitsSent(api)).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(button("Try the import again")));

    api.state.transfer.commits = [result()];
    await user.click(button("Try the import again"));
    await waitFor(() => expect(app.current().tabs[0].view).toEqual({ page: "project", id: api.state.projects[0].id }));
    expect(commitsSent(api)).toHaveLength(4);
    expect(commitsSent(api)[3].dashboards).toEqual([
      { key: "u1", title: "Node overview", digest: "dg2-u1" },
      { key: "u2", title: "API latency", digest: "dg2-u2" },
    ]);
    expect(posts(api, "setup")).toHaveLength(1);
  });

  it("step 4 lists the import line", async () => {
    const user = userEvent.setup();
    setUp();
    await toImport(user);
    expect(await summaryOf("3 dashboards to copy · 3 things won't be copied")).toBeTruthy();
    await user.click(button("Continue"));
    await screen.findByRole("heading", { name: "Name and review" });
    const summary = screen.getByRole("list", { name: "Summary" });
    expect(within(summary).getByText("Import: 3 dashboards from Grafana · 3 things won't be copied")).toBeTruthy();
    expect(within(steps()).getByText("3 dashboards to copy")).toBeTruthy();
    expect(button("Create project")).toBeTruthy();

    // Back on step 3 the choice stays; with nothing chosen there is nothing to import.
    await user.click(button("Back"));
    expect(await screen.findByRole("heading", { name: "Import from Grafana" })).toBeTruthy();
    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(boxes().every((b) => b.checked)).toBe(true);
    await user.click(button("Select none"));
    await user.click(button("Continue without importing"));
    await screen.findByRole("heading", { name: "Name and review" });
    expect(screen.getByText("Import: none")).toBeTruthy();
  });

  it("a restored import without its sign-in asks for it again", async () => {
    const user = userEvent.setup();
    const kept = {
      connection: { name: "Main", reach: "url", url: "http://grafana.example.invalid:3000", auth: { type: "bearer" } },
      label: "Main", uids: ["u1", "u3"], preview: null, secretsDropped: true,
    };
    localStorage.setItem("omnikrux.monitoring.setupDraft.start0", JSON.stringify({
      v: 1, start: "c1", named: true, draft: { step: 4, kind: "kubernetes", clusterId: "c1", picks: [], name: "Shop", importFrom: kept },
    }));
    const { api } = setUp();
    expect(await screen.findByRole("heading", { name: "Import from Grafana" })).toBeTruthy();
    expect(await screen.findByText("Its sign-in wasn't kept. Enter it again to load its dashboards.")).toBeTruthy();
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("http://grafana.example.invalid:3000");
    expect((screen.getByLabelText("Sign-in") as HTMLSelectElement).value).toBe("bearer");
    expect(listLoads(api)).toHaveLength(0);
    expect(previewsSent(api)).toHaveLength(0);

    await user.type(screen.getByLabelText("Token"), TOKEN);
    await user.click(button("Use it"));
    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(listLoads(api)[0].auth).toEqual({ type: "bearer", token: TOKEN });
    // The dashboards chosen before it was left stay chosen.
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
    expect(await summaryOf("2 dashboards to copy · everything converts")).toBeTruthy();
    expect(previewsSent(api)[0].input).toEqual({ kind: "grafana", connection: listLoads(api)[0], uids: ["u1", "u3"] });
  });

  it("quick changes make one check, and an answer for an older choice is dropped", async () => {
    const user = userEvent.setup();
    const ONE = preview([dash("u1", "Node overview")]);
    const { api } = setUp({ transfer: { previews: { ...PREVIEWS, "grafana:new:u1": ONE } } });
    // The check of every dashboard is held, and answers only after a newer choice was checked.
    const inner = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/monitoring/import/preview" && (JSON.parse(String(init?.body)) as ImportPreviewIn).input.kind === "grafana") {
        const uids = ((JSON.parse(String(init?.body)) as ImportPreviewIn).input as { uids: string[] }).uids.join(",");
        if (uids === "u1,u2,u3") {
          await held;
          return inner(input, { ...init, signal: undefined });
        }
      }
      return inner(input, init);
    }));
    await toImport(user);
    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(await screen.findByText("Checking what converts…")).toBeTruthy();
    // (The fake records a request once it reaches it: the held one shows after it is released.)
    await new Promise((r) => setTimeout(r, 600));

    // Two changes inside 500 ms: one check, for the last choice.
    const list = screen.getByRole("group", { name: "Dashboards in Grafana" });
    await user.click(within(list).getByRole("checkbox", { name: "API latency" }));
    await user.click(within(list).getByRole("checkbox", { name: "Ingress" }));
    expect(await summaryOf("1 dashboard to copy · everything converts")).toBeTruthy();
    expect(previewsSent(api).map((p) => (p.input as { uids: string[] }).uids)).toEqual([["u1"]]);

    // The first check answers late: what shows stays the answer for the current choice.
    release();
    await waitFor(() => expect(previewsSent(api)).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("1 dashboard to copy · everything converts")).toBeTruthy();
    expect(screen.queryByText("3 dashboards to copy · 3 things won't be copied")).toBeNull();
  });

  it("a later look inside the cluster keeps an import by its address, shown without its sign-in", async () => {
    const user = userEvent.setup();
    const { api, app } = setUp({ transfer: { grafanaDashboards: { new: failed(502, "grafana", SIGN_IN) } } });
    await toImport(user);
    await user.click(await screen.findByRole("button", { name: "Use its address instead" }));
    await user.type(await screen.findByLabelText("Address"), "http://viewer:pw-in-url@grafana.example.invalid:3000/");
    api.state.transfer.grafanaDashboards.new = DASHBOARDS;
    await user.click(button("Use it"));
    await waitFor(() => expect(boxes()).toHaveLength(3));
    const row = screen.getByRole("group", { name: "Grafana" });
    expect(within(row).getByText("http://grafana.example.invalid:3000/")).toBeTruthy();
    expect(document.body.textContent).not.toContain("pw-in-url");

    // The cluster's Grafana is no longer found: the import by its address stays, with its choice.
    api.state.discovery.c1 = found(tool("prometheus", "reachable"));
    await app.client.refetchQueries();
    await waitFor(() => expect(api.requests.filter((r) => r.url === "/api/monitoring/discovery/c1").length).toBeGreaterThan(1));
    expect(screen.getByRole("heading", { name: "Import from Grafana" })).toBeTruthy();
    expect(boxes().every((b) => b.checked)).toBe(true);
    expect(await summaryOf("3 dashboards to copy · 3 things won't be copied")).toBeTruthy();
  });

  it("Esc on a restored sign-in keeps the import and offers to enter it again", async () => {
    const user = userEvent.setup();
    localStorage.setItem("omnikrux.monitoring.setupDraft.start0", JSON.stringify({
      v: 1, start: "c1", named: true,
      draft: {
        step: 3, kind: "kubernetes", clusterId: "c1", picks: [], name: "Shop",
        importFrom: { connection: { reach: "url", url: "http://grafana.example.invalid:3000", auth: { type: "bearer" } }, label: "Main", uids: ["u1"], secretsDropped: true },
      },
    }));
    setUp();
    const address = await screen.findByLabelText("Address");
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    address.focus();
    await user.keyboard("{Escape}");
    const again = await screen.findByRole("button", { name: "Enter it again" });
    expect(screen.getByRole("heading", { name: "Import from Grafana" })).toBeTruthy();
    expect(screen.getByText("Its sign-in wasn't kept. Enter it again to load its dashboards.")).toBeTruthy();
    expect(button("Skip import")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(again));
    await user.click(again);
    expect(await screen.findByLabelText("Token")).toBeTruthy();
  });

  it("a restored choice of none stays none", async () => {
    localStorage.setItem("omnikrux.monitoring.setupDraft.start0", JSON.stringify({
      v: 1, start: "c1", named: true,
      draft: {
        step: 3, kind: "kubernetes", clusterId: "c1", picks: [], name: "Shop",
        importFrom: {
          connection: { name: `Grafana · ${CLUSTER}`, reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "grafana", port: "80", scheme: "http", auth: { type: "none" } },
          label: "Grafana", uids: [], chosen: true,
        },
      },
    }));
    const { api } = setUp();
    await waitFor(() => expect(boxes()).toHaveLength(3));
    expect(boxes().some((b) => b.checked)).toBe(false);
    expect(button("Continue without importing")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 600));
    expect(previewsSent(api)).toHaveLength(0);
  });

  it("a draft restored on step 3 without a Grafana any more opens on step 4", async () => {
    localStorage.setItem("omnikrux.monitoring.setupDraft.start0", JSON.stringify({
      v: 1, start: "c1", named: true,
      draft: { step: 3, kind: "kubernetes", clusterId: "c1", picks: [], name: "Shop", importFrom: { connection: { reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "grafana", port: "80" }, label: "Grafana", uids: ["u1"] } },
    }));
    const { api } = setUp({ discovery: { c1: found(tool("prometheus", "reachable")) } });
    expect(await screen.findByRole("heading", { name: "Name and review" })).toBeTruthy();
    expect(screen.getByText("Import: none")).toBeTruthy();
    expect(within(steps()).getByText("Nothing to import")).toBeTruthy();
    expect(listLoads(api)).toHaveLength(0);
  });

  it("create with an install and an import runs both in order", async () => {
    const user = userEvent.setup();
    const MISSING = found(tool("prometheus", "missing"), GRAFANA);
    const run = async (commits: ImportResultOut[] | ReturnType<typeof failed>) => {
      const env = setUp({ discovery: { c1: MISSING }, install: { tools: TOOLS }, transfer: { commits } });
      await user.click(await screen.findByRole("button", { name: "Install Prometheus…" }));
      await user.click(button("Continue"));
      await screen.findByRole("heading", { name: "Import from Grafana" });
      await waitFor(() => expect(boxes()).toHaveLength(3));
      await user.click(within(screen.getByRole("group", { name: "Dashboards in Grafana" })).getByRole("checkbox", { name: "API latency" }));
      expect(await summaryOf("2 dashboards to copy · everything converts")).toBeTruthy();
      await user.click(button("Continue"));
      await screen.findByRole("heading", { name: "Name and review" });
      expect(screen.getByText("Import: 2 dashboards from Grafana · everything converts")).toBeTruthy();
      await user.click(button("Create project, import and review the install"));
      await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
      return env;
    };

    const { api, app } = await run([result({ alert_changes: [contacts] })]);
    const projectId = api.state.projects[0].id;
    const [setup] = posts(api, "setup");
    const [commit] = posts(api, "import/commit");
    expect(api.requests.indexOf(setup)).toBeLessThan(api.requests.indexOf(commit));
    expect((commit.body as ImportCommitIn).mapping).toEqual([{ key: "prom", source_id: null }, { key: "logs", source_id: null }]);
    expect((commit.body as ImportCommitIn).dashboards.map((d) => d.key)).toEqual(["u1", "u3"]);
    expect(app.current().tabs[0].view).toEqual({ page: "project", id: projectId });
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ clusterId: "c1", components: ["metrics"], projectId }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue.mock.calls[0][0]).toEqual([contacts]);
    expect(install.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);

    // The import fails: the project says so, and the install review still opens.
    cleanup();
    localStorage.clear();
    install.mockClear();
    enqueue.mockClear();
    const MESSAGE = `Grafana · ${CLUSTER} didn't answer in time. Try again.`;
    const second = await run(failed(502, "grafana", MESSAGE));
    const id = second.api.state.projects[0].id;
    expect(second.app.current().tabs[0].view).toEqual({ page: "project", id });
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ clusterId: "c1", components: ["metrics"], projectId: id }));
    const line = await screen.findByText(`The project was created, but its dashboards weren't imported: ${MESSAGE}`);
    const alert = line.closest("[role='alert']") as HTMLElement;
    expect(alert).not.toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Import dashboards…" }));
    await waitFor(() => expect(second.app.current().tabs[0].view).toEqual({ page: "import", target: { kind: "project", id } }));
    expect(enqueue).not.toHaveBeenCalled();
    expect(selectedTab()).toBeTruthy();
  });
});
