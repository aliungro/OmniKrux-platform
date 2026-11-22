import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import { parseDashboardJson, type DashboardSpec } from "../schema";
import type { EditingState } from "../editor/editorState";
import { editSessions } from "../editor/useDashboardEditor";

// The chart chunk as a stub.
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

// Counted, so the debounce can be seen; it still validates for real.
vi.mock("../schema", async (importOriginal) => {
  const real = await importOriginal<typeof import("../schema")>();
  return { ...real, parseDashboardJson: vi.fn(real.parseDashboardJson) };
});

// CodeMirror doesn't run in jsdom: the editor is a textarea with the kit's keys (Ctrl+Enter
// submits, Esc leaves), and the diff draws both sides as text.
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
    editor: (parent: HTMLElement, doc: string, onChange: (text: string) => void, label: string, keys: { onSubmit(): void; onLeave(): void }) => {
      const area = document.createElement("textarea");
      area.value = doc;
      area.setAttribute("aria-label", label);
      area.addEventListener("input", () => onChange(area.value));
      area.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          if (!e.repeat) keys.onSubmit();
        } else if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          keys.onLeave();
        }
      });
      parent.append(area);
      return { focus: () => area.focus(), destroy: () => area.remove() };
    },
  }),
}));

beforeEach(() => { localStorage.clear(); editSessions.clear(); vi.mocked(parseDashboardJson).mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

const doc = (): DashboardSpec => spec("API latency", [
  panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 }),
  panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 }),
]);

function shop(): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc()) },
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
const views = () => screen.getByRole("tablist", { name: "Dashboard views" });
const viewTab = (name: string) => within(views()).getByRole("tab", { name });
const editorField = () => screen.findByRole("textbox", { name: "Dashboard JSON" }) as Promise<HTMLTextAreaElement>;
const type = (area: HTMLTextAreaElement, text: string) => fireEvent.input(area, { target: { value: text } });
const session = () => [...editSessions.values()].find((x): x is EditingState => x.mode === "edit") ?? null;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusLine = () => screen.getByTestId("json-state");
const notBody = () => expect(document.activeElement).not.toBe(document.body);
/** The JSON tab's own Discard (the header has one too in edit mode). */
const jsonDiscard = () => within(screen.getByRole("tabpanel")).getByRole("button", { name: "Discard" });

/** The dashboard open, with the keyboard on its title. */
async function opened(api = shop()) {
  const user = userEvent.setup();
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText("chart 1");
  return { user, api };
}

/** Edit mode, then the JSON tab with its editor loaded. */
async function editingJson(api = shop()) {
  const out = await opened(api);
  await out.user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  await out.user.click(viewTab("JSON"));
  const area = await editorField();
  return { ...out, area };
}

/** The document with a change made to it. */
const changed = (edit: (d: DashboardSpec) => void) => {
  const d = doc();
  edit(d);
  return JSON.stringify(d, null, 2);
};

