import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PanelAlertStateOut } from "../../alerts/api";
import { installFakeMonitoringApi, type FakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { intercept, linkedProject, panel, seedDashboard, serverFailure, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import { editSessions } from "../editor/useDashboardEditor";
import { newAlert, type DashboardSpec, type PanelSpec } from "../schema";

vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const alerting = (p: PanelSpec, threshold = 0.3): PanelSpec => ({ ...p, alert: newAlert(p, threshold) });
const doc = (): DashboardSpec => spec("API latency", [
  alerting(panel("p-1", "Requests", "up", { x: 0, y: 0, w: 12, h: 8 })),
  alerting(panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 })),
  panel("p-3", "Latency", "up", { x: 0, y: 8, w: 12, h: 8 }),
]);
const state = (rule_id: string, name: string, s: PanelAlertStateOut["state"]): PanelAlertStateOut =>
  ({ rule_id, name, state: s, since: "2026-01-01T00:00:00Z" });

function shop(more: Partial<FakeMonitoringState> = {}): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc()) },
    queryAnswers: { up: ok, errors: ok },
    panelStates: { d1: { "p-1": state("r1", "Slow requests", "firing"), "p-2": state("r2", "Errors", "ok") } },
    ...more,
  }, async () => json([]));
}

const frame = (id: string) => document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)!;

describe("Panel alert badges", () => {
  it("the badge shows the worst state and opens the rule", async () => {
    shop();
    const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const firing = await screen.findByRole("button", { name: 'Alert "Slow requests": Firing' });
    expect(firing.textContent).toBe("● Firing");
    expect(within(frame("p-1")).getByRole("button", { name: /^Alert / })).toBe(firing);
    expect((await within(frame("p-2")).findByRole("button", { name: 'Alert "Errors": OK' })).textContent).toBe("● OK");
    // A panel without an alert wears nothing.
    expect(within(frame("p-3")).queryByText(/●/)).toBeNull();

    // Ctrl+click: the rule in a new workspace tab; a plain click here.
    fireEvent.click(firing, { ctrlKey: true });
    expect(app.current().tabs.map((t) => t.view)).toContainEqual({ page: "alerts", rule: "r1" });
    expect(app.current().tabs).toHaveLength(2);
    cleanup();

    const again = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    fireEvent.click(await screen.findByRole("button", { name: 'Alert "Slow requests": Firing' }));
    await waitFor(() => expect(again.current().tabs[0].view).toEqual({ page: "alerts", rule: "r1" }));
    expect(again.current().tabs[0].back).toHaveLength(1);
  });

  it("a state that isn't known is never shown as OK", async () => {
    shop({ panelStates: { d1: {} } });
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const waiting = await screen.findByRole("img", { name: 'Alert "Requests": Loading' });
    expect(frame("p-1").contains(waiting)).toBe(true);
    expect(waiting.textContent).toBe("● Loading");
    cleanup();

    shop();
    intercept((url) => (url.startsWith("/api/monitoring/alerts/panel-states") ? serverFailure(500, "bad_request", "The console's database didn't answer.") : null));
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const unknown = await screen.findByRole("img", { name: 'Alert "Requests": Unknown' });
    expect(unknown.textContent).toBe("● Unknown");
    expect(screen.queryByText("● OK")).toBeNull();
  });

  it("a changed draft alert says not saved yet", async () => {
    shop();
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await screen.findByRole("button", { name: 'Alert "Slow requests": Firing' });
    await user.keyboard("e");
    await screen.findByRole("button", { name: "Save dashboard" });
    // In edit mode an unchanged alert still shows its state.
    expect(within(frame("p-1")).getByRole("button", { name: 'Alert "Slow requests": Firing' })).toBeTruthy();
    await user.keyboard("{Enter}");
    const aside = await screen.findByRole("complementary", { name: "Panel settings" });
    await user.click(within(aside).getByRole("tab", { name: "Alert" }));
    const threshold = within(aside).getByRole("textbox", { name: "Threshold" });
    await user.clear(threshold);
    await user.type(threshold, "0.6");
    const pill = within(frame("p-1")).getByRole("img", { name: 'Alert "Requests": not saved yet' });
    expect(pill.textContent).toBe("● Alert: not saved yet");
    expect(within(frame("p-2")).getByRole("button", { name: 'Alert "Errors": OK' })).toBeTruthy();
    // Removed from the draft: not saved yet either, until the save.
    await user.click(within(aside).getByRole("button", { name: "Remove alert" }));
    expect(within(frame("p-1")).getByRole("img", { name: 'Alert "Requests": not saved yet' })).toBeTruthy();
    expect(document.activeElement).toBe(within(aside).getByRole("button", { name: "Add an alert" }));
    expect(within(aside).getByText("Removing the alert deletes its rule when you save.")).toBeTruthy();
  });

  it("a link to a panel scrolls it into view and flashes it", async () => {
    shop();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push((this as HTMLElement).dataset.panelId ?? ""); });
    const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1", panel: "p-3" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    await waitFor(() => expect(scrolled).toEqual(["p-3"]));
    expect(frame("p-3").dataset.spot).toBe("true");
    expect(frame("p-1").dataset.spot).toBeUndefined();
    // Done once: the view no longer asks for it, and edit mode didn't start.
    expect(app.current().tabs[0].view).toEqual({ page: "dashboard", id: "d1" });
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });
});
