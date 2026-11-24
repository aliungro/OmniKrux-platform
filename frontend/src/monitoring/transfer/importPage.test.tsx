import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeMonitoringSeed } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import { intercept, seedDashboard, serverFailure, spec } from "../test/dashboardSeeds";
import { alertFormMarks, clearAlertForms } from "../alerts/rules/formSessions";
import type { AlertChangeOut } from "../alerts/api";
import type { GroupOut, LinkOut, ProjectOut } from "../api/types";
import { readRecent } from "../home/recent";
import type { MonitoringView } from "../shell/tabState";
import type { ImportCommitIn, ImportPreviewOut, ImportResultOut, PreviewDashboardOut, SourceRefOut } from "./api";

// The tool review queue as the page sees it: a spy (its own dialogs are M4's and M5's tests).
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../alerts/reviews/useToolReviews", async (orig) => {
  const real = await orig<typeof import("../alerts/reviews/useToolReviews")>();
  return { ...real, useToolReviews: () => ({ enqueue, reviewTarget: () => Promise.resolve("cancelled"), pending: 0 }) };
});

const T = "2026-01-01T00:00:00Z";
const GRAFANA = '{"title": "Node overview", "panels": []}';
const CHANGED = "Something changed since you checked. Here is the new result.";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);

const link = (source_id: string, source_name: string, source_type: LinkOut["source_type"] = "prometheus"): LinkOut => ({
  source_id, source_name, source_type, filter: "", filter_origin: "none", created_by_project: false,
});
const SHOP: ProjectOut = { ...seedProject("p1", "shop"), links: [link("s1", "prom-main"), link("s2", "prom-edge"), link("l1", "logs", "loki")] };
const API: ProjectOut = seedProject("p2", "api");
const group = (id: string, name: string, project_ids: string[]): GroupOut => ({ id, name, project_ids, created_at: T, updated_at: T });

const dash = (key: string, title: string, over: Partial<PreviewDashboardOut> = {}): PreviewDashboardOut => ({
  key, title, suggested_title: title, title_taken: false, panels: 4, alerts: 0, skipped: [], problems: [], importable: true, digest: `dg-${key}`, ...over,
});
const promRef = (over: Partial<SourceRefOut> = {}): SourceRefOut => ({
  key: "prom", type: "prometheus", type_guessed: false, name: "Prometheus", detail: "http://prometheus.example.invalid:9090",
  suggestion: "s1", leave_out: false, reason: "Same name.", ...over,
});
const SKIPPED = [
  { where: 'Panel "CPU"', what: "Its unit", reason: "Grafana's unit percentunit has no match; it shows plain numbers." },
  { where: 'Panel "CPU"', what: "Its links", reason: "Panel links aren't copied." },
  { where: "The dashboard", what: "Annotations", reason: "Annotations aren't copied." },
];
const preview = (over: Partial<ImportPreviewOut> = {}): ImportPreviewOut => ({
  format: "grafana", format_label: "Grafana dashboard", target_kinds: ["project", "group"], suggested_target: null, bundle: null,
  sources: [promRef()], dashboards: [dash("a", "Node overview", { alerts: 1, skipped: SKIPPED })], skipped_total: 3, ...over,
});
const result = (...ds: [string, string][]): ImportResultOut => ({
  dashboards: ds.map(([id, title], i) => ({ key: String.fromCharCode(97 + i), id, title, owner_kind: "project", owner_id: "p1" })),
  group_id: null, grafana_id: null, warnings: [], alert_changes: [],
});
const contacts: AlertChangeOut = {
  target_id: "t1", rule_id: "r1", rule_name: "High CPU", project_id: "p1", project_name: "shop", kind: "contacts", message: null, cluster_id: "c1",
};

function setUp(seed: FakeMonitoringSeed = {}, start: MonitoringView = { page: "import", target: { kind: "project", id: "p1" } }) {
  const api = installFakeMonitoringApi({ projects: [SHOP, API], groups: [], ...seed, transfer: { previews: { [GRAFANA]: preview() }, ...seed.transfer } }, fallback);
  const app = renderMonitoringApp({ tabs: tabsWith(start) });
  return { api, app };
}
const commits = (api: ReturnType<typeof installFakeMonitoringApi>) =>
  api.requests.filter((r) => r.url === "/api/monitoring/import/commit").map((r) => r.body as ImportCommitIn);
const previews = (api: ReturnType<typeof installFakeMonitoringApi>) => api.requests.filter((r) => r.url === "/api/monitoring/import/preview");