describe("The JSON tab", () => {
  it("valid JSON applies live in edit mode", async () => {
    const { user, area } = await editingJson();
    expect(JSON.parse(area.value)).toEqual(doc());
    expect(statusLine().textContent).toBe("✓ Valid · applied live");
    type(area, changed((d) => { d.panels[0].title = "Requests per second"; }));
    // Not yet: validation waits for a pause in typing.
    expect(session()?.draft.panels[0].title).toBe("Requests");
    await waitFor(() => expect(session()?.draft.panels[0].title).toBe("Requests per second"));
    expect(session()?.changes).toEqual({ "p-1": 1 });
    expect(statusLine().textContent).toBe("✓ Valid · applied live");
    await user.click(viewTab("Dashboard"));
    expect(tile("Requests per second")).toBeTruthy();
    expect(tile("Errors")).toBeTruthy();
  });

  it("invalid JSON keeps the last valid dashboard and says where", async () => {
    const { user, area } = await editingJson();
    type(area, changed((d) => { d.panels[0].layout.w = 1; d.panels[1].layout.h = 99; }));
    await waitFor(() => expect(statusLine().textContent).toBe(
      "✗ panels[0].layout.w: Use a whole number from 2 to 24. · the dashboard keeps the last valid version",
    ));
    expect(session()?.draft).toEqual(doc());
    // More than one: the rest on request.
    const more = screen.getByRole("button", { name: "1 more problem" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await user.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "JSON problems" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "panels[0].layout.w Use a whole number from 2 to 24.",
      "panels[1].layout.h Use a whole number from 2 to 40.",
    ]);
    // Text that isn't JSON at all: no path.
    type(area, "{ nope");
    await waitFor(() => expect(statusLine().textContent).toMatch(/^✗ Not valid JSON: .+ · the dashboard keeps the last valid version$/));
    expect(screen.getByRole("button", { name: "Review changes" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("typing outside edit mode starts editing", async () => {
    const { user } = await opened();
    await user.keyboard("2");
    const area = await editorField();
    expect(statusLine().textContent).toBe("✓ Valid");
    expect(screen.queryByText("Editing")).toBeNull();
    expect(jsonDiscard().getAttribute("aria-disabled")).toBe("true");
    area.focus();
    type(area, changed((d) => { d.title = "API latency (p95)"; }));
    expect(await screen.findByText("Editing")).toBeTruthy();
    // The text typed stays in the editor, and the keyboard with it.
    expect((await editorField()).value).toContain("API latency (p95)");
    expect(document.activeElement).toBe(area);
    await waitFor(() => expect(session()?.draft.title).toBe("API latency (p95)"));
    expect(statusLine().textContent).toBe("✓ Valid · applied live");
  });

  it("typing outside edit mode while another tab edits it sends you there", async () => {
    shop();
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }, { page: "dashboard", id: "d1" }) });
    await screen.findAllByText("chart 1");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const tabs = () => within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab");
    await user.click(tabs()[1]);
    await screen.findAllByText("chart 1");
    await user.click(viewTab("JSON"));
    const area = await editorField();
    area.focus();
    type(area, changed((d) => { d.title = "Mine"; }));
    expect(await screen.findByText("This dashboard is being edited in another tab.")).toBeTruthy();
    expect(editSessions.has("start1")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Go to that tab" }));
    // The editor shows the saved document again.
    await waitFor(async () => expect(JSON.parse((await editorField()).value)).toEqual(doc()));
    await pause(200);
    expect(session()?.draft.title).toBe("API latency");
  });

  it("Ctrl+Enter opens Review changes with focus on Save dashboard", async () => {
    const { user, area, api } = await editingJson();
    area.focus();
    type(area, changed((d) => { d.panels[1].title = "Failures"; }));
    // Straight away: what was typed is checked first.
    await user.keyboard("{Control>}{Enter}{/Control}");
    const dialog = await screen.findByRole("dialog", { name: 'Review changes to "API latency"' });
    expect(within(dialog).getByText("Saved (version 1)")).toBeTruthy();
    expect(within(dialog).getByText("Your changes")).toBeTruthy();
    expect(JSON.parse(within(dialog).getByTestId("diff-before").textContent ?? "")).toEqual(doc());
    expect(JSON.parse(within(dialog).getByTestId("diff-after").textContent ?? "").panels[1].title).toBe("Failures");
    const save = within(dialog).getByRole("button", { name: "Save dashboard" });
    expect(document.activeElement).toBe(save);
    // Ctrl+Enter in the dialog saves.
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect((puts(api)[0].body as { base_version: number; spec: DashboardSpec }).spec.panels[1].title).toBe("Failures");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Editing")).toBeNull();
    notBody();
    // The editor holds the saved version.
    await waitFor(async () => expect(JSON.parse((await editorField()).value).panels[1].title).toBe("Failures"));
    expect(statusLine().textContent).toBe("✓ Valid");
  });

  it("Esc leaves the editor to Review changes", async () => {
    const { user, area } = await editingJson();
    area.focus();
    // Nothing changed yet: Review changes can't be pressed, so Esc goes to Discard.
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(jsonDiscard());
    area.focus();
    type(area, changed((d) => { d.panels[1].title = "Failures"; }));
    await waitFor(() => expect(session()?.draft.panels[1].title).toBe("Failures"));
    await user.keyboard("{Escape}");
    const review = screen.getByRole("button", { name: "Review changes" });
    expect(document.activeElement).toBe(review);
    expect(screen.getByText("Editing")).toBeTruthy();
    // The dialog's Esc comes back to Review changes.
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: 'Review changes to "API latency"' });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(review);
  });

  it("the Dashboard tab warns while the JSON is invalid", async () => {
    const { user, area } = await editingJson();
    const bad = changed((d) => { d.panels[0].layout.w = 1; });
    type(area, bad);
    await waitFor(() => expect(statusLine().textContent).toMatch(/^✗ panels\[0\]\.layout\.w/));
    await user.click(viewTab("Dashboard"));
    const warning = screen.getByText("The JSON has a problem, so the dashboard shows the last valid version. Fix it on the JSON tab.");
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 1, row 1");
    const go = screen.getByRole("button", { name: "Go to JSON" });
    expect(warning.closest("[role]")?.contains(go)).toBe(true);
    await user.click(go);
    expect(viewTab("JSON").getAttribute("aria-selected")).toBe("true");
    notBody();
    // The text as it was left, problems and all.
    expect((await editorField()).value).toBe(bad);
    expect(statusLine().textContent).toMatch(/^✗ panels\[0\]\.layout\.w/);
  });

  it("settings and JSON agree both ways", async () => {
    const { user } = await opened();
    await user.keyboard("e");
    await screen.findByRole("button", { name: "Save dashboard" });
    await user.keyboard("{Enter}");
    const settings = await screen.findByRole("complementary", { name: "Panel settings" });
    await user.click(within(settings).getByRole("tab", { name: "Options" }));
    await user.selectOptions(within(settings).getByRole("combobox", { name: "Unit" }), "Seconds");
    await user.click(viewTab("JSON"));
    const area = await editorField();
    expect(area.value).toContain('"unit": "s"');
    type(area, area.value.replace('"unit": "s"', '"unit": "ms"'));
    await waitFor(() => expect((session()?.draft.panels[0].options as { unit?: string } | undefined)?.unit).toBe("ms"));
    await user.click(viewTab("Dashboard"));
    tile("Requests").focus();
    await user.keyboard("{Enter}");
    const again = await screen.findByRole("complementary", { name: "Panel settings" });
    await user.click(within(again).getByRole("tab", { name: "Options" }));
    const unit = within(again).getByRole("combobox", { name: "Unit" }) as HTMLSelectElement;
    expect(unit.selectedOptions[0].textContent).toBe("Milliseconds");
  });

  it("validation runs on a debounce", async () => {
    const { area } = await editingJson();
    vi.mocked(parseDashboardJson).mockClear();
    const text = changed((d) => { d.panels[0].title = "Requests per second"; });
    for (let i = 1; i <= 10; i++) type(area, text.slice(0, text.length - 10 + i));
    expect(parseDashboardJson).not.toHaveBeenCalled();
    await pause(250);
    expect(parseDashboardJson).toHaveBeenCalledTimes(1);
    expect(session()?.draft.panels[0].title).toBe("Requests per second");
  });

  it("Discard puts the saved JSON back in the editor", async () => {
    const { user, area } = await editingJson();
    type(area, changed((d) => { d.panels[0].layout.w = 1; }));
    await waitFor(() => expect(statusLine().textContent).toMatch(/^✗/));
    await user.click(jsonDiscard());
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByText("Editing")).toBeNull();
    await waitFor(async () => expect(JSON.parse((await editorField()).value)).toEqual(doc()));
    expect(statusLine().textContent).toBe("✓ Valid");
    notBody();
  });

  it("Ctrl+S in the editor saves what was just typed", async () => {
    const { user, area, api } = await editingJson();
    area.focus();
    type(area, changed((d) => { d.panels[1].title = "Failures"; }));
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    expect((puts(api)[0].body as { spec: DashboardSpec }).spec.panels[1].title).toBe("Failures");
    await waitFor(() => expect(screen.queryByText("Editing")).toBeNull());
    notBody();
  });
});
