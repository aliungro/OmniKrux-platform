import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Plan } from "../../api/types";
import type { AlertChangeOut } from "../alerts/api";
import type { ToolReviews } from "../alerts/reviews/useToolReviews";
import type { DashboardOut } from "../dashboards/api";
import { editSessions } from "../dashboards/editor/useDashboardEditor";
import { writeDraft } from "../dashboards/drafts/draftStore";
import type { DashboardSpec } from "../dashboards/schema";
import { installFakeMonitoringApi, type FakeDashboard, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import type { Failure } from "../test/fakeTransferApi";
import { linkedProject, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import type { OriginOut, UpdatePreviewOut } from "./api";

// The chart chunk as a stub.
vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

// CodeMirror doesn't run in jsdom: the diff draws both sides as text.
vi.mock("../../features/actions/lazyCodeMirror", () => ({
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
  }),
}));

// The real tool review queue, with what the page hands it recorded.
const enqueued = vi.hoisted(() => vi.fn());
vi.mock("../alerts/reviews/useToolReviews", async (orig) => {
  const real = await orig<typeof import("../alerts/reviews/useToolReviews")>();
  const wrapped = new WeakMap<ToolReviews, ToolReviews>();
  return {
    ...real,
    useToolReviews: () => {
      const q = real.useToolReviews();
      let w = wrapped.get(q);
      if (!w) {
        w = { ...q, enqueue: (changes, after) => { enqueued(changes, after); q.enqueue(changes, after); } };
        wrapped.set(q, w);
      }
      return w;
    },
  };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); enqueued.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const IMPORTED_AT = "2026-03-01T08:00:00Z";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

const now = (): DashboardSpec => spec("API latency", [panel("p-1", "Requests", "up")]);
const incoming = (): DashboardSpec => spec("API latency", [panel("p-1", "Requests per second", "up")]);

const EDITED = "This dashboard was changed in OmniKrux since it was imported. Updating replaces those changes; they stay in Versions.";
const SOURCE_CHANGED = "The source changed since you reviewed it. Here is the new difference.";
const SAVED_ELSEWHERE = "This dashboard was saved somewhere else since you opened this. Review it again.";
const REFUSED = "Save or discard your draft before updating from the source.";

const grafanaOrigin = (over: Partial<OriginOut> = {}): OriginOut => ({
  kind: "grafana", via: "grafana", label: "Team Grafana", grafana_id: "gf1", grafana_name: "Team Grafana", grafana_uid: "api-latency",
  grafana_version: 7, imported_at: IMPORTED_AT, imported_version: 1, updated_at: null, updated_version: null, can_refetch: true, ...over,
});
const fileOrigin = (): OriginOut => ({
  kind: "grafana", via: "file", label: "api-latency.json", grafana_id: null, grafana_name: null, grafana_uid: "api-latency",
  grafana_version: 7, imported_at: IMPORTED_AT, imported_version: 1, updated_at: null, updated_version: null, can_refetch: false,
});

const preview = (over: Partial<UpdatePreviewOut> = {}): UpdatePreviewOut => ({
  current_version: 3,
  current: now() as unknown as Record<string, unknown>,
  incoming: incoming() as unknown as Record<string, unknown>,
  same: false,
  skipped: [{ where: 'Panel "Requests"', what: "Its links", reason: "Panel links aren't copied." }],
  new_sources: [],
  identity_warning: null,
  title_note: null,
  edited_since_import: true,
  source_label: "Team Grafana",
  source_version: 9,
  previous_source_version: 7,
  no_new_version: false,
  digest: "dg-1",
  ...over,
});

const updated = (alert_changes: AlertChangeOut[] = []): DashboardOut => ({
  id: "d1", owner_kind: "project", owner_id: "p1", owner_name: "Shop", title: "API latency", version: 4, spec: incoming(),
  ready_made: false, created_at: T, updated_at: T, alert_changes,
});

const refusal = (status: number, code: string, message: string): Failure => ({ status, detail: { code, message, key: null, problems: [] } });

const plan: Plan = {
  plan_id: "plan-1",
  action: "delete",
  target: { cluster_id: "c1", kind_key: "prometheusrules.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-slow-1a2b" },
  kind: "PrometheusRule",
  cluster: { id: "c1", name: "kind-dev", provider: "kind", environment: "development" },
  title: "Delete PrometheusRule omnikrux-slow-1a2b",
  summary: ["Delete PrometheusRule monitoring/omnikrux-slow-1a2b."],
  warnings: [],
  blocked: [],
  diff: null,
  confirm_text: null,
  apply_label: "Delete",
  expires_at: "2026-11-23T10:05:00Z",
};
const toolReview: AlertChangeOut = {
  target_id: "t1", rule_id: "r1", rule_name: "Slow requests", project_id: "p1", project_name: "Shop", kind: "review", message: null,
};

function board(): FakeDashboard {
  const d = seedDashboard("d1", SHOP, now());
  d.out.version = 3;
  d.versions = [1, 2, 3].map((version) => ({
    out: { version, saved_at: T, title: "API latency", panel_count: 1, origin: version === 1 ? "imported" as const : "saved" as const, restored_from: null, copied_from: version === 1 ? "Team Grafana" : null },
    spec: now(),
  }));
  return d;
}

function seed(transfer: Partial<FakeMonitoringApi["state"]["transfer"]> = {}, extra: Parameters<typeof installFakeMonitoringApi>[0] = {}) {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: board(), d2: seedDashboard("d2", SHOP, spec("Errors", [panel("p-1", "Errors", "up")])) },
    queryAnswers: { up: ok },
    ...extra,
    transfer: { origins: { d1: grafanaOrigin() }, updatePreviews: { d1: preview() }, updates: { d1: updated() }, ...transfer },
  }, async () => json([]));
}