/** Pasted JSON, then Ctrl+Enter in the text area: the review shows with the keyboard on its heading. */
async function pasteAndCheck(user: ReturnType<typeof userEvent.setup>, text = GRAFANA) {
  await user.click(await screen.findByRole("radio", { name: "Pasted JSON" }));
  const area = screen.getByRole("textbox", { name: "JSON to import" });
  expect((area as HTMLTextAreaElement).placeholder).toBe("Paste JSON here");
  await user.click(area);
  await user.paste(text);
  await user.keyboard("{Control>}{Enter}{/Control}");
  const heading = await screen.findByRole("heading", { name: "Review" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  return screen.getByRole("region", { name: "Review the import" });
}
const importButton = () => screen.getByRole("button", { name: /^(Import \d+ dashboards?|Importing…)$/ });

beforeEach(() => {
  localStorage.clear();
  enqueue.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const id of [...alertFormMarks.keys()]) clearAlertForms(id);
});

describe("the Import page", () => {
  it("I opens Import with focus on the heading and the current project as target", async () => {
    const user = userEvent.setup();
    const { app } = setUp({}, { page: "project", id: "p1" });
    await screen.findByRole("heading", { name: "shop", level: 1 });
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await user.keyboard("i");
    const heading = await screen.findByRole("heading", { name: "Import dashboards", level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(app.current().tabs[0].view).toEqual({ page: "import", target: { kind: "project", id: "p1" } });
    expect(screen.getByText("Bring in dashboards from an OmniKrux export or from Grafana. Nothing is saved until you've seen what converts.")).toBeTruthy();
    const from = screen.getByRole("radiogroup", { name: "Import from" });
    expect(within(from).getAllByRole("radio").map((r) => r.getAttribute("aria-describedby") && document.getElementById(r.getAttribute("aria-describedby")!)?.textContent))
      .toEqual(["An OmniKrux export or a Grafana dashboard, as .json", "A Grafana dashboard's JSON model, or an OmniKrux export", "Pick dashboards from a Grafana you connect"]);
    expect(screen.getByRole("button", { name: "Check what converts" }).getAttribute("aria-disabled")).toBe("true");
    const review = await pasteAndCheck(user);
    expect((within(review).getByLabelText("Goes to") as HTMLSelectElement).value).toBe("project:p1");
    expect(within(review).getByText("Grafana dashboard")).toBeTruthy();
  });

  it("a pasted Grafana dashboard shows what won't be copied", async () => {
    const user = userEvent.setup();
    const { api } = setUp();
    const review = await pasteAndCheck(user);
    expect(previews(api)[0].body).toEqual({ input: { kind: "text", text: GRAFANA, via: "paste" }, target: { kind: "project", id: "p1" } });
    expect(within(review).getByText("1 of 1 dashboards chosen · 3 things won't be copied")).toBeTruthy();
    expect((within(review).getByRole("checkbox", { name: "Import Node overview" }) as HTMLInputElement).checked).toBe(true);
    expect((within(review).getByRole("textbox", { name: "Title for Node overview" }) as HTMLInputElement).value).toBe("Node overview");
    expect(within(review).getByText("4 panels")).toBeTruthy();
    expect(within(review).getByText("1 alert")).toBeTruthy();
    const skipped = within(review).getByRole("button", { name: "Skipped (3)" });
    expect(skipped.getAttribute("aria-expanded")).toBe("false");
    expect(within(review).queryByText("Its unit")).toBeNull();
    await user.click(skipped);
    expect(skipped.getAttribute("aria-expanded")).toBe("true");
    expect(within(review).getByText('Panel "CPU"')).toBeTruthy();
    expect(within(review).getByText("The dashboard")).toBeTruthy();
    const unit = within(review).getByText("Its unit").closest("li")!;
    expect(unit.textContent).toBe("Its unit — Grafana's unit percentunit has no match; it shows plain numbers.");
    // Leaving the only dashboard out: nothing to import.
    await user.click(within(review).getByRole("checkbox", { name: "Import Node overview" }));
    expect(within(review).getByText("0 of 1 dashboards chosen · everything converts")).toBeTruthy();
    expect(importButton().textContent).toBe("Import 0 dashboards");
    expect(importButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("the mapping offers the project's sources and leave out", async () => {
    const user = userEvent.setup();
    const { api } = setUp({ transfer: { commits: [result(["d1", "Node overview"], ["d2", "Disks"])] } });
    const review = await pasteAndCheck(user);
    expect(within(review).getByRole("columnheader", { name: "In the file" })).toBeTruthy();
    expect(within(review).getByRole("columnheader", { name: "Uses here" })).toBeTruthy();
    expect(within(review).getByText("Prometheus (Prometheus-compatible)")).toBeTruthy();
    const select = within(review).getByRole("combobox", { name: "Source for Prometheus" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["First Prometheus-compatible source (prom-main)", "prom-main", "prom-edge", "Leave its panels out"]);
    expect(select.value).toBe("src:s1");
    expect(within(review).getByText("Same name.")).toBeTruthy();
    await user.selectOptions(select, "Leave its panels out");
    expect(within(review).queryByText("Same name.")).toBeNull();
    await user.click(importButton());
    await screen.findByRole("heading", { name: "Imported" });
    expect(commits(api)[0]).toEqual({
      input: { kind: "text", text: GRAFANA, via: "paste" }, target: { kind: "project", id: "p1" }, new_group: null,
      mapping: [{ key: "prom", leave_out: true }], dashboards: [{ key: "a", title: "Node overview", digest: "dg-a" }],
    });
  });

  it("a group target replaces the mapping with the group line", async () => {
    const user = userEvent.setup();
    const { api } = setUp({ groups: [group("g1", "fleet", ["p1", "p2"])], transfer: { commits: [result(["d1", "A"], ["d2", "B"])] } });
    const review = await pasteAndCheck(user);
    const to = within(review).getByLabelText("Goes to") as HTMLSelectElement;
    expect([...to.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Projects", "Groups"]);
    await user.selectOptions(to, "fleet");
    expect(await within(review).findByText("In a group dashboard each project uses its own source.")).toBeTruthy();
    expect(within(review).queryByRole("combobox", { name: "Source for Prometheus" })).toBeNull();
    // Titles and suggestions depend on the target: checked again for the group.
    await waitFor(() => expect(previews(api).at(-1)?.body).toMatchObject({ target: { kind: "group", id: "g1" } }));
    await waitFor(() => expect(importButton().getAttribute("aria-disabled")).toBeNull());
    expect(document.activeElement).toBe(to);
    await user.click(importButton());
    await screen.findByRole("heading", { name: "Imported" });
    expect(commits(api)[0]).toMatchObject({ target: { kind: "group", id: "g1" }, mapping: [] });
  });

  it("importing one dashboard opens it", async () => {
    const user = userEvent.setup();
    const { api, app } = setUp({
      dashboards: { d9: seedDashboard("d9", { kind: "project", id: "p2", name: "api" }, spec("Node overview", [])) },
      transfer: { commits: [{ ...result(["d9", "Node overview"]), alert_changes: [contacts] }] },
    });
    await pasteAndCheck(user);
    await user.click(importButton());
    const title = await screen.findByRole("heading", { name: "Node overview", level: 1 });
    expect(app.current().tabs[0].view).toEqual({ page: "dashboard", id: "d9" });
    // The tab's view was replaced: Back doesn't return to the import.
    expect(app.current().tabs[0].back).toEqual([]);
    expect(readRecent().some((r) => r.kind === "dashboard" && r.id === "d9")).toBe(true);
    expect(commits(api)).toHaveLength(1);
    // Its alert reviews open over it, then the keyboard returns to its title.
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith([contacts], { focus: title });
  });

  it("importing several lists them with Open", async () => {
    const user = userEvent.setup();
    const { app } = setUp({
      dashboards: {
        d1: seedDashboard("d1", { kind: "project", id: "p2", name: "api" }, spec("Node overview", [])),
        d2: seedDashboard("d2", { kind: "project", id: "p2", name: "api" }, spec("Disks", [])),
      },
      transfer: { commits: [{ ...result(["d1", "Node overview"], ["d2", "Disks"]), warnings: ["Grafana answered slowly."] }] },
    });
    await pasteAndCheck(user);
    await user.click(importButton());
    const imported = await screen.findByRole("heading", { name: "Imported" });
    await waitFor(() => expect(document.activeElement).toBe(imported));
    const panel = imported.closest("section")!;
    expect(within(panel).getByText("Grafana answered slowly.")).toBeTruthy();
    expect(within(panel).getByText("Disks")).toBeTruthy();
    // Ctrl+Enter on Open: a new tab; the list stays.
    within(panel).getByRole("button", { name: "Open Disks" }).focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(app.current().tabs).toHaveLength(2));
    expect(app.current().tabs[1].view).toEqual({ page: "dashboard", id: "d2" });
    cleanup();
    // Open: this tab, as a page.
    const again = setUp({
      dashboards: { d1: seedDashboard("d1", { kind: "project", id: "p2", name: "api" }, spec("Node overview", [])) },
      transfer: { commits: [result(["d1", "Node overview"], ["d2", "Disks"])] },
    });
    await pasteAndCheck(user);
    await user.click(importButton());
    await user.click(await screen.findByRole("button", { name: "Open Node overview" }));
    await screen.findByRole("heading", { name: "Node overview", level: 1 });
    expect(again.app.current().tabs[0].view).toEqual({ page: "dashboard", id: "d1" });
  });

  it("an import's alert changes open their reviews", async () => {
    const user = userEvent.setup();
    setUp({ transfer: { commits: [{ ...result(["d1", "A"], ["d2", "B"]), alert_changes: [contacts] }] } });
    await pasteAndCheck(user);
    await user.click(importButton());
    const imported = await screen.findByRole("heading", { name: "Imported" });
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith([contacts], { focus: imported });
    cleanup();
    enqueue.mockClear();
    setUp({ transfer: { commits: [result(["d1", "A"], ["d2", "B"])] } });
    await pasteAndCheck(user);
    await user.click(importButton());
    await screen.findByRole("heading", { name: "Imported" });
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a taken title focuses its field with the words", async () => {
    const user = userEvent.setup();
    const taken = 'A dashboard named "Node overview" already exists in shop. Pick another name.';
    const { api } = setUp({
      dashboards: { d0: seedDashboard("d0", { kind: "project", id: "p1", name: "shop" }, spec("Old board", [])) },
      transfer: { commits: { status: 409, detail: { code: "name_taken", message: taken, key: "a", problems: [] } } },
    });
    const review = await pasteAndCheck(user);
    const title = within(review).getByRole("textbox", { name: "Title for Node overview" });
    // Typed: a title the project already uses is named before anything is sent.
    await user.clear(title);
    await user.type(title, "Old board");
    expect(within(review).getByText('A dashboard named "Old board" already exists in shop. Pick another name.')).toBeTruthy();
    expect(importButton().getAttribute("aria-disabled")).toBe("true");
    await user.clear(title);
    await user.type(title, "Node overview");
    // Refused by the server: its words under the row, the keyboard on the title.
    await user.click(importButton());
    expect(await within(review).findByText(taken)).toBeTruthy();
    expect(document.activeElement).toBe(title);
    expect(commits(api)).toHaveLength(1);
  });

  it("a changed source re-checks and says so", async () => {
    const user = userEvent.setup();
    const { api } = setUp({
      transfer: { commits: { status: 409, detail: { code: "changed", message: 'The dashboard "Node overview" changed since you checked it.', key: "a", problems: [] } } },
    });
    const review = await pasteAndCheck(user);
    const title = within(review).getByRole("textbox", { name: "Title for Node overview" });
    await user.clear(title);
    await user.type(title, "Nodes here");
    expect(previews(api)).toHaveLength(1);
    await user.click(importButton());
    expect(await within(review).findByText(CHANGED)).toBeTruthy();
    await waitFor(() => expect(previews(api)).toHaveLength(2));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review" })));
    // What the user chose stays.
    expect((within(review).getByRole("textbox", { name: "Title for Node overview" }) as HTMLInputElement).value).toBe("Nodes here");
  });

  it("a project export without projects points to setup", async () => {
    const user = userEvent.setup();
    const exported = preview({
      format: "omnikrux_project", format_label: "OmniKrux project export", target_kinds: ["project"],
      bundle: {
        kind: "project", name: "shop", project_kind: "kubernetes", cluster: "prod", projects: [],
        sources: [{ key: "x1", name: "prom-main", type: "prometheus", where: "prod/monitoring/prometheus:9090", filter: 'namespace="shop"', auth: "bearer" },
          { key: "x2", name: "logs", type: "loki", where: "http://loki.example.invalid:3100", filter: null, auth: "none" }],
      },
    });
    const { app } = setUp({ projects: [], transfer: { previews: { [GRAFANA]: exported } } }, { page: "import" });
    const review = await pasteAndCheck(user);
    expect(within(review).getByText("Set up a project first, then import into it.")).toBeTruthy();
    expect(within(review).queryByLabelText("Goes to")).toBeNull();
    expect(importButton().getAttribute("aria-disabled")).toBe("true");
    const used = within(review).getByText("What the exported project used").closest("details")!;
    expect([...used.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "A Kubernetes cluster", "Cluster prod",
      'prom-main · Prometheus-compatible · prod/monitoring/prometheus:9090 · Filter: namespace="shop"',
      "logs · Loki · http://loki.example.invalid:3100 · Filter: none",
    ]);
    expect(within(used).getByText("Passwords and tokens aren't in exports. A source that needs them asks for them when you add it.")).toBeTruthy();
    // The review lives on this tab's page only: opening another tab asks first.
    await user.click(within(review).getByRole("button", { name: "Set up a project" }));
    const leave = await screen.findByRole("alertdialog");
    expect(within(leave).getByText("Leaving loses what you entered in this form.")).toBeTruthy();
    await user.click(within(leave).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(app.current().tabs).toHaveLength(2));
    expect(app.current().tabs[1].view).toEqual({ page: "setup" });
  });

  it("a group export can make a new group", async () => {
    const user = userEvent.setup();
    const exported = preview({
      format: "omnikrux_group", format_label: "OmniKrux group export", target_kinds: ["group"], sources: [],
      bundle: { kind: "group", name: "Fleet", project_kind: null, cluster: null, sources: [], projects: ["shop", "api"] },
    });
    const { api } = setUp({
      groups: [group("g0", "Fleet", ["p1"])],
      transfer: { previews: { [GRAFANA]: exported }, commits: [result(["d1", "A"], ["d2", "B"])] },
    });
    const review = await pasteAndCheck(user);
    const to = within(review).getByLabelText("Goes to") as HTMLSelectElement;
    // The page's project can't take a group export: nothing is picked yet.
    expect(to.value).toBe("");
    expect(importButton().getAttribute("aria-disabled")).toBe("true");
    expect(within(to).queryByRole("option", { name: "shop" })).toBeNull();
    await user.selectOptions(to, "A new group…");
    expect((within(review).getByLabelText("Group name") as HTMLInputElement).value).toBe("Fleet (2)");
    const projects = within(review).getByRole("group", { name: "Projects" });
    expect(within(projects).getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked)).toEqual([true, true]);
    await user.click(within(projects).getByRole("checkbox", { name: "api" }));
    await user.click(importButton());
    await screen.findByRole("heading", { name: "Imported" });
    expect(commits(api)[0]).toMatchObject({ target: null, new_group: { name: "Fleet (2)", project_ids: ["p1"] }, mapping: [] });
  });

  it("a file over 10 MB is refused before reading", async () => {
    const user = userEvent.setup();
    const { app } = setUp();
    await screen.findByRole("heading", { name: "Import dashboards" });
    expect(screen.getByText("or drop a .json file here")).toBeTruthy();
    const input = app.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".json,application/json");
    const big = new File(["{}"], "huge.json", { type: "application/json" });
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    const read = vi.spyOn(big, "text");
    await user.upload(input, big);
    expect(await screen.findByText("That file is larger than 10 MB. Export fewer dashboards at a time.")).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Check what converts" }).getAttribute("aria-disabled")).toBe("true");
    // A file that fits is read and named.
    await user.upload(input, new File([GRAFANA], "nodes.json", { type: "application/json" }));
    expect(await screen.findByText(`nodes.json · ${GRAFANA.length} bytes`)).toBeTruthy();
    expect(screen.queryByText("That file is larger than 10 MB. Export fewer dashboards at a time.")).toBeNull();
    expect(screen.getByRole("button", { name: "Check what converts" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("the whole flow works from the keyboard", async () => {
    const user = userEvent.setup();
    const { api, app } = setUp({
      dashboards: { d1: seedDashboard("d1", { kind: "project", id: "p2", name: "api" }, spec("Node overview", [])) },
      transfer: { commits: [result(["d1", "Node overview"], ["d2", "Disks"])] },
    });
    const onBody = () => expect(document.activeElement).not.toBe(document.body);
    /** One key press, then the keyboard is somewhere on the page. */
    const press = async (keys: string) => { await user.keyboard(keys); onBody(); };
    const tab = async () => { await user.tab(); onBody(); };
    const heading = await screen.findByRole("heading", { name: "Import dashboards" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // One Tab stop for the group; ↓ moves to Pasted JSON and picks it.
    await tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "A file" }));
    await press("{ArrowDown}");
    const pasted = screen.getByRole("radio", { name: "Pasted JSON" }) as HTMLInputElement;
    expect(document.activeElement).toBe(pasted);
    expect(pasted.checked).toBe(true);
    await tab();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "JSON to import" }));
    await user.paste(GRAFANA);
    onBody();
    // Esc leaves the text for the check button; Enter checks.
    await press("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Check what converts" }));
    await press("{Enter}");
    const review = await screen.findByRole("heading", { name: "Review" });
    await waitFor(() => expect(document.activeElement).toBe(review));
    // Through the review to a title field, never on <body>.
    const title = screen.getByRole("textbox", { name: "Title for Node overview" });
    for (let i = 0; i < 12 && document.activeElement !== title; i++) await tab();
    expect(document.activeElement).toBe(title);
    await tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Skipped (3)" }));
    await tab();
    expect(document.activeElement).toBe(importButton());
    expect(importButton().getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    // Back to the title: Ctrl+Enter anywhere in the review imports.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(title);
    await press("{Control>}{Enter}{/Control}");
    const imported = await screen.findByRole("heading", { name: "Imported" });
    await waitFor(() => expect(document.activeElement).toBe(imported));
    expect(commits(api)).toHaveLength(1);
    await tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open Node overview" }));
    await press("{Enter}");
    await screen.findByRole("heading", { name: "Node overview", level: 1 });
    expect(app.current().tabs[0].view).toEqual({ page: "dashboard", id: "d1" });
    await waitFor(onBody);
  });

  it("a failed re-check never leaves an old result importable", async () => {
    const user = userEvent.setup();
    const words = "OmniKrux couldn't check that just now. Try again.";
    const stale = "This result is out of date. Check what converts again before importing.";
    // The second preview fails: after a Goes to change.
    const { api } = setUp({ groups: [group("g1", "fleet", ["p1", "p2"])] });
    let n = 0;
    intercept((url) => (url === "/api/monitoring/import/preview" && ++n === 2 ? serverFailure(500, "invalid_input", words) : null));
    const review = await pasteAndCheck(user);
    await user.selectOptions(within(review).getByLabelText("Goes to"), "fleet");
    expect(await within(review).findByText(words)).toBeTruthy();
    expect(within(review).getByText(stale)).toBeTruthy();
    expect(importButton().getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(commits(api)).toHaveLength(0);
    // Checking again makes it current.
    await user.click(screen.getByRole("button", { name: "Check what converts" }));
    await waitFor(() => expect(within(review).queryByText(stale)).toBeNull());
    expect(within(review).getByText("In a group dashboard each project uses its own source.")).toBeTruthy();
    expect(importButton().getAttribute("aria-disabled")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    // After a 409 `changed`: never "Here is the new result." over the old one.
    const again = setUp({
      transfer: { commits: { status: 409, detail: { code: "changed", message: "It changed.", key: "a", problems: [] } } },
    });
    n = 0;
    intercept((url) => (url === "/api/monitoring/import/preview" && ++n === 2 ? serverFailure(500, "invalid_input", words) : null));
    const second = await pasteAndCheck(user);
    await user.click(importButton());
    expect(await within(second).findByText(words)).toBeTruthy();
    expect(within(second).getByText(stale)).toBeTruthy();
    expect(within(second).queryByText(CHANGED)).toBeNull();
    expect(importButton().getAttribute("aria-disabled")).toBe("true");
    expect(commits(again.api)).toHaveLength(1);
  });

  it("a gone target and an unlinked source are named where they are", async () => {
    const user = userEvent.setup();
    const gone = "That project or group no longer exists.";
    setUp({ transfer: { commits: { status: 404, detail: { code: "not_found", message: gone, key: null, problems: [] } } } });
    let review = await pasteAndCheck(user);
    await user.click(importButton());
    expect(await within(review).findByText(gone)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByLabelText("Goes to")));
    cleanup();

    const unlinked = "prom-main isn't linked to shop. Pick one of its sources.";
    setUp({ transfer: { commits: { status: 422, detail: { code: "unlinked_source", message: unlinked, key: "prom", problems: [] } } } });
    review = await pasteAndCheck(user);
    await user.click(importButton());
    expect(await within(review).findByText(unlinked)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("combobox", { name: "Source for Prometheus" })));
  });

  it("unsaved work holds the tab by its title only", async () => {
    const user = userEvent.setup();
    setUp();
    await pasteAndCheck(user);
    const marks = [...alertFormMarks.values()].flatMap((m) => [...m.values()]);
    expect(marks).toEqual([{ title: "Import dashboards", page: "import" }]);
    expect(JSON.stringify(marks)).not.toContain("Node overview");
    // Nothing of the file or the preview reaches the browser's storage.
    expect(JSON.stringify({ ...localStorage })).not.toContain("Node overview");
  });
});
