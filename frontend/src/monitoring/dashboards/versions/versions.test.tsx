import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeDashboard, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { DashboardSpec } from "../schema";
import { draftTime } from "../drafts/DraftBanner";
import { writeDraft } from "../drafts/draftStore";
import { editSessions } from "../editor/useDashboardEditor";

// The chart chunk as a stub.
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

// CodeMirror doesn't run in jsdom: the diff draws both sides as text.
vi.mock("../../../features/actions/lazyCodeMirror", () => ({
  loadCodeMirror: () => Promise.resolve({
    mergeView: (parent: HTMLElement, before: string, after: string) => {
      const a = document.createElement("pre");
      a.dataset.testid = "diff-before";
      a.textContent = before;
      const b = document.createElement("pre");
      b.dataset.testid = "diff-after";
      b.textContent = after;
      parent.append(a, b);
      return { destroy: () => parent.replaceChildren() };
    },
    editor: (parent: HTMLElement, doc: string, onChange: (text: string) => void, label: string) => {
      const area = document.createElement("textarea");
      area.value = doc;
      area.setAttribute("aria-label", label);
      area.addEventListener("input", () => onChange(area.value));
      parent.append(area);
      return { focus: () => area.focus(), destroy: () => area.remove() };
    },
  }),
}));

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const T1 = "2026-03-01T08:00:00Z";
const T2 = "2026-03-02T09:30:00Z";
const T3 = "2026-03-03T10:45:00Z";

/** Version 1 (copied), 2 (saved: a second panel), 3 (restored from 1: one panel again, renamed). */
const v1 = (): DashboardSpec => spec("API latency", [panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 })]);
const v2 = (): DashboardSpec => spec("API latency", [
  panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 }),
  panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 }),
]);
const v3 = (): DashboardSpec => spec("API latency", [panel("p-1", "Requests per second", "up", { x: 0, y: 0, w: 8, h: 8 })]);

function history(): FakeDashboard {
  const d = seedDashboard("d1", SHOP, v3());
  d.out.version = 3;
  const row = (version: number, saved_at: string, s: DashboardSpec, origin: "copied" | "saved" | "restored", extra = {}) => ({
    out: { version, saved_at, title: s.title, panel_count: s.panels.length, origin, restored_from: null, copied_from: null, ...extra },
    spec: s,
  });
  d.versions = [
    row(1, T1, v1(), "copied", { copied_from: "Old API" }),
    row(2, T2, v2(), "saved"),
    row(3, T3, v3(), "restored", { restored_from: 1 }),
  ];
  return d;
}

function shop(): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: history() },
    queryAnswers: { up: ok, errors: ok },
  }, async () => json([]));
}

const views = () => screen.getByRole("tablist", { name: "Dashboard views" });
const viewTab = (name: string) => within(views()).getByRole("tab", { name });
const list = () => screen.findByRole("list", { name: "Versions" });
const rows = async () => within(await list()).getAllByRole("listitem");
const row = async (n: number) => {
  const found = (await rows()).find((r) => r.querySelector("h2")?.textContent === `Version ${n}`);
  if (!found) throw new Error(`no row for version ${n}`);
  return found;
};
const pick = (n: number) => screen.getByRole("checkbox", { name: `Pick version ${n} to compare` }) as HTMLInputElement;
const restores = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "POST" && r.url.includes("/restore"));
const notBody = () => expect(document.activeElement).not.toBe(document.body);
const at = (iso: string) => draftTime(Date.parse(iso));

/** The dashboard open on its Versions tab. */
async function versionsTab(api = shop()) {
  const user = userEvent.setup();
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText("chart 1");
  await user.keyboard("3");
  expect(viewTab("Versions").getAttribute("aria-selected")).toBe("true");
  await list();
  return { user, api };
}