const previews = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/dashboards/d1/update-from-source/preview");
const applies = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/dashboards/d1/update-from-source");
const more = () => screen.getByRole("button", { name: "More actions" });
const dashboardTab = () => within(screen.getByRole("tablist", { name: "Dashboard views" })).getByRole("tab", { name: "Dashboard" });
const dialog = () => screen.getByRole("dialog", { name: 'Update "API latency" from its source' });

async function open(id = "d1") {
  const user = userEvent.setup();
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id }) });
  await screen.findByRole("heading", { level: 1 });
  return { user, app };
}

async function menuItems(user: ReturnType<typeof userEvent.setup>) {
  await user.click(more());
  const menu = screen.getByRole("menu", { name: "More actions" });
  return within(menu).getAllByRole("menuitem");
}

async function openUpdate(user: ReturnType<typeof userEvent.setup>) {
  // The menu offers it once the origin is read.
  await screen.findByText(/^Imported from /);
  const items = await menuItems(user);
  await user.click(items.find((i) => i.textContent === "Update from source…")!);
  return dialog();
}

/** The review is shown with the keyboard on Replace with the source. */
async function reviewShown() {
  const replace = await within(dialog()).findByRole("button", { name: "Replace with the source" });
  await waitFor(() => expect(document.activeElement).toBe(replace));
  return replace;
}

/** Holds each preview request in front of the fake until released; the fake answers from its state then. */
function holdPreviews() {
  const inner = globalThis.fetch;
  const held: { body: unknown; release(): void }[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/update-from-source/preview")) return inner(input, init);
    return new Promise<Response>((resolve) => {
      held.push({ body: JSON.parse(String(init?.body ?? "{}")), release: () => resolve(inner(input, init)) });
    });
  }));
  return held;
}

const notBody = () => expect(document.activeElement).not.toBe(document.body);
const lokiRef = {
  key: "loki", type: "loki" as const, type_guessed: false, name: "Logs", detail: null, suggestion: null, leave_out: false,
  reason: "No Loki source is linked to Shop.",
};
const UNREACHABLE = "Couldn't reach Team Grafana. Check that it's running, then check again.";

