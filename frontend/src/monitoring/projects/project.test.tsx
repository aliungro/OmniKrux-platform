import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut, LinkOut, ProjectOut, SourceOut } from "../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";

beforeEach(() => localStorage.clear());
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
    expect(within(document.querySelector("[data-monitoring-page]") as HTMLElement).getByText("Dashboards arrive in the next update.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Prod" }));
    expect(await screen.findByRole("heading", { name: "Prod" })).toBeTruthy();
  });
});

describe("Project delete review", () => {
  const withEverything = () => {
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
    }, fallback);
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
