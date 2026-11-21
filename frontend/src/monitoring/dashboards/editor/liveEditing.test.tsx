import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { stubMotion } from "../../charts/panelFixtures";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { DashboardSpec } from "../schema";
import { editSessions } from "./useDashboardEditor";

// The chart chunk as a stub that counts its renders per panel and shows what it was given.
const seen = vi.hoisted(() => ({ renders: {} as Record<string, number> }));
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  type Props = { panel: { id: string; options: { unit?: string } }; data: { series: unknown[] }; changeId: number; animate: boolean };
  return {
    default: ({ panel: p, data, changeId, animate }: Props) => {
      seen.renders[p.id] = (seen.renders[p.id] ?? 0) + 1;
      return createElement("span", {
        "data-testid": `chart-${p.id}`, "data-unit": p.options.unit ?? "", "data-change": changeId, "data-animate": String(animate),
      }, `chart ${data.series.length}`);
    },
  };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); seen.renders = {}; stubMotion(false); });
afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const two = {
  result_type: "matrix" as const, took_ms: 41,
  series: [
    { labels: { route: "/a" }, points: [[1, 1], [2, 2], [3, 3]] as [number, number][] },
    { labels: { route: "/b" }, points: [[1, 1], [2, 2]] as [number, number][] },
  ],
};

const doc = (): DashboardSpec => spec("API latency", [
  panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 }),
  panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 }),
]);

function shop(): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc()) },
    queryAnswers: { up: two, errors: two, up1: two, up12: two, up123: two, upx: two },
  }, async () => json([]));
}

type Batch = { queries: { query: string; project_id: string }[] };
const batches = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/query/batch").map((r) => r.body as Batch);
const panels = () => screen.getByRole("group", { name: "Panels" });
const tile = (title: string) => {
  const found = within(panels()).getAllByRole("region").find((t) => t.getAttribute("aria-label")?.startsWith(`${title},`));
  if (!found) throw new Error(`no tile ${title}`);
  return found;
};
type Item = { query: string; project_id: string; limit?: number };
const lastLimit = (api: FakeMonitoringApi) => (batches(api).at(-1)?.queries[0] as Item | undefined)?.limit;
const settings = () => screen.getByRole("complementary", { name: "Panel settings" });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Only the debounce and flash timers are fake; promises and the page's own scheduling stay real. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

async function openSettings(api = shop()) {
  const user = userEvent.setup();
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText("chart 2");
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  await user.keyboard("{Enter}");
  await screen.findByRole("complementary", { name: "Panel settings" });
  return { user, api };
}