describe("Update from source", () => {
  it("update from source shows the diff and warns about local edits", async () => {
    const api = seed();
    const { user } = await open();
    expect(await screen.findByText("Imported from Team Grafana on 1 Mar 2026")).toBeTruthy();
    const box = await openUpdate(user);
    // A connected Grafana is read again at once: no file step.
    expect(within(box).queryByRole("button", { name: "Pick the file again" })).toBeNull();
    expect(within(box).queryByRole("textbox")).toBeNull();
    await reviewShown();
    expect(previews(api).map((r) => r.body)).toEqual([{}]);
    expect(within(box).getByText("From Team Grafana · Grafana version 7 → 9")).toBeTruthy();
    expect(within(box).getByText(EDITED)).toBeTruthy();
    expect(within(box).getByRole("figure", { name: "Now (version 3) and From the source" })).toBeTruthy();
    expect(within(box).getByText("Now (version 3)")).toBeTruthy();
    expect(within(box).getByText("From the source")).toBeTruthy();
    expect((await within(box).findByTestId("diff-after")).textContent).toContain("Requests per second");
    expect(within(box).getByTestId("diff-before").textContent).not.toContain("Requests per second");
    expect(within(box).getByRole("heading", { name: "Skipped (1)" })).toBeTruthy();
    expect(within(box).getByText("Its links")).toBeTruthy();
    expect(within(box).getByRole("button", { name: "Cancel" })).toBeTruthy();

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(applies(api).map((r) => r.body)).toEqual([{ base_version: 3, digest: "dg-1" }]);
    expect(await screen.findByText('Updated "API latency" from its source.')).toBeTruthy();
    expect(screen.getByText('Updated "API latency" from its source.').getAttribute("role")).toBe("status");
    // The page shows the new version, with the keyboard on its Dashboard tab.
    expect(await screen.findByText("Requests per second")).toBeTruthy();
    expect(dashboardTab().getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(dashboardTab());
    expect(enqueued).not.toHaveBeenCalled();
  });

  it("a file origin asks for the file first", async () => {
    const text = JSON.stringify({ title: "API latency", panels: [] });
    const api = seed({ origins: { d1: fileOrigin() }, updatePreviews: { d1: preview({ source_label: "api-latency.json" }) } });
    const { user, app } = await open();
    expect(await screen.findByText("Imported from api-latency.json on 1 Mar 2026")).toBeTruthy();
    const box = await openUpdate(user);
    const pick = within(box).getByRole("button", { name: "Pick the file again" });
    expect(document.activeElement).toBe(pick);
    expect(within(box).getByRole("textbox", { name: "or paste its JSON" })).toBeTruthy();
    const check = within(box).getByRole("button", { name: "Check" });
    expect(check.getAttribute("aria-disabled")).toBe("true");
    expect(within(box).getByText("From api-latency.json")).toBeTruthy();
    expect(within(box).queryByRole("button", { name: "Replace with the source" })).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(previews(api)).toHaveLength(0);

    const input = app.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".json,application/json");
    await user.upload(input, new File([text], "api-latency.json", { type: "application/json" }));
    expect(await within(box).findByText(`api-latency.json · ${text.length} bytes`)).toBeTruthy();
    await waitFor(() => expect(check.hasAttribute("aria-disabled")).toBe(false));
    await user.click(check);
    await reviewShown();
    const given = { kind: "text", text, file_name: "api-latency.json", via: "file" };
    expect(previews(api).map((r) => r.body)).toEqual([{ input: given }]);
    // A Grafana dashboard's file names its versions too.
    expect(within(box).getByText("From api-latency.json · Grafana version 7 → 9")).toBeTruthy();

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(applies(api).map((r) => r.body)).toEqual([{ base_version: 3, digest: "dg-1", input: given }]);
  });

  it("pasted JSON is checked with Ctrl+Enter", async () => {
    const text = '{"title": "API latency", "panels": []}';
    const api = seed({ origins: { d1: { ...fileOrigin(), via: "paste", label: "Pasted JSON" } } });
    const { user } = await open();
    const box = await openUpdate(user);
    const area = within(box).getByRole("textbox", { name: "or paste its JSON" });
    expect(document.activeElement).toBe(area);
    await user.click(area);
    await user.paste(text);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await reviewShown();
    expect(previews(api).map((r) => r.body)).toEqual([{ input: { kind: "text", text, via: "paste" } }]);
    expect(applies(api)).toHaveLength(0);
  });

  it("a new data source picked checks again", async () => {
    const ref = {
      key: "loki", type: "loki" as const, type_guessed: false, name: "Logs", detail: null, suggestion: null, leave_out: false,
      reason: "No Loki source is linked to Shop.",
    };
    const api = seed({ updatePreviews: { d1: preview({ new_sources: [ref] }) } });
    const { user } = await open();
    const box = await openUpdate(user);
    await reviewShown();
    expect(within(box).getByRole("heading", { name: "New data sources" })).toBeTruthy();
    const select = within(box).getByRole("combobox", { name: "Source for Logs" });
    await user.selectOptions(select, "Leave its panels out");
    await waitFor(() => expect(previews(api)).toHaveLength(2));
    expect(previews(api)[1].body).toEqual({ mapping: [{ key: "loki", leave_out: true }] });
    // The keyboard stays on the choice.
    expect(document.activeElement).toBe(select);
    await user.click(within(box).getByRole("button", { name: "Replace with the source" }));
    await waitFor(() => expect(applies(api)).toHaveLength(1));
    expect(applies(api)[0].body).toEqual({ base_version: 3, digest: "dg-1", mapping: [{ key: "loki", leave_out: true }] });
  });

  it("nothing changed says so", async () => {
    const api = seed({ updatePreviews: { d1: preview({ same: true, edited_since_import: false, skipped: [] }) } });
    const { user } = await open();
    const box = await openUpdate(user);
    expect(await within(box).findByText("Nothing changed: the source matches this dashboard.")).toBeTruthy();
    const close = within(box).getByRole("button", { name: "Close" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(within(box).queryByRole("button", { name: "Replace with the source" })).toBeNull();
    expect(within(box).queryByRole("figure")).toBeNull();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(applies(api)).toHaveLength(0);
    await user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it("a source that changed re-checks with words", async () => {
    const api = seed({ updates: { d1: refusal(409, "source_changed", "The source changed.") } });
    const { user } = await open();
    const box = await openUpdate(user);
    const replace = await reviewShown();
    expect(previews(api)).toHaveLength(1);

    await user.click(replace);
    expect(await within(box).findByText(SOURCE_CHANGED)).toBeTruthy();
    expect(within(box).getByText(SOURCE_CHANGED).getAttribute("role")).toBe("alert");
    await waitFor(() => expect(previews(api)).toHaveLength(2));
    await reviewShown();

    // The digest no longer matching what it makes here (a mapping or contact point changed) reads the same.
    api.state.transfer.updates.d1 = refusal(409, "changed", '"API latency" changed since you checked.');
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(previews(api)).toHaveLength(3));
    expect(within(box).getByText(SOURCE_CHANGED)).toBeTruthy();
    await reviewShown();

    // Saved elsewhere meanwhile.
    api.state.transfer.updates.d1 = refusal(409, "version_conflict", "This dashboard was saved somewhere else.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(box).findByText(SAVED_ELSEWHERE)).toBeTruthy();
    expect(within(box).queryByText(SOURCE_CHANGED)).toBeNull();
    await waitFor(() => expect(previews(api)).toHaveLength(4));
    await reviewShown();

    // Anything else: its words, and the review stays as it is.
    api.state.transfer.updates.d1 = refusal(500, "not_updated", "The dashboard couldn't be updated. Nothing was changed. Try again.");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await within(box).findByText("The dashboard couldn't be updated. Nothing was changed. Try again.")).toBeTruthy();
    expect(previews(api)).toHaveLength(4);
    expect(applies(api)).toHaveLength(4);
    expect(dialog()).toBeTruthy();
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Replace with the source" }));
  });

  it("the menu offers Update from source only for imported dashboards", async () => {
    seed({}, {
      dashboards: { d1: board(), d2: seedDashboard("d2", SHOP, spec("Errors", [panel("p-1", "Errors", "up")])), "ready:p1:nodes": seedDashboard("ready:p1:nodes", SHOP, spec("Nodes", [panel("p-1", "Nodes", "up")]), true) },
      readyMade: { p1: [{ key: "nodes", id: "ready:p1:nodes", title: "Nodes", description: "Nodes", missing: [], notes: [], checked: true, check_message: null }] },
    });
    const first = await open("d1");
    await screen.findByText("Imported from Team Grafana on 1 Mar 2026");
    expect((await menuItems(first.user)).map((i) => i.textContent)).toEqual([
      "Rename…", "Copy dashboard…", "Export as JSON", "Import into Shop…", "Update from source…", "Delete dashboard…",
    ]);
    // Import into Shop… opens Import for its project in a new tab.
    await first.user.click(screen.getByRole("menuitem", { name: "Import into Shop…" }));
    await waitFor(() => expect(first.app.current().tabs).toHaveLength(2));
    expect(first.app.current().tabs[1].view).toEqual({ page: "import", target: { kind: "project", id: "p1" } });
    cleanup();

    const second = await open("d2");
    await screen.findByRole("heading", { level: 1, name: "Errors" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/^Imported from /)).toBeNull();
    expect((await menuItems(second.user)).map((i) => i.textContent)).toEqual([
      "Rename…", "Copy dashboard…", "Export as JSON", "Import into Shop…", "Delete dashboard…",
    ]);
    cleanup();

    const third = await open("ready:p1:nodes");
    await screen.findByRole("heading", { level: 1, name: "Nodes" });
    expect((await menuItems(third.user)).map((i) => i.textContent)).toEqual(["Copy dashboard…", "Export as JSON"]);
  });

  it("a draft blocks the update", async () => {
    const api = seed();
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 3, savedAt: Date.now(), draft: now(), jsonText: null, writer: "w-other" });
    const { user } = await open();
    await screen.findByText(/^Imported from /);
    const items = await menuItems(user);
    await user.click(items.find((i) => i.textContent === "Update from source…")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    const words = screen.getByText(REFUSED);
    expect(words.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(more());
    await new Promise((r) => setTimeout(r, 20));
    expect(previews(api)).toHaveLength(0);
  });

  it("a draft that appears while reviewing stops the replace", async () => {
    const api = seed();
    const { user } = await open();
    await openUpdate(user);
    await reviewShown();
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 3, savedAt: Date.now(), draft: now(), jsonText: null, writer: "w-other" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(REFUSED)).toBeTruthy();
    expect(applies(api)).toHaveLength(0);
    expect(document.activeElement).toBe(more());
  });

  it("Esc returns focus to More actions", async () => {
    seed();
    const { user } = await open();
    await openUpdate(user);
    await reviewShown();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more());
    // Cancel too, also before the review shows.
    await user.click((await menuItems(user)).find((i) => i.textContent === "Update from source…")!);
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it("replacing a tool-run alert opens its review", async () => {
    // No alert change: no review.
    seed();
    let s = await open();
    await openUpdate(s.user);
    await reviewShown();
    await s.user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText('Updated "API latency" from its source.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(enqueued).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    // A tool-run alert the source dropped: its removal is reviewed once the dialog has closed.
    seed({ updates: { d1: updated([toolReview]) } }, { syncAnswers: { t1: { kind: "review", plan } } });
    s = await open();
    await openUpdate(s.user);
    await reviewShown();
    await s.user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(enqueued).toHaveBeenCalledTimes(1));
    expect(enqueued.mock.calls[0][0]).toEqual([toolReview]);
    expect(enqueued.mock.calls[0][1]).toEqual({ focus: dashboardTab() });
    const review = await screen.findByRole("dialog");
    expect(within(review).getByRole("heading", { name: "Delete PrometheusRule omnikrux-slow-1a2b" })).toBeTruthy();
    expect(screen.getByText('Updated "API latency" from its source.')).toBeTruthy();
  });

  it("a retried Grafana read keeps the keyboard on Try again", async () => {
    const api = seed({ updatePreviews: { d1: refusal(502, "grafana", UNREACHABLE) } });
    const { user } = await open();
    const box = await openUpdate(user);
    expect((await within(box).findByRole("alert")).textContent).toContain(UNREACHABLE);
    const again = within(box).getByRole("button", { name: "Try again" });
    const held = holdPreviews();
    await user.click(again);
    // While it runs, the button stays where the keyboard is.
    await waitFor(() => expect(held).toHaveLength(1));
    expect(again.isConnected).toBe(true);
    expect(again.textContent).toBe("Trying again…");
    expect(again.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(again);
    notBody();
    // It fails again: still there, still with the keyboard.
    held[0].release();
    await waitFor(() => expect(again.textContent).toBe("Try again"));
    expect(document.activeElement).toBe(again);
    // Then it works: the review, with the keyboard on Replace with the source.
    api.state.transfer.updatePreviews.d1 = preview();
    await user.click(again);
    await waitFor(() => expect(held).toHaveLength(2));
    held[1].release();
    await reviewShown();
    expect(within(box).queryByRole("alert")).toBeNull();
    expect(previews(api)).toHaveLength(3);
  });

  it("a failed check after a source choice keeps the keyboard in the dialog", async () => {
    const api = seed({ updatePreviews: { d1: preview({ new_sources: [lokiRef] }) } });
    const { user } = await open();
    const box = await openUpdate(user);
    await reviewShown();
    api.state.transfer.updatePreviews.d1 = refusal(502, "grafana", UNREACHABLE);
    await user.selectOptions(within(box).getByRole("combobox", { name: "Source for Logs" }), "Leave its panels out");
    expect((await within(box).findByRole("alert")).textContent).toContain(UNREACHABLE);
    // The review (and the select that had the keyboard) went with the failure: Try again has it.
    expect(within(box).queryByRole("combobox")).toBeNull();
    expect(within(box).queryByRole("button", { name: "Replace with the source" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Try again" })));
    notBody();
  });

  it("a Grafana whose connection is gone asks for the file", async () => {
    const api = seed({ origins: { d1: grafanaOrigin({ grafana_id: null, grafana_name: null, can_refetch: false }) } });
    const { user } = await open();
    const box = await openUpdate(user);
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Pick the file again" }));
    expect(within(box).getByRole("textbox", { name: "or paste its JSON" })).toBeTruthy();
    expect(within(box).getByRole("button", { name: "Check" }).getAttribute("aria-disabled")).toBe("true");
    await new Promise((r) => setTimeout(r, 20));
    expect(previews(api)).toHaveLength(0);
  });

  it("a late preview answer is dropped for a newer one", async () => {
    const api = seed({ updatePreviews: { d1: preview({ new_sources: [lokiRef] }) } });
    const held = holdPreviews();
    const { user } = await open();
    const box = await openUpdate(user);
    await waitFor(() => expect(held).toHaveLength(1));
    held[0].release();
    await reviewShown();
    const select = within(box).getByRole("combobox", { name: "Source for Logs" });
    await user.selectOptions(select, "Leave its panels out");
    await user.selectOptions(select, "first");
    await waitFor(() => expect(held).toHaveLength(3));
    expect(held[1].body).toEqual({ mapping: [{ key: "loki", leave_out: true }] });
    expect(held[2].body).toEqual({ mapping: [{ key: "loki", source_id: null }] });
    // The newer one answers first; the older one, answered later, is not shown.
    api.state.transfer.updatePreviews.d1 = preview({ new_sources: [lokiRef], title_note: "Fresh answer." });
    held[2].release();
    expect(await within(box).findByText("Fresh answer.")).toBeTruthy();
    api.state.transfer.updatePreviews.d1 = preview({ new_sources: [lokiRef], title_note: "Stale answer." });
    held[1].release();
    await new Promise((r) => setTimeout(r, 30));
    expect(within(box).queryByText("Stale answer.")).toBeNull();
    expect(within(box).getByText("Fresh answer.")).toBeTruthy();
  });

  it("the file's text never reaches the query or mutation cache", async () => {
    const text = JSON.stringify({ title: "API latency", panels: [], note: "FILE-ONLY-7f3c" });
    const api = seed({ origins: { d1: fileOrigin() } });
    const { user, app } = await open();
    const box = await openUpdate(user);
    await user.upload(app.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File([text], "api-latency.json", { type: "application/json" }));
    const check = within(box).getByRole("button", { name: "Check" });
    await waitFor(() => expect(check.hasAttribute("aria-disabled")).toBe(false));
    await user.click(check);
    await reviewShown();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.stringify(applies(api)[0].body)).toContain("FILE-ONLY-7f3c");
    await screen.findByText('Updated "API latency" from its source.');
    const queries = app.client.getQueryCache().getAll().map((q) => JSON.stringify([q.queryKey, q.state.data]));
    const mutations = app.client.getMutationCache().getAll().map((m) => JSON.stringify([m.options.mutationKey, m.state.variables, m.state.data]));
    expect(queries.length).toBeGreaterThan(0);
    for (const entry of [...queries, ...mutations]) expect(entry).not.toContain("FILE-ONLY-7f3c");
  });

  it("Esc in the paste box goes to Check first", async () => {
    seed({ origins: { d1: { ...fileOrigin(), via: "paste", label: "Pasted JSON" } } });
    const { user } = await open();
    const box = await openUpdate(user);
    await user.click(within(box).getByRole("textbox", { name: "or paste its JSON" }));
    await user.paste('{"title": "API latency"}');
    await user.keyboard("{Escape}");
    expect(dialog()).toBeTruthy();
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Check" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it("a source choice that finds nothing changed puts the keyboard on Close", async () => {
    const api = seed({ updatePreviews: { d1: preview({ new_sources: [lokiRef] }) } });
    const { user } = await open();
    const box = await openUpdate(user);
    await reviewShown();
    api.state.transfer.updatePreviews.d1 = preview({ new_sources: [lokiRef], same: true });
    await user.selectOptions(within(box).getByRole("combobox", { name: "Source for Logs" }), "Leave its panels out");
    expect(await within(box).findByText("Nothing changed: the source matches this dashboard.")).toBeTruthy();
    expect(within(box).queryByRole("combobox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Close" })));
    notBody();
  });

  it("an old refusal doesn't come back with a later edit", async () => {
    seed();
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 3, savedAt: Date.now(), draft: now(), jsonText: null, writer: "w-other" });
    const { user } = await open();
    await screen.findByText(/^Imported from /);
    await user.click((await menuItems(user)).find((i) => i.textContent === "Update from source…")!);
    expect(screen.getByText(REFUSED)).toBeTruthy();
    // The draft goes: so does the refusal.
    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(screen.queryByText(REFUSED)).toBeNull());
    // Editing later starts an edit session, but nothing was refused this time.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Save dashboard" });
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("Cancel never says the update was refused", async () => {
    seed();
    const { user } = await open();
    await openUpdate(user);
    await reviewShown();
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 3, savedAt: Date.now(), draft: now(), jsonText: null, writer: "w-other" });
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(document.activeElement).toBe(more());
  });
  it("update with no new version says so and leaves the dashboard alone", async () => {
    const api = seed({ updatePreviews: { d1: preview({ source_version: 7, previous_source_version: 7, no_new_version: true }) } });
    const { user } = await open();
    const box = await openUpdate(user);
    expect(await within(box).findByText("From Team Grafana · version 7")).toBeTruthy();
    expect(within(box).getByText("The source hasn't changed since this dashboard was imported (version 7). Your changes here stay.")).toBeTruthy();
    expect(within(box).queryByRole("button", { name: "Replace with the source" })).toBeNull();
    expect(within(box).queryByRole("figure")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Close" })));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(applies(api)).toEqual([]);
    notBody();
  });

});
