import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { gate, linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
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
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as { baseVersion: number; savedAt: number; draft: DashboardSpec; jsonText: string | null; writer: string } | null;
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
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 1, savedAt, draft, jsonText: "{ half", writer: "elsewhere" });
    const user = userEvent.setup();
    await opened();
    const banner = screen.getByRole("region", { name: "Unsaved draft" });
    expect(banner.textContent).toContain("You have unsaved changes from 3 Mar 09:05.");
    expect(banner.textContent).toContain("The dashboard was saved again since then (version 2).");

    // Restored, its base stays version 1 (a save goes through the conflict review: jsonTab.test).
    await user.click(within(banner).getByRole("button", { name: "Restore draft" }));
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(tile("Requests per second")).toBeTruthy();
    const s = editSessions.get("start0");
    expect(s?.mode === "edit" && s.baseVersion).toBe(1);
    // The kept JSON text shows its problems again.
    expect(s?.mode === "edit" && s.jsonProblems.length).toBeGreaterThan(0);
    // While that text doesn't apply, Save is refused (saving the last valid draft would drop it).
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    expect(await screen.findByText("The JSON has a problem. Fix it or discard it before saving.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show in JSON" })).toBeTruthy();
    expect(puts(api)).toHaveLength(0);
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

describe("Drafts across tabs, windows and saves", () => {
  const D1 = { page: "dashboard" as const, id: "d1" };
  const dashboardTabs = () => within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab");
  const foreign = (over: { title?: string; savedAt?: number; writer?: string } = {}) => {
    const draft = doc();
    draft.panels[0].title = over.title ?? "Requests per second";
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 1, savedAt: over.savedAt ?? new Date(2026, 2, 3, 9, 5).getTime(), draft, jsonText: null, writer: over.writer ?? "w-other" });
  };

  it("a second tab on the same dashboard is sent to the tab editing it", async () => {
    shop();
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith(D1, D1) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    await screen.findAllByText("chart 1");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await waitFor(() => expect(stored()).not.toBeNull(), { timeout: 1500 });

    await user.click(dashboardTabs()[1]);
    await screen.findAllByText("chart 1");
    // The other tab's changes are not offered here as a draft: they are being edited.
    expect(screen.queryByRole("region", { name: "Unsaved draft" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("This dashboard is being edited in another tab.")).toBeTruthy();
    expect(screen.queryByText("Editing")).toBeNull();
    expect(editSessions.has("start1")).toBe(false);
    const go = screen.getByRole("button", { name: "Go to that tab" });
    expect(document.activeElement).toBe(go);
    await user.click(go);
    await waitFor(() => expect(dashboardTabs()[0].getAttribute("aria-selected")).toBe("true"));
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 2, row 1");
    await waitFor(notBody);
  });

  it("Go to that tab asks again: with that tab gone, editing starts here", async () => {
    shop();
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith(D1, D1) });
    await screen.findAllByText("chart 1");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(dashboardTabs()[1]);
    await screen.findAllByText("chart 1");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("This dashboard is being edited in another tab.")).toBeTruthy();
    // The editing tab closes (nothing changed there, so nothing is asked).
    await user.click(screen.getAllByRole("button", { name: "Close API latency" })[0]);
    await waitFor(() => expect(dashboardTabs()).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Go to that tab" }));
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(screen.queryByText("This dashboard is being edited in another tab.")).toBeNull();
    expect(editSessions.has("start1")).toBe(true);
    await waitFor(notBody);
  });

  it("a tab closed without changes leaves no session behind", async () => {
    shop();
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith(D1, D1) });
    await screen.findAllByText("chart 1");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(editSessions.has("start0")).toBe(true);
    // Meanwhile another window keeps a draft of this dashboard.
    foreign();
    await user.click(screen.getAllByRole("button", { name: "Close API latency" })[0]);
    await waitFor(() => expect(dashboardTabs()).toHaveLength(1));
    expect(editSessions.size).toBe(0);
    expect(await screen.findByRole("region", { name: "Unsaved draft" })).toBeTruthy();
  });

  it("Edit starts from a stored draft once Restore draft is pressed; after Discard draft it starts afresh", async () => {
    shop();
    const savedAt = new Date(2026, 2, 3, 9, 5).getTime();
    foreign({ savedAt });
    const user = userEvent.setup();
    await opened();
    const banner = screen.getByRole("region", { name: "Unsaved draft" });
    expect(within(banner).getByRole("button", { name: "Restore draft" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore draft" }));
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(tile("Requests per second")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Unsaved draft" })).toBeNull();
    // The draft is this session's now, and keeps when it last changed.
    expect(stored()?.writer).not.toBe("w-other");
    expect(stored()?.savedAt).toBe(savedAt);
    cleanup();
    editSessions.clear();

    await opened();
    await user.click(within(screen.getByRole("region", { name: "Unsaved draft" })).getByRole("button", { name: "Discard draft" }));
    await user.keyboard("e");
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(tile("Requests")).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("Edit while a draft is offered asks for a choice", async () => {
    shop();
    foreign({ savedAt: new Date(2026, 2, 3, 9, 5).getTime() });
    const user = userEvent.setup();
    await opened();
    const banner = screen.getByRole("region", { name: "Unsaved draft" });
    expect(within(banner).queryByText("Restore the draft or discard it before editing.")).toBeNull();
    // Edit by key, then by the button: the keyboard goes to Restore draft, and nothing else happens.
    for (const press of [() => user.keyboard("e"), () => user.click(screen.getByRole("button", { name: "Edit" }))]) {
      await press();
      expect(within(banner).getByText("Restore the draft or discard it before editing.")).toBeTruthy();
      expect(document.activeElement).toBe(within(banner).getByRole("button", { name: "Restore draft" }));
      expect(screen.queryByText("Editing")).toBeNull();
      expect(screen.queryByRole("button", { name: "Save dashboard" })).toBeNull();
      expect(stored()?.writer).toBe("w-other");
      notBody();
    }
    // Discard draft clears the banner and its note; Edit then starts afresh.
    await user.click(within(banner).getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByText("Restore the draft or discard it before editing.")).toBeNull();
    await user.keyboard("e");
    expect(await screen.findByText("Editing")).toBeTruthy();
    expect(tile("Requests")).toBeTruthy();
  });

  it("another window removing or replacing the draft: the newest changes stay stored", async () => {
    shop();
    const { user } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await waitFor(() => expect(stored()).not.toBeNull(), { timeout: 1500 });
    const mine = JSON.parse(localStorage.getItem(KEY)!) as { writer: string; savedAt: number };
    const fromElsewhere = () => act(() => { window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: localStorage.getItem(KEY) })); });

    // Another window saved or discarded its own and removed the entry: ours is written again.
    localStorage.removeItem(KEY);
    fromElsewhere();
    expect(stored()).toMatchObject({ writer: mine.writer, savedAt: mine.savedAt });
    expect(stored()!.draft.panels[0].layout.x).toBe(1);
    // An older draft from another window is replaced by ours.
    foreign({ savedAt: mine.savedAt - 1000 });
    fromElsewhere();
    expect(stored()?.writer).toBe(mine.writer);
    // A newer one wins: the last dirty writer.
    foreign({ savedAt: mine.savedAt + 1000 });
    fromElsewhere();
    expect(stored()?.writer).toBe("w-other");
    // Having lost, this session doesn't take over again on the next event: a third window's draft,
    // newer than this session's last change, stays too.
    foreign({ savedAt: mine.savedAt + 500, writer: "w-third" });
    fromElsewhere();
    expect(stored()?.writer).toBe("w-third");
    fromElsewhere();
    expect(stored()?.writer).toBe("w-third");
    // Until this session changes something again.
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await waitFor(() => expect(stored()?.writer).toBe(mine.writer), { timeout: 1500 });
    expect(stored()!.draft.panels[0].layout.x).toBe(2);
  });

  it("a change made while a save is on its way stays in edit mode over the saved version", async () => {
    const api = shop();
    const held = gate();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") await held.opened;
      return inner(input, init);
    }));
    const { user } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    // Still on its way: another change.
    await user.click(tile("Requests"));
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 3, row 1");
    held.open();
    await waitFor(() => expect(api.state.dashboards.d1.out.version).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("Editing")).toBeTruthy();
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 3, row 1");
    // The stored draft follows: the newer change, over version 2.
    await waitFor(() => expect(stored()).toMatchObject({ baseVersion: 2 }), { timeout: 1500 });
    expect(stored()!.draft.panels[0].layout.x).toBe(2);

    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    await waitFor(() => expect(screen.queryByText("Editing")).toBeNull());
    expect(puts(api).map((r) => (r.body as { base_version: number }).base_version)).toEqual([1, 2]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