describe("Live editing", () => {
  it("typing runs the query once after 300 ms", async () => {
    const { api } = await openSettings();
    const field = within(settings()).getByRole("textbox", { name: "Query A" });
    const before = batches(api).length;
    fakeTimers();
    fireEvent.change(field, { target: { value: "up1" } });
    advance(100);
    fireEvent.change(field, { target: { value: "up12" } });
    advance(100);
    fireEvent.change(field, { target: { value: "up123" } });
    advance(299);
    expect(within(settings()).getByText("Waiting for you to stop typing…")).toBeTruthy();
    expect(batches(api)).toHaveLength(before);
    advance(1);
    vi.useRealTimers();
    await waitFor(() => expect(batches(api)).toHaveLength(before + 1));
    expect(batches(api)[before].queries.map((q) => q.query)).toEqual(["up123"]);
    await pause(350);
    expect(batches(api)).toHaveLength(before + 1);
    // The draft took every keystroke at once (so JSON and the draft agree).
    const s = editSessions.get("start0");
    expect(s?.mode === "edit" && s.draft.panels[0].queries[0].expr).toBe("up123");
  });

  it("Ctrl+Enter runs at once", async () => {
    const { api } = await openSettings();
    const field = within(settings()).getByRole("textbox", { name: "Query A" });
    const before = batches(api).length;
    fakeTimers();
    fireEvent.change(field, { target: { value: "upx" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    // No timer ran: the run left at once.
    vi.useRealTimers();
    await waitFor(() => expect(batches(api)).toHaveLength(before + 1));
    expect(batches(api)[before].queries.map((q) => q.query)).toEqual(["upx"]);
    expect(within(settings()).queryByText("Waiting for you to stop typing…")).toBeNull();
    await pause(350);
    expect(batches(api)).toHaveLength(before + 1);
  });

  it("option changes redraw without a query", async () => {
    const { user, api } = await openSettings();
    await user.click(within(settings()).getByRole("tab", { name: "Options" }));
    const before = batches(api).length;
    await user.selectOptions(within(settings()).getByRole("combobox", { name: "Unit" }), "Seconds");
    expect(screen.getByTestId("chart-p-1").getAttribute("data-unit")).toBe("s");
    expect(screen.getByTestId("chart-p-1").getAttribute("data-animate")).toBe("true");
    expect(Number(screen.getByTestId("chart-p-1").getAttribute("data-change"))).toBeGreaterThan(0);
    await pause(350);
    expect(batches(api)).toHaveLength(before);
  });

  it("only the edited panel re-renders", async () => {
    const { user } = await openSettings();
    await user.click(within(settings()).getByRole("tab", { name: "Options" }));
    const p1 = seen.renders["p-1"];
    const p2 = seen.renders["p-2"];
    expect(p2).toBeGreaterThan(0);
    await user.type(within(settings()).getByRole("textbox", { name: "Title" }), " now");
    await user.selectOptions(within(settings()).getByRole("combobox", { name: "Unit" }), "Seconds");
    expect(tile("Requests now")).toBeTruthy();
    expect(seen.renders["p-1"]).toBeGreaterThan(p1);
    expect(seen.renders["p-2"]).toBe(p2);
  });

  it("the edited panel flashes, and not under reduced motion's fade", async () => {
    await openSettings();
    fireEvent.click(within(settings()).getByRole("tab", { name: "Options" }));
    const title = within(settings()).getByRole("textbox", { name: "Title" });
    expect(tile("Requests").className).not.toMatch(/flash/);
    fakeTimers();
    fireEvent.change(title, { target: { value: "Requests!" } });
    const edited = tile("Requests!");
    expect(edited.className).toMatch(/flash/);
    expect(edited.getAttribute("data-motion")).toBeNull();
    expect(tile("Errors").className).not.toMatch(/flash/);
    advance(449);
    expect(tile("Requests!").className).toMatch(/flash/);
    advance(2);
    expect(tile("Requests!").className).not.toMatch(/flash/);
    vi.useRealTimers();
  });

  it("under reduced motion there is no highlight", async () => {
    stubMotion(true);
    await openSettings();
    fireEvent.click(within(settings()).getByRole("tab", { name: "Options" }));
    fakeTimers();
    fireEvent.change(within(settings()).getByRole("textbox", { name: "Title" }), { target: { value: "Calm" } });
    expect(tile("Calm").className).not.toMatch(/flash/);
    expect(tile("Calm").getAttribute("data-motion")).toBe("off");
    expect(screen.getByTestId("chart-p-1").getAttribute("data-animate")).toBe("false");
    advance(451);
    expect(tile("Calm").className).not.toMatch(/flash/);
    vi.useRealTimers();
  });

  it("a logs panel's Lines run once the typing stops, or at once with Ctrl+Enter", async () => {
    const { user, api } = await openSettings();
    await user.click(within(settings()).getByRole("tab", { name: "Chart" }));
    const runs = batches(api).length;
    await user.click(within(settings()).getByRole("radio", { name: "Logs" }));
    // A new type runs at once, with that type's request.
    await waitFor(() => expect(batches(api)).toHaveLength(runs + 1));
    expect(lastLimit(api)).toBe(100);
    const lines = within(settings()).getByRole("textbox", { name: "Lines" });
    const before = batches(api).length;
    fakeTimers();
    fireEvent.change(lines, { target: { value: "5" } });
    advance(100);
    fireEvent.change(lines, { target: { value: "50" } });
    advance(100);
    fireEvent.change(lines, { target: { value: "500" } });
    advance(299);
    expect(batches(api)).toHaveLength(before);
    advance(1);
    vi.useRealTimers();
    await waitFor(() => expect(batches(api)).toHaveLength(before + 1));
    expect(lastLimit(api)).toBe(500);
    await pause(350);
    expect(batches(api)).toHaveLength(before + 1);

    fakeTimers();
    fireEvent.change(lines, { target: { value: "250" } });
    fireEvent.keyDown(lines, { key: "Enter", ctrlKey: true });
    vi.useRealTimers();
    await waitFor(() => expect(batches(api)).toHaveLength(before + 2));
    expect(lastLimit(api)).toBe(250);
    await pause(350);
    expect(batches(api)).toHaveLength(before + 2);
  });

  it("saving within 300 ms of typing runs the saved text, never a partial one", async () => {
    const { api } = await openSettings();
    const field = within(settings()).getByRole("textbox", { name: "Query A" });
    const before = batches(api).length;
    fireEvent.change(field, { target: { value: "up1" } });
    fireEvent.change(field, { target: { value: "up12" } });
    fireEvent.keyDown(field, { key: "s", ctrlKey: true });
    await screen.findByRole("button", { name: "Edit" });
    await pause(400);
    const sent = batches(api).slice(before).flatMap((b) => b.queries.map((q) => q.query)).filter((q) => q !== "errors");
    expect(sent).not.toContain("up1");
    expect(sent.at(-1)).toBe("up12");
    expect(api.state.dashboards.d1.out.spec.panels[0].queries[0].expr).toBe("up12");
  });

  it("discarding within 300 ms of typing runs the saved text again, never the discarded one", async () => {
    const { api } = await openSettings();
    const field = within(settings()).getByRole("textbox", { name: "Query A" });
    const before = batches(api).length;
    fireEvent.change(field, { target: { value: "upx" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    await screen.findByRole("button", { name: "Edit" });
    await pause(400);
    const sent = batches(api).flatMap((b) => b.queries.map((q) => q.query)).filter((q) => q !== "errors");
    expect(sent.slice(before)).not.toContain("upx");
    expect(sent.at(-1)).toBe("up");
  });

  it("the run line shows series, points and time", async () => {
    await openSettings();
    const line = await within(settings()).findByText("2 series · 5 points · 41 ms");
    expect(line).toBeTruthy();
  });
});
