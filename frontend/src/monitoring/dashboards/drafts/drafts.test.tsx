import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { DashboardSpec } from "../schema";
import { editSessions } from "../editor/useDashboardEditor";
import { writeDraft } from "./draftStore";

// The chart chunk as a stub.
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

// Edit sessions outlive the page (switching app and back resumes them); each test starts clean.
beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const KEY = "omnikrux.monitoring.draft.d1";
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as { baseVersion: number; savedAt: number; draft: DashboardSpec; jsonText: string | null } | null;
const two = (n: number) => String(n).padStart(2, "0");
const hhmm = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

const doc = (): DashboardSpec => spec("API latency", [
  panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 }),
  panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 }),
]);

function shop(version = 1): FakeMonitoringApi {
  const d = seedDashboard("d1", SHOP, doc());
  d.out.version = version;
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: d },
    queryAnswers: { up: ok, errors: ok },
  }, async () => json([]));
}

const puts = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "PUT" && r.url.startsWith("/api/monitoring/dashboards/"));
const panels = () => screen.getByRole("group", { name: "Panels" });
const tile = (title: string) => {
  const found = within(panels()).getAllByRole("region").find((t) => t.getAttribute("aria-label")?.startsWith(`${title},`));
  if (!found) throw new Error(`no tile ${title}`);
  return found;
};
const notBody = () => expect(document.activeElement).not.toBe(document.body);

/** The dashboard open in tab start0, with the keyboard on its title. */
async function opened() {
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText("chart 1");
  return { app, title };
}

async function editing() {
  const user = userEvent.setup();
  const out = await opened();
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  return { user, ...out };
}

/** Renames the first panel from its settings (Options, Title). */
async function renameFirst(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.keyboard("{Enter}");
  const aside = await screen.findByRole("complementary", { name: "Panel settings" });
  await user.click(within(aside).getByRole("tab", { name: "Options" }));
  const field = within(aside).getByRole("textbox", { name: "Title" });
  await user.clear(field);
  await user.type(field, title);
}

describe("Dashboard drafts", () => {
  it("an edit is stored after 500 ms and removed on save", async () => {
    const api = shop();
    const { user } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 2, row 1");
    await new Promise((r) => setTimeout(r, 300));
    expect(localStorage.getItem(KEY)).toBeNull();
    await waitFor(() => expect(stored()).not.toBeNull(), { timeout: 1500 });
    expect(stored()).toMatchObject({ v: 1, dashboardId: "d1", baseVersion: 1, jsonText: null });
    expect(stored()!.draft.panels[0].layout.x).toBe(1);

    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    await waitFor(() => expect(screen.queryByText("Editing")).toBeNull());
    expect(puts(api)).toHaveLength(1);
    expect(localStorage.getItem(KEY)).toBeNull();
    notBody();
  });

  it("a pending draft is written at once when the page is hidden", async () => {
    shop();
    const { user } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(localStorage.getItem(KEY)).toBeNull();
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()?.draft.panels[0].layout.x).toBe(1);
  });

  it("reopening offers the draft back and Restore draft resumes editing", async () => {
    shop();
    const { user, app } = await editing();
    await renameFirst(user, "Requests per second");
    await waitFor(() => expect(stored()?.draft.panels[0].title).toBe("Requests per second"), { timeout: 1500 });
    // A reload: the page and its memory go, the draft stays.
    app.unmount();
    editSessions.clear();
    const savedAt = stored()!.savedAt;

    const { title } = await opened();
    const banner = screen.getByRole("region", { name: "Unsaved draft" });
    expect(banner.textContent).toContain(`You have unsaved changes from ${hhmm(savedAt)}.`);
    expect(banner.textContent).not.toContain("saved again");
    expect(screen.queryByText("Editing")).toBeNull();
    expect(document.activeElement).toBe(title);
    // The banner's buttons come right after the title.
    await user.tab();
    expect(document.activeElement).toBe(within(banner).getByRole("button", { name: "Restore draft" }));
    await user.tab();
    expect(document.activeElement).toBe(within(banner).getByRole("button", { name: "Discard draft" }));

    await user.click(within(banner).getByRole("button", { name: "Restore draft" }));
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(tile("Requests per second")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Unsaved draft" })).toBeNull();
    notBody();
    // Restoring changes nothing in storage: the draft keeps its time.
    await new Promise((r) => setTimeout(r, 600));
    expect(stored()?.savedAt).toBe(savedAt);
  });

  it("an older draft says the dashboard was saved again", async () => {
    const api = shop(2);
    const draft = doc();
    draft.panels[0].title = "Requests per second";
    const savedAt = new Date(2026, 2, 3, 9, 5).getTime();
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 1, savedAt, draft, jsonText: "{ half" });
    const user = userEvent.setup();
    await opened();
    const banner = screen.getByRole("region", { name: "Unsaved draft" });
    expect(banner.textContent).toContain("You have unsaved changes from 3 Mar 09:05.");
    expect(banner.textContent).toContain("The dashboard was saved again since then (version 2).");

    // Restored, its base stays version 1: saving goes through the conflict review.
    await user.click(within(banner).getByRole("button", { name: "Restore draft" }));
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(tile("Requests per second")).toBeTruthy();
    const s = editSessions.get("start0");
    expect(s?.mode === "edit" && s.baseVersion).toBe(1);
    // The kept JSON text shows its problems again.
    expect(s?.mode === "edit" && s.jsonProblems.length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    expect(await screen.findByRole("button", { name: "Review differences" })).toBeTruthy();
    expect(puts(api)).toHaveLength(1);
    expect(api.state.dashboards.d1.out.version).toBe(2);
    expect(stored()).not.toBeNull();

    // Opened again without the session, Discard draft removes it; the keyboard stays on the title.
    cleanup();
    editSessions.clear();
    const again = await opened();
    await user.click(within(screen.getByRole("region", { name: "Unsaved draft" })).getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByRole("region", { name: "Unsaved draft" })).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.activeElement).toBe(again.title);
  });

  it("switching app and back resumes edit mode without the banner", async () => {
    shop();
    const { user, app } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    // Switching app unmounts the app: the pending draft is written at once.
    app.unmount();
    expect(stored()?.draft.panels[0].layout.x).toBe(1);

    const { title } = await opened();
    expect(screen.getByText("Editing")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Unsaved draft" })).toBeNull();
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 2, row 1");
    expect(document.activeElement).toBe(title);
  });

  it("blocked storage shows the warning in the edit bar", async () => {
    shop();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const { user } = await editing();
    expect(screen.getByText("This browser isn't keeping drafts, so a reload loses unsaved changes.")).toBeTruthy();
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Nothing to lose yet: a reload isn't held.
    expect(unload()).toBe(false);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await waitFor(() => expect(unload()).toBe(true));
    // Discarded, there is nothing left to lose.
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByText("Editing")).toBeNull());
    expect(unload()).toBe(false);
    expect(screen.queryByText("This browser isn't keeping drafts, so a reload loses unsaved changes.")).toBeNull();
  });
});
