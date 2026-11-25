import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut } from "../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import { editSessions } from "../dashboards/editor/useDashboardEditor";
import type { ExportOut } from "./api";

// The browser's download, as a spy: the file the export would save.
const saveJsonFile = vi.hoisted(() => vi.fn());
vi.mock("./download", () => ({ saveJsonFile }));

// The chart chunk as a stub.
vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); saveJsonFile.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const BOTH: GroupOut = { id: "g1", name: "Both", project_ids: ["p1"], created_at: T, updated_at: T };

const exported = (file_name: string, dashboards: number, sources: number): ExportOut => ({
  file_name, export: { formatVersion: 1, kind: "dashboard", dashboards: [] }, dashboards, sources, alerts: 0,
});

function seed(exports: Record<string, ExportOut> = {}): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "shop", "s1")],
    groups: [BOTH],
    dashboards: { d1: seedDashboard("d1", SHOP, spec("API latency", [panel("p-1", "Requests", "up")])) },
    queryAnswers: { up: ok },
    transfer: { exports },
  }, async () => json([]));
}
const exportsOf = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/export").map((r) => r.body);

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions" }));
  return screen.getByRole("menu", { name: "More actions" });
}

describe("Export", () => {
  it("exporting a dashboard saves the file and says secrets aren't in it", async () => {
    const file = exported("api-latency.omnikrux.json", 1, 1);
    const api = seed({ "dashboard:d1": file });
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Export as JSON" }));
    await waitFor(() => expect(saveJsonFile).toHaveBeenCalledWith("api-latency.omnikrux.json", file.export));
    expect(exportsOf(api)).toEqual([{ kind: "dashboard", id: "d1" }]);
    const status = screen.getAllByRole("status").find((el) => el.textContent?.startsWith("Exported"));
    expect(status?.textContent).toBe('Exported "API latency". Passwords and tokens are never in exports.');
    // The keyboard goes back to More actions.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("project and group exports report counts", async () => {
    const api = seed({
      "project:p1": exported("shop.omnikrux.json", 3, 2),
      "group:g1": exported("both.omnikrux.json", 2, 0),
    });
    const user = userEvent.setup();
    const app = renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p1" }) });
    const heading = await screen.findByRole("heading", { level: 2, name: "Dashboards" });
    const row = heading.parentElement as HTMLElement;
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Export project", "Import dashboards…"]);
    await user.click(within(row).getByRole("button", { name: "Export project" }));
    await waitFor(() => expect(saveJsonFile).toHaveBeenCalledWith("shop.omnikrux.json", expect.anything()));
    expect(await screen.findByText("Exported shop: 3 dashboards and 2 sources. Passwords and tokens are never in exports.")).toBeTruthy();
    expect(screen.getByText(/^Exported shop/).getAttribute("role")).toBe("status");

    // Import dashboards… opens Import for this project, in this tab.
    await user.click(within(row).getByRole("button", { name: "Import dashboards…" }));
    await waitFor(() => expect(app.current().tabs[0].view).toEqual({ page: "import", target: { kind: "project", id: "p1" } }));

    app.navigate({ page: "group", id: "g1" }, "push");
    const groupHeading = await screen.findByRole("heading", { level: 2, name: "Dashboards" });
    const groupRow = groupHeading.parentElement as HTMLElement;
    expect(within(groupRow).getAllByRole("button").map((b) => b.textContent)).toEqual(["Export group", "Import dashboards…"]);
    await user.click(within(groupRow).getByRole("button", { name: "Export group" }));
    expect(await screen.findByText("Exported Both: 2 dashboards.")).toBeTruthy();
    expect(saveJsonFile).toHaveBeenLastCalledWith("both.omnikrux.json", expect.anything());
    expect(exportsOf(api)).toEqual([{ kind: "project", id: "p1" }, { kind: "group", id: "g1" }]);

    await user.click(within(groupRow).getByRole("button", { name: "Import dashboards…" }));
    await waitFor(() => expect(app.current().tabs[0].view).toEqual({ page: "import", target: { kind: "group", id: "g1" } }));
  });

  it("a failed export shows its words", async () => {
    seed();
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    await user.click(within(await openMenu(user)).getByRole("menuitem", { name: "Export as JSON" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That dashboard, project or group no longer exists.");
    expect(saveJsonFile).not.toHaveBeenCalled();
    expect(screen.getAllByRole("status").some((el) => el.textContent?.startsWith("Exported"))).toBe(false);

    // On the project page too, under its heading.
    cleanup();
    seed();
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p1" }) });
    await user.click(await screen.findByRole("button", { name: "Export project" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That dashboard, project or group no longer exists.");
    expect(saveJsonFile).not.toHaveBeenCalled();
  });
});
