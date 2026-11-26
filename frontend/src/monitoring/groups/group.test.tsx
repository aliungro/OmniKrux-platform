import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut } from "../api/types";
import type { RuleOut, TargetOut } from "../alerts/api";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import { seedDashboard, spec } from "../test/dashboardSeeds";
import { editSessions } from "../dashboards/editor/useDashboardEditor";

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);
const group = (id: string, name: string, project_ids: string[]): GroupOut => ({ id, name, project_ids, created_at: T, updated_at: T });
const projects = () => [seedProject("p1", "Dev"), seedProject("p2", "Stage"), seedProject("p3", "Prod east")];

describe("Groups", () => {
  it("a group is made from picked projects and shows shortcuts", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects() }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "newGroup" }) });
    expect(await screen.findByRole("heading", { name: "New group" })).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "Everything dev");
    await user.click(await screen.findByRole("checkbox", { name: "Dev" }));
    await user.click(screen.getByRole("checkbox", { name: "Stage" }));
    await user.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(api.state.groups).toHaveLength(1));
    const post = api.requests.find((r) => r.method === "POST" && r.url === "/api/monitoring/groups")!;
    expect(post.body).toEqual({ name: "Everything dev", project_ids: ["p1", "p2"] });
    expect(await screen.findByRole("heading", { name: "Everything dev" })).toBeTruthy();
    const shortcuts = screen.getByRole("list", { name: "Projects in this group" });
    expect(within(shortcuts).getAllByRole("button").map((b) => b.textContent)).toEqual(["↗Dev", "↗Stage"]);
    expect(screen.getByText("No group dashboards yet. A group dashboard runs each panel once per project in the group.")).toBeTruthy();
    // The shortcut opens the project as it is.
    await user.click(within(shortcuts).getByRole("button", { name: /Dev/ }));
    expect(await screen.findByRole("heading", { name: "Dev" })).toBeTruthy();
    expect(api.state.projects).toHaveLength(3);
  });

  it("shows the server's words when a group can't be made", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", [])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "newGroup" }) });
    await user.type(await screen.findByLabelText("Name"), "prod");
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect((await screen.findByRole("alert")).textContent).toContain('A group named "prod" already exists.');
    expect(document.activeElement).not.toBe(document.body);
  });

  it("edits a group's projects", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Edit projects" }));
    expect((screen.getByRole("checkbox", { name: "Dev" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Dev" }));
    await user.click(screen.getByRole("checkbox", { name: "Prod east" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.state.groups[0].project_ids).toEqual(["p3"]));
    expect(api.requests.find((r) => r.method === "PATCH")!.body).toEqual({ project_ids: ["p3"] });
    expect(await screen.findByRole("button", { name: "Edit projects" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit projects" }));
  });

  it("keeps the keyboard on Cancel when there are no projects to tick", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: [], groups: [group("g1", "Prod", [])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Edit projects" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
  });

  it("renames a group", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Live{Enter}");
    await waitFor(() => expect(api.state.groups[0].name).toBe("Live"));
    expect(await screen.findByRole("heading", { name: "Live" })).toBeTruthy();
  });

  it("deleting a group keeps its projects", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1", "p2"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Delete group…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Delete group Prod?" })).toBeTruthy();
    expect(within(dialog).getByText("Its projects stay as they are.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete group" }));
    expect(await screen.findByRole("heading", { name: "Monitoring" })).toBeTruthy();
    expect(api.state.groups).toHaveLength(0);
    expect(api.state.projects).toHaveLength(3);
    // Still in the sidebar.
    const sidebar = document.querySelector("nav, aside") as HTMLElement;
    expect(within(sidebar).getByText("Dev")).toBeTruthy();
    expect(within(sidebar).getByText("Stage")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });
  it("group page lists group dashboards and its delete lists them", async () => {
    const user = userEvent.setup();
    const PROD = { kind: "group" as const, id: "g1", name: "Prod" };
    const api = installFakeMonitoringApi({
      projects: projects(), groups: [group("g1", "Prod", ["p1", "p2"])],
      dashboards: { a1: seedDashboard("a1", PROD, spec("Overview", [])), a2: seedDashboard("a2", PROD, spec("Errors", [])) },
    }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    const list = await screen.findByRole("list", { name: "Dashboards of Prod" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual([
      expect.stringContaining("Errors"), expect.stringContaining("Overview"),
    ]);
    expect(screen.queryByRole("list", { name: "Ready-made views" })).toBeNull();
    expect(screen.queryByText(/No group dashboards yet/)).toBeNull();
    expect(screen.getByRole("button", { name: "New dashboard for Prod" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete group…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Its projects stay as they are.")).toBeTruthy();
    expect(within(dialog).getByText("Its dashboards go with it: Errors, Overview.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete group" }));
    expect(await screen.findByRole("heading", { name: "Monitoring" })).toBeTruthy();
    expect(api.requests.some((r) => r.method === "DELETE" && r.url === "/api/monitoring/groups/g1?token=review-token")).toBe(true);
    expect(api.state.groups).toHaveLength(0);
    expect(Object.keys(api.state.dashboards)).toEqual([]);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("Group delete review and alert rules", () => {
  const groupRule = (id: string, name: string, projectIds: string[]): RuleOut => ({
    id, name, scope: { kind: "group", id: "g1", name: "Prod" }, source_type: "prometheus", source_id: null, expr: "up",
    condition: { of: "each", op: "above", threshold: 5, for: "5m", every: "1m" }, severity: "warning", message: "", contact_points: [],
    engine: "tool", channel: null, paused: false, origin: "page", panel: null, state: "waiting", firing_since: null, removing: false, version: 1,
    created_at: T, updated_at: T,
    targets: projectIds.map((pid) => ({
      id: `t-${id}-${pid}`, project_id: pid, project_name: pid, engine: "tool", tool: "prometheus_rule", where: "x", engine_note: null, state: "waiting",
      state_since: T, last_eval_at: null, message: null, eval_expr: "", rule_text: "", tool_state: "in_sync", tool_message: null, leaving: false, instances: [],
    } as TargetOut)),
  });

  it("group delete lists its rules, names only the clusters they run in, and waits", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({
      projects: [
        { ...seedProject("p1", "Dev", "kubernetes", { id: "c1", provider: "kind" }), cluster_name: "kind-dev" },
        { ...seedProject("p2", "Stage", "kubernetes", { id: "c2", provider: "kind" }), cluster_name: "kind-stage" },
        seedProject("p3", "Prod east"),
      ],
      groups: [group("g1", "Prod", ["p1", "p2", "p3"])],
    }, fallback);
    api.state.rules = [groupRule("r1", "Slow checkout", ["p1"])];
    api.state.ownerRules.g1 = { alert_rules: [{ id: "r1", name: "Slow checkout" }], cluster_rules: [{ id: "r1", name: "Slow checkout" }] };
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Delete group…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Alert rules that go with it: Slow checkout.")).toBeTruthy();
    expect(await within(dialog).findByText("Remove its rules that run in kind-dev first: Slow checkout. Each opens its own review.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Delete group" }).getAttribute("aria-disabled")).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: "Delete group" }));
    expect(api.requests.some((r) => r.method === "DELETE" && r.url.startsWith("/api/monitoring/groups/"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Open rule Slow checkout" }));
    expect(await screen.findByRole("button", { name: "New alert rule" })).toBeTruthy();
  });
});

describe("Group focus and arrival", () => {
  const onMain = () => document.activeElement?.tagName === "MAIN";

  it("after Create group the keyboard is on its heading and the group is never called gone", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects() }, fallback);
    // The tree answers slowly, as a real server can: the new group must not look gone meanwhile.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/monitoring/tree") await new Promise((r) => setTimeout(r, 30));
      return real(url, init);
    });
    renderMonitoringApp({ tabs: tabsWith({ page: "newGroup" }) });
    let saidGone = false;
    const watch = new MutationObserver(() => { if (document.body.textContent?.includes("no longer exists")) saidGone = true; });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    await user.type(await screen.findByLabelText("Name"), "Everything dev");
    await user.click(await screen.findByRole("checkbox", { name: "Dev" }));
    await user.click(screen.getByRole("button", { name: "Create group" }));
    const heading = await screen.findByRole("heading", { name: "Everything dev" });
    await new Promise((r) => setTimeout(r, 50));
    watch.disconnect();
    expect(saidGone).toBe(false);
    expect(document.activeElement).toBe(heading);
  });

  it("the shortcut hands the keyboard to the workspace, in this tab or a new one", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1", "p2"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    const shortcuts = await screen.findByRole("list", { name: "Projects in this group" });
    await user.click(within(shortcuts).getByRole("button", { name: /Dev/ }));
    expect(await screen.findByRole("heading", { name: "Dev" })).toBeTruthy();
    expect(onMain()).toBe(true);

    cleanup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1", "p2"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    const stage = within(await screen.findByRole("list", { name: "Projects in this group" })).getByRole("button", { name: /Stage/ });
    stage.focus();
    fireEvent.click(stage, { ctrlKey: true });
    expect(await screen.findByRole("heading", { name: "Stage" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(onMain()).toBe(true);
  });
});

/** Records every Escape that gets past the page to the document, where the shell's keys live. */
function escapesToDocument() {
  const seen: string[] = [];
  const listen = (e: KeyboardEvent) => { if (e.key === "Escape") seen.push(e.key); };
  document.addEventListener("keydown", listen);
  return { seen, stop: () => document.removeEventListener("keydown", listen) };
}

describe("Esc closes Edit projects", () => {
  it("closes the panel, keeps the projects and returns the keyboard to Edit projects", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Edit projects" }));
    await user.click(screen.getByRole("checkbox", { name: "Stage" }));
    const doc = escapesToDocument();
    await user.keyboard("{Escape}");
    doc.stop();
    expect(screen.queryByRole("checkbox", { name: "Stage" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit projects" })));
    expect(doc.seen).toEqual([]);
    expect(api.state.groups[0].project_ids).toEqual(["p1"]);
  });
});

describe("Groups, states and words", () => {
  it("the New group name error clears on typing", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects() }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "newGroup" }) });
    await user.click(await screen.findByRole("button", { name: "Create group" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a name for the group.");
    await user.type(screen.getByLabelText("Name"), "P");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Edit projects has one Projects heading", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Prod", ["p1"])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Edit projects" }));
    await screen.findByRole("checkbox", { name: "Dev" });
    const page = document.querySelector<HTMLElement>("[data-monitoring-page]")!;
    expect(within(page).getAllByText("Projects")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Pick the projects" })).toBeTruthy();
  });

  it("an empty group says it has no projects", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ projects: projects(), groups: [group("g1", "Empty", [])] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    await user.click(await screen.findByRole("button", { name: "Delete group…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("It has no projects.")).toBeTruthy();
    expect(within(dialog).queryByText("Its projects stay as they are.")).toBeNull();
  });

  it("a group chip shows a member's trouble", async () => {
    const linked = { ...seedProject("p1", "Dev"), links: [{ source_id: "s1", source_name: "Prom", source_type: "prometheus" as const, filter: "", filter_origin: "none" as const, created_by_project: false }] };
    const prom = { id: "s1", name: "Prom", type: "prometheus" as const, reach: "url" as const, url: "http://x", cluster_id: null, cluster_name: null, namespace: null, service: null, port: null, scheme: "http" as const, path_prefix: "",
      auth: { type: "none" as const, username: null, header_name: null, has_password: false, has_token: false, has_api_key: false, has_client_key: false, has_client_cert: false },
      headers: [], has_ca: false, created_by_project_id: null, used_by: [], health: { state: "unknown" as const, message: null, version: null, checked_at: null }, created_at: T, updated_at: T };
    installFakeMonitoringApi({
      sources: [prom],
      projects: [linked, seedProject("p2", "Stage")],
      groups: [group("g1", "Prod", ["p1", "p2"])],
      health: { s1: { state: "down", message: "connection refused", version: null, checked_at: new Date().toISOString() } },
    }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g1" }) });
    const list = await screen.findByRole("list", { name: "Projects in this group" });
    const dev = await within(list).findByRole("button", { name: /Dev/ });
    await waitFor(() => expect(dev.getAttribute("data-health")).toBe("down"));
    expect(within(list).getByRole("button", { name: /Stage/ }).getAttribute("data-health")).toBe("unknown");
    expect(dev.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(dev.getAttribute("aria-describedby") as string)?.textContent).toBe("A source of this project is down.");
  });
});