describe("The Versions tab", () => {
  it("versions list with their origin", async () => {
    await versionsTab();
    expect((await rows()).map((r) => r.querySelector("h2")?.textContent)).toEqual(["Version 3", "Version 2", "Version 1"]);
    const three = await row(3);
    expect(three.textContent).toContain(`${at(T3)} · 1 panel · Restored from version 1`);
    expect(within(three).getByText("Current")).toBeTruthy();
    // The current one is what the dashboard shows: nothing to compare it with or restore.
    expect(within(three).queryByRole("button", { name: "Compare with current" })).toBeNull();
    expect(within(three).queryByRole("button", { name: "Restore…" })).toBeNull();
    const two = await row(2);
    expect(two.textContent).toContain(`${at(T2)} · 2 panels · Saved`);
    expect(within(two).getByRole("button", { name: "Compare with current" })).toBeTruthy();
    expect(within(two).getByRole("button", { name: "Restore…" })).toBeTruthy();
    expect((await row(1)).textContent).toContain(`${at(T1)} · 1 panel · Copied from Old API`);
  });

  it("compare two versions shows the diff older on the left", async () => {
    const { user } = await versionsTab();
    const compare = screen.getByRole("button", { name: "Compare" });
    expect(compare.getAttribute("aria-disabled")).toBe("true");
    // Picked newest first: the diff still puts the older one on the left.
    await user.click(pick(3));
    await user.click(pick(1));
    expect(compare.getAttribute("aria-disabled")).toBeNull();
    await user.click(compare);
    const diff = await screen.findByRole("figure", { name: "Version 1 and Version 3" });
    await waitFor(() => expect(within(diff).getByTestId("diff-before")).toBeTruthy());
    expect(JSON.parse(within(diff).getByTestId("diff-before").textContent ?? "")).toEqual(v1());
    expect(JSON.parse(within(diff).getByTestId("diff-after").textContent ?? "")).toEqual(v3());
    expect(document.activeElement).toBe(compare);
    // A third pick lets go of the lowest version.
    await user.click(pick(2));
    expect([pick(1).checked, pick(2).checked, pick(3).checked]).toEqual([false, true, true]);
    // Compare with current: that version on the left, the current one on the right.
    const two = await row(2);
    await user.click(within(two).getByRole("button", { name: "Compare with current" }));
    const withCurrent = await screen.findByRole("figure", { name: "Version 2 and Version 3" });
    await waitFor(() => expect(JSON.parse(within(withCurrent).getByTestId("diff-before").textContent ?? "")).toEqual(v2()));
    // Closing the comparison gives the keyboard back to what opened it.
    await user.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.queryByRole("figure")).toBeNull();
    expect(document.activeElement).toBe(within(await row(2)).getByRole("button", { name: "Compare with current" }));
  });

  it("restore asks first and saves a new version", async () => {
    const { user, api } = await versionsTab();
    const opener = within(await row(2)).getByRole("button", { name: "Restore…" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Restore version 2?" });
    expect(within(dialog).getByText("This saves a new version with what version 2 had. No version is deleted.")).toBeTruthy();
    const go = within(dialog).getByRole("button", { name: "Restore version 2" });
    expect(document.activeElement).toBe(go);
    // Esc cancels, and the keyboard goes back to Restore….
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(restores(api)).toHaveLength(0);

    await user.click(opener);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(restores(api)).toHaveLength(1));
    expect(restores(api)[0].url).toBe("/api/monitoring/dashboards/d1/versions/2/restore");
    expect(restores(api)[0].body).toEqual({ base_version: 3 });
    // The Dashboard tab shows the new version, with the keyboard on its tab.
    await waitFor(() => expect(viewTab("Dashboard").getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(viewTab("Dashboard"));
    expect(await screen.findByRole("heading", { name: "Errors" })).toBeTruthy();
    notBody();
    await user.keyboard("3");
    await waitFor(async () => expect((await rows())[0].textContent).toContain("Version 4"));
    expect((await rows())[0].textContent).toContain("Restored from version 2");
    expect(within(await row(4)).getByText("Current")).toBeTruthy();
  });

  it("restore is refused while a draft exists", async () => {
    const { user, api } = await versionsTab();
    await user.click(viewTab("Dashboard"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Save dashboard" });
    await user.click(viewTab("Versions"));
    const opener = within(await row(2)).getByRole("button", { name: "Restore…" });
    await user.click(opener);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Save or discard your draft before restoring a version.")).toBeTruthy();
    expect(document.activeElement).toBe(opener);
    expect(restores(api)).toHaveLength(0);
  });

  it("the refusal goes with the session, and a restore is asked again on confirm", async () => {
    const { user, api } = await versionsTab();
    await user.click(viewTab("Dashboard"));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Save dashboard" });
    await user.click(viewTab("Versions"));
    await user.click(within(await row(2)).getByRole("button", { name: "Restore…" }));
    expect(screen.getByText("Save or discard your draft before restoring a version.")).toBeTruthy();
    // Edit mode ends (nothing changed, so nothing is asked): the refusal goes with it.
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText("Save or discard your draft before restoring a version.")).toBeNull());
    notBody();

    // A draft appears while the question is open (another window): confirming is refused.
    const opener = within(await row(2)).getByRole("button", { name: "Restore…" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "Restore version 2?" })).toBeTruthy();
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 3, savedAt: Date.now(), draft: v2(), jsonText: null, writer: "w-other" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Save or discard your draft before restoring a version.")).toBeTruthy();
    expect(document.activeElement).toBe(opener);
    await new Promise((r) => setTimeout(r, 30));
    expect(restores(api)).toHaveLength(0);
  });

  it("a ready-made view has no versions and shows its JSON read-only", async () => {
    const ready = seedDashboard("ready:p1:nodes", SHOP, v1(), true);
    const api = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { "ready:p1:nodes": ready },
      readyMade: { p1: [{
        key: "nodes", id: "ready:p1:nodes", title: "API latency", description: "Nodes", missing: [], notes: [], checked: true, check_message: null,
      }] },
      queryAnswers: { up: ok },
    }, async () => json([]));
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "ready:p1:nodes" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    expect(within(views()).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Dashboard", "JSON"]);
    await user.keyboard("3");
    expect(viewTab("Dashboard").getAttribute("aria-selected")).toBe("true");
    await user.click(viewTab("JSON"));
    const pre = screen.getByLabelText("Dashboard JSON");
    expect(pre.tagName).toBe("PRE");
    expect(JSON.parse(pre.textContent ?? "")).toEqual(v1());
    expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Copy to edit" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Dashboard JSON" })).toBeNull();
    expect(api.requests.some((r) => r.url.includes("/versions"))).toBe(false);
  });
});
