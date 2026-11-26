import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Plan } from "../../../api/types";
import { AllShortcuts } from "../../../features/chrome/ShortcutBar";
import { allGroups } from "../../../features/chrome/shortcuts";
import type { LinkOut } from "../../api/types";
import { installFakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../../test/renderMonitoringApp";
import { alertsKeys, type FiringOut, type OverviewOut, type RuleOut, type TargetOut } from "../api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const link: LinkOut = { source_id: "s1", source_name: "Prometheus", source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false };
const dev = { ...seedProject("p1", "kind-omnikrux-dev"), links: [link] };
const east = { ...seedProject("p2", "prod-east"), links: [link] };

const target = (id: string, project: { id: string; name: string }, over: Partial<TargetOut> = {}): TargetOut => ({
  id, project_id: project.id, project_name: project.name, engine: "omnikrux", tool: null, where: "checked by OmniKrux", engine_note: null,
  state: "ok", state_since: ago(30), last_eval_at: ago(0.5), message: null, eval_expr: `expr_${id}`, rule_text: `rule_${id} > 5`,
  tool_state: null, tool_message: null, leaving: false, instances: [], ...over,
});

const rule = (id: string, name: string, project: { id: string; name: string }, over: Partial<RuleOut> = {}): RuleOut => ({
  id, name, scope: { kind: "project", id: project.id, name: project.name }, source_type: "prometheus", source_id: null, expr: "up",
  condition: { of: "each", op: "above", threshold: 5, for: "5m", every: "1m" }, severity: "warning", message: "",
  contact_points: [], engine: "omnikrux", channel: null, paused: false, origin: "page", panel: null, state: "ok", firing_since: null,
  targets: [target(`t-${id}`, project)], removing: false, version: 1, created_at: ago(90), updated_at: ago(90), ...over,
});

const crash = rule("r1", "PodCrashLooping", dev, {
  state: "firing", firing_since: ago(12), severity: "critical", contact_points: [{ id: "c1", name: "Slack #ops", type: "slack" }],
  targets: [target("t-r1", dev, {
    state: "firing", state_since: ago(12),
    instances: [{ labels: { namespace: "demo", pod: "crasher" }, state: "firing", active_since: ago(12), fired_at: ago(12), value: 7, silenced: false, message: null }],
  })],
});
const nodes = rule("r2", "NodeNotReady", dev);
const latency = rule("r3", "LatencyHigh", east);

const firing = (r: RuleOut, minutes: number): FiringOut => ({
  rule_id: r.id, rule_name: r.name, target_id: r.targets[0].id, project_id: r.scope.id, project_name: r.scope.name, severity: r.severity,
  since: ago(minutes), instances: 1, silenced: 0, summary: "", where: "checked by OmniKrux",
});

const overview = (f: FiringOut[], engine: Partial<OverviewOut["engine"]> = {}): OverviewOut => ({
  counts: { rules: 3, firing: f.length, pending: 0, cant_check: 0, not_applied: 0 }, firing: f, by_project: {}, by_group: {},
  engine: {
    enabled: true, running: true, last_tick_at: "2026-11-23T10:15:30", rules: 3, behind: 0,
    note: "Rules checked by OmniKrux run only while OmniKrux is running. Rules that run in Prometheus or Loki keep firing when it's off.",
    ...engine,
  },
});

function open(seed: Partial<FakeMonitoringState> = {}, fallback?: (url: string, init?: RequestInit) => Promise<Response>) {
  const api = installFakeMonitoringApi({
    projects: [dev, east], rules: [crash, nodes, latency], overview: overview([firing(crash, 12)]),
    queryAnswers: { "expr_t-r1": { series: [] }, "expr_t-r2": { series: [] }, "expr_t-r3": { series: [] } },
    ...seed,
  }, fallback);
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "alerts" }) });
  return { api, app };
}

const details = () => screen.getByRole("heading", { level: 2 });
const options = () => within(screen.getByRole("listbox", { name: "Alert rules" })).getAllByRole("option");
const view = (app: ReturnType<typeof open>["app"]) => app.current().tabs[0].view;

describe("the Alerts page", () => {
  it("the page opens with focus on Alerts and the engine note", async () => {
    open();
    const title = await screen.findByRole("heading", { name: "Alerts", level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(title));
    const note = await screen.findByRole("note");
    await waitFor(() => expect(note.textContent).toBe(
      "Rules checked by OmniKrux run only while OmniKrux is running. Rules that run in Prometheus or Loki keep firing when it's off. Last check 10:15:30.",
    ));
    expect(note.getAttribute("data-tone")).toBe("muted");
    const tabs = within(screen.getByRole("tablist", { name: "Alerts views" })).getAllByRole("tab");
    expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-keyshortcuts")])).toEqual([["Rules1", "1"], ["Silences", "2"], ["Contact points", "3"]]);
    const create = screen.getByRole("button", { name: "New alert rule" });
    expect(create.getAttribute("aria-disabled")).toBeNull();
    expect(create.getAttribute("title")).toBeNull();
    // Firing pinned on top; the first rule is shown.
    await waitFor(() => expect(options().map((o) => o.getAttribute("aria-label"))).toEqual([
      "PodCrashLooping, 12m", "NodeNotReady, ok", "PodCrashLooping, firing", "LatencyHigh, ok",
    ]));
    expect(details().textContent).toBe("PodCrashLooping");
    const facts = document.querySelector("dl")!;
    expect(facts.textContent).toMatch(/StateFiring for 12 min( \d+ s)? in kind-omnikrux-dev · demo\/crasher/);
    expect(facts.textContent).toContain("NotifiesSlack #ops");
    expect(facts.textContent).toContain("Checksevery 1 min · fires after 5 min");
    expect(facts.textContent).toContain("SeverityCritical");
    expect(screen.getByText("rule_t-r1 > 5").tagName).toBe("PRE");
  });

  it("a silenced firing rule still reads Firing and says it is silenced", async () => {
    const one = (silenced: boolean, pod: string) => ({ labels: { namespace: "demo", pod }, state: "firing" as const, active_since: ago(12), fired_at: ago(12), value: 7, silenced, message: null });
    const muted = { ...crash, targets: [{ ...crash.targets[0], instances: [one(true, "a"), one(true, "b")] }] };
    open({ rules: [muted, nodes, latency], overview: overview([{ ...firing(muted, 12), instances: 2, silenced: 2 }]) });
    await waitFor(() => expect(options().map((o) => o.getAttribute("aria-label"))).toEqual([
      "PodCrashLooping, 12m, silenced", "NodeNotReady, ok", "PodCrashLooping, firing, silenced", "LatencyHigh, ok",
    ]));
    expect(within(options()[0]).getByText("Silenced")).toBeTruthy();
    const facts = document.querySelector("dl")!;
    expect(facts.textContent).toMatch(/StateFiring for 12 min( \d+ s)? in kind-omnikrux-dev · demo\/a · silenced/);
    cleanup();

    // Some of them: the details count them, the list row carries no tag.
    const some = { ...crash, targets: [{ ...crash.targets[0], instances: [one(true, "a"), one(false, "b")] }] };
    open({ rules: [some, nodes, latency], overview: overview([{ ...firing(some, 12), instances: 2, silenced: 1 }]) });
    await waitFor(() => expect(options()[0].getAttribute("aria-label")).toBe("PodCrashLooping, 12m"));
    expect(within(options()[0]).queryByText("Silenced")).toBeNull();
    expect(document.querySelector("dl")!.textContent).toMatch(/· 1 of 2 silenced/);
  });

  it("a late or turned-off engine says so in the warn tone", async () => {
    open({ overview: overview([], { behind: 4, note: "OmniKrux's alert checks are running late (4 rules waiting). Results may be delayed." }) });
    const note = await screen.findByText(/running late/);
    expect(note.closest('[role="note"]')!.getAttribute("data-tone")).toBe("warn");
  });

  it("arrow keys show each rule at once", async () => {
    const user = userEvent.setup();
    const { app } = open();
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.click(options()[0]);
    expect(document.activeElement).toBe(options()[0]);
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(details().textContent).toBe("NodeNotReady"));
    expect(document.activeElement).toBe(options()[1]);
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(view(app)).toEqual({ page: "alerts", rule: "r2" });
    // A replace: Back leaves the page, not each rule.
    expect(app.current().tabs[0].back).toHaveLength(0);
    await user.keyboard("{End}");
    await waitFor(() => expect(details().textContent).toBe("LatencyHigh"));
    expect(document.activeElement).toBe(options()[3]);
    await user.keyboard("{Home}");
    await waitFor(() => expect(details().textContent).toBe("PodCrashLooping"));
    expect(document.activeElement).toBe(options()[0]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Enter goes to the details and Esc comes back", async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.click(options()[1]);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(details());
    expect(details().textContent).toBe("NodeNotReady");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(options()[1]);
  });

  it("on a narrow window Enter opens the details and Esc goes back", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("719px"), addEventListener() {}, removeEventListener() {} }));
    open();
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.click(options()[1]);
    // A click shows the rule in place of the list.
    await waitFor(() => expect(document.activeElement).toBe(details()));
    expect(screen.queryByRole("listbox", { hidden: false })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(options()[1]));
    expect(screen.getByRole("heading", { level: 2, hidden: true }).closest("[hidden]")).not.toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(details()));
    expect(details().textContent).toBe("PodCrashLooping");
    // Esc on Back to the rules goes back too.
    screen.getByRole("button", { name: "Back to the rules" }).focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(options()[2]));
  });

  it("1 2 3 switch the views", async () => {
    const user = userEvent.setup();
    const { app } = open();
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.click(options()[1]);
    await user.keyboard("2");
    const silences = screen.getByRole("tab", { name: "Silences" });
    await waitFor(() => expect(silences.getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(silences);
    expect(view(app)).toEqual({ page: "alerts", tab: "silences", rule: "r2" });
    await user.keyboard("3");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Contact points" }).getAttribute("aria-selected")).toBe("true"));
    await user.keyboard("1");
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(details().textContent).toBe("NodeNotReady");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /^Rules/ }));
    expect(app.current().tabs[0].back).toHaveLength(0);
  });

  it("a panel rule offers Edit on its panel", async () => {
    const user = userEvent.setup();
    const fromPanel = rule("r9", "SlowCheckout", dev, {
      origin: "panel", panel: { dashboard_id: "d1", dashboard_title: "Shop", panel_id: "p-3", panel_title: "Latency" },
    });
    const { app } = open({ rules: [fromPanel], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("SlowCheckout"));
    expect(screen.queryByRole("button", { name: "Edit rule" })).toBeNull();
    expect(screen.getByRole("button", { name: "Latency on Shop" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: "Attach to a panel…" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Edit on its panel" }));
    await waitFor(() => expect(view(app)).toEqual({ page: "dashboard", id: "d1", panel: "p-3", editAlert: true }));
  });

  it("pause is disabled for a tool rule with the reason", async () => {
    const user = userEvent.setup();
    const inTool = rule("r7", "ApiDown", dev, {
      engine: "tool", targets: [target("t-r7", dev, { engine: "tool", tool: "prometheus_rule", where: "in Prometheus", tool_state: "in_sync" })],
    });
    const { api } = open({ rules: [inTool], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("ApiDown"));
    expect(screen.getByText("in Prometheus")).toBeTruthy();
    expect(document.querySelector("dl")!.textContent).toContain("NotifiesWherever its Alertmanager sends it");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const pause = screen.getByRole("menuitem", { name: "Pause" });
    expect(pause.getAttribute("aria-disabled")).toBe("true");
    expect(pause.getAttribute("title")).toBe("This rule runs in the tool, which keeps checking it. Silence it instead.");
    const attach = screen.getByRole("menuitem", { name: "Attach to a panel…" });
    expect(attach.getAttribute("aria-disabled")).toBeNull();
    expect(attach.getAttribute("title")).toBeNull();
    await user.click(pause);
    expect(api.requests.some((r) => r.url.endsWith("/pause"))).toBe(false);
    // Silence is ready (its own tests are with the silences); Edit rule works for a tool's rule too.
    expect(screen.getByRole("button", { name: "Silence" }).getAttribute("aria-keyshortcuts")).toBe("s");
    expect(screen.getByRole("button", { name: "Silence" }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("button", { name: "Silence" }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit rule" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("not applied shows Review and Retry by tool state", async () => {
    const user = userEvent.setup();
    const plan: Plan = {
      plan_id: "plan-1", action: "create",
      target: { cluster_id: "c1", kind_key: "prometheusrules.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-api-1a2b" },
      kind: "PrometheusRule", cluster: { id: "c1", name: "kind-dev", provider: "kind", environment: "development" },
      title: "Create PrometheusRule omnikrux-api-1a2b", summary: ["Create PrometheusRule monitoring/omnikrux-api-1a2b with 1 rule."],
      warnings: [], blocked: [], diff: null, confirm_text: null, apply_label: "Create", expires_at: "2026-11-23T10:05:00Z",
    };
    const toolTarget = (id: string, over: Partial<TargetOut>) => target(id, dev, { engine: "tool", tool: "prometheus_rule", where: "in Prometheus", state: "not_applied", ...over });
    const review = rule("r5", "ApiReview", dev, { engine: "tool", state: "not_applied", targets: [toolTarget("t5", { tool_state: "needs_review", tool_message: "Review the change to apply it." })] });
    const retry = rule("r6", "ApiRetry", dev, { engine: "tool", state: "not_applied", targets: [toolTarget("t6", { tool_state: "failed", tool_message: "The cluster refused it." })] });
    const loki = rule("r8", "LogsRetry", east, {
      engine: "tool", source_type: "loki", state: "not_applied",
      targets: [target("t8", east, { engine: "tool", tool: "loki_ruler", where: "in Loki", state: "not_applied", tool_state: "failed", tool_message: "Loki said no." })],
    });
    const fallback = (url: string) => Promise.resolve(new Response(JSON.stringify({ detail: `Not found ${url}` }), { status: 404 }));
    const { api, app } = open({
      rules: [review, retry, loki], overview: overview([]),
      syncAnswers: { t5: { kind: "review", plan }, t8: { kind: "done", target: { ...loki.targets[0], tool_message: "Loki still said no." } } },
    }, fallback);
    await waitFor(() => expect(options()).toHaveLength(3));
    app.navigate({ page: "alerts", rule: "r5" }, "replace");
    await waitFor(() => expect(details().textContent).toBe("ApiReview"));
    expect(screen.getByText("Not applied in kind-omnikrux-dev's cluster. Review the change to apply it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Create PrometheusRule omnikrux-api-1a2b");
    expect(api.requests.some((r) => r.method === "POST" && r.url.endsWith("/targets/t5/sync"))).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).not.toBe(document.body);

    // A failed apply: Retry (a cluster's goes through its review again).
    app.navigate({ page: "alerts", rule: "r6" }, "replace");
    await waitFor(() => expect(details().textContent).toBe("ApiRetry"));
    expect(screen.getByText("Not applied in kind-omnikrux-dev's cluster. The cluster refused it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();

    // Loki is written at once: Retry syncs it and says what Loki answered.
    app.navigate({ page: "alerts", rule: "r8" }, "replace");
    await waitFor(() => expect(details().textContent).toBe("LogsRetry"));
    expect(screen.getByText("Not applied in Loki. Loki said no.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", `"LogsRetry" couldn't be written to Loki: Loki still said no.`);
    expect(api.requests.some((r) => r.method === "POST" && r.url.endsWith("/targets/t8/sync"))).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a rule leaving its cluster stays shown until removed", async () => {
    const leaving = rule("r4", "OldRule", dev, {
      engine: "tool", removing: true,
      targets: [target("t4", dev, { engine: "tool", tool: "prometheus_rule", where: "in Prometheus", leaving: true, tool_state: "needs_review" })],
    });
    open({ rules: [leaving], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("OldRule"));
    expect(screen.getByText("Still in kind-omnikrux-dev's cluster: removing it needs a review.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("the chart shows its failure in words", async () => {
    open({ queryAnswers: { "expr_t-r1": { error: { code: "unreachable", message: "Prometheus didn't answer. Check that it's running." }, status: 502 } } });
    await waitFor(() => expect(details().textContent).toBe("PodCrashLooping"));
    expect(await screen.findByText("Prometheus didn't answer. Check that it's running.")).toBeTruthy();
    expect(screen.getByText("The rule's query over the last hour; the dashed line is the threshold.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("the chart's query runs per project with its project", async () => {
    const { api } = open();
    await waitFor(() => expect(details().textContent).toBe("PodCrashLooping"));
    await waitFor(() => expect(api.requests.some((r) => r.url.endsWith("/query/batch"))).toBe(true));
    const batch = api.requests.find((r) => r.url.endsWith("/query/batch"))!.body as { queries: Record<string, unknown>[] };
    expect(batch.queries).toEqual([expect.objectContaining({ project_id: "p1", source_id: "s1", kind: "range", query: "expr_t-r1", step: 30 })]);
    const q = batch.queries[0] as { start: number; end: number };
    expect(q.end - q.start).toBeGreaterThanOrEqual(3600);
  });

  it("history lists what happened, newest first", async () => {
    open({
      history: {
        r1: [
          { at: ago(12), kind: "firing", project_name: "kind-omnikrux-dev", labels: { namespace: "demo", pod: "crasher" }, value: 7, message: "Restarts" },
          { at: ago(80), kind: "applied", project_name: "kind-omnikrux-dev", labels: null, value: null, message: null },
        ],
        r2: [],
      },
    });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toMatch(/^\d\d:\d\dStarted firing · demo\/crasher · Restarts$/);
    expect(items[1]).toMatch(/^\d\d:\d\dApplied$/);
  });

  it("delete asks first and lists what goes with it", async () => {
    const user = userEvent.setup();
    const fromPanel = rule("r9", "SlowCheckout", dev, {
      origin: "panel", panel: { dashboard_id: "d1", dashboard_title: "Shop", panel_id: "p-3", panel_title: "Latency" },
    });
    const { api } = open({ rules: [fromPanel, nodes], overview: overview([]) });
    await waitFor(() => expect(options()).toHaveLength(2));
    // NodeNotReady sorts first; pick SlowCheckout.
    await user.click(options()[1]);
    await waitFor(() => expect(details().textContent).toBe("SlowCheckout"));
    const more = screen.getByRole("button", { name: "More actions" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete rule…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading").textContent).toBe('Delete the rule "SlowCheckout"?');
    await waitFor(() => expect(dialog.textContent).toContain(`Its panel "Latency" loses its alert; the dashboard saves a new version.`));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Delete rule" }));
    // Esc goes back to More actions and deletes nothing.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(more);
    expect(api.requests.some((r) => r.method === "DELETE")).toBe(false);

    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete rule…" }));
    await screen.findByRole("alertdialog");
    await waitFor(() => expect(screen.getByRole("alertdialog").textContent).toContain("loses its alert"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.requests.some((r) => r.method === "DELETE" && r.url.includes("/rules/r9?token="))).toBe(true);
    // The list selects the next rule left.
    await waitFor(() => expect(options()).toHaveLength(1));
    await waitFor(() => expect(details().textContent).toBe("NodeNotReady"));
    expect(document.activeElement).toBe(options()[0]);
  });

  it("the delete lists the cluster and Loki removals", async () => {
    const user = userEvent.setup();
    const inTool = rule("r7", "ApiDown", dev, { engine: "tool", targets: [target("t-r7", dev, { engine: "tool", tool: "prometheus_rule", tool_state: "in_sync" })] });
    const fallback = (url: string, init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ detail: `Not found ${url} ${init?.method}` }), { status: 404 }));
    installFakeMonitoringApi({ projects: [dev], rules: [inTool], overview: overview([]) }, fallback);
    // The fake's review lists no removals: answer this one by hand.
    const fake = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (url.endsWith("/rules/r7/delete-review")
      ? Promise.resolve(new Response(JSON.stringify({
        id: "r7", name: "ApiDown", panel: null, token: "review-token",
        cluster_removals: [{ target_id: "t-r7", project_name: "kind-omnikrux-dev", cluster_name: "kind-dev" }],
        loki_removals: [{ target_id: "t-x", project_name: "prod-east", cluster_name: null }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      : fake(url, init)));
    renderMonitoringApp({ tabs: tabsWith({ page: "alerts" }) });
    await waitFor(() => expect(details().textContent).toBe("ApiDown"));
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete rule…" }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog.textContent).toContain("It's also removed from kind-dev; that opens its own review."));
    expect(dialog.textContent).toContain("It's also removed from Loki.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("with no rules it says how to make one", async () => {
    open({ rules: [], overview: overview([]) });
    expect(await screen.findByText("No alert rules yet. Make one here, or from a panel's Alert tab.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("the Alerts group is in the ? sheet", () => {
    render(<AllShortcuts groups={allGroups(undefined, "monitoring")} onClose={() => {}} />);
    const group = screen.getByRole("region", { name: "Alerts" });
    expect(group.textContent).toContain("Rules, Silences or Contact points");
    expect(group.textContent).toContain("In the rule list: move and show the rule");
    expect(group.textContent).toContain("Silence the selected alert");
    expect(group.textContent).toContain("In the rule list: go to the rule's details");
    expect(group.textContent).toContain("In the details: back to the rule list");
    expect(group.textContent).toContain("In a rule, silence or contact point form: save it");
  });

  it("a failed refresh keeps the list, the details and the keyboard, and says so until a read works", async () => {
    const user = userEvent.setup();
    const { app } = open();
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.click(options()[1]);
    await waitFor(() => expect(details().textContent).toBe("NodeNotReady"));
    // A menu open in the details stays open through it.
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const pause = screen.getByRole("menuitem", { name: "Pause" });
    expect(document.activeElement).toBe(pause);

    const fake = globalThis.fetch;
    let down = true;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (down && url.endsWith("/alerts/rules")
      ? Promise.resolve(new Response(JSON.stringify({ detail: { code: "unreachable", message: "The server is restarting." } }), { status: 503 }))
      : fake(url, init)));
    await app.client.refetchQueries({ queryKey: alertsKeys.rules() });
    const note = await screen.findByText(/^Couldn't refresh: showing the list from \d\d:\d\d:\d\d\.$/);
    expect(note.closest('[role="status"]')!.getAttribute("aria-live")).toBe("polite");
    expect(options()).toHaveLength(4);
    expect(details().textContent).toBe("NodeNotReady");
    expect(screen.getByRole("menu", { name: "More actions" })).toBeTruthy();
    expect(document.activeElement).toBe(pause);

    down = false;
    await app.client.refetchQueries({ queryKey: alertsKeys.rules() });
    await waitFor(() => expect(screen.queryByText(/^Couldn't refresh/)).toBeNull());
    expect(document.activeElement).toBe(pause);
  });

  it("a failed overview refresh marks the pins, the count and the last check as old", async () => {
    const { app } = open();
    await waitFor(() => expect(options()).toHaveLength(4));
    const fake = globalThis.fetch;
    let down = true;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (down && url.endsWith("/alerts/overview")
      ? Promise.reject(new TypeError("Failed to fetch"))
      : fake(url, init)));
    await app.client.refetchQueries({ queryKey: alertsKeys.overview });
    // Under the list (for the pins) and in the engine note (for its last check).
    expect(await screen.findAllByText(/^Couldn't refresh: showing the list from \d\d:\d\d:\d\d\.$/)).toHaveLength(1);
    const engine = screen.getByRole("note");
    expect(engine.getAttribute("data-tone")).toBe("warn");
    expect(engine.textContent).toMatch(/Last check 10:15:30\. Couldn't refresh: showing the state from \d\d:\d\d:\d\d\.$/);
    expect(screen.getByLabelText(/^1 firing at \d\d:\d\d:\d\d$/)).toBeTruthy();
    // The pins stay shown.
    expect(options()[0].getAttribute("aria-label")).toMatch(/^PodCrashLooping, 1\dm$/);

    down = false;
    await app.client.refetchQueries({ queryKey: alertsKeys.overview });
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh/)).toBeNull());
    expect(screen.getByRole("note").getAttribute("data-tone")).toBe("muted");
    expect(screen.getByLabelText("1 firing")).toBeTruthy();
  });

  it("a Loki copy left behind by a move to OmniKrux shows, with Retry", async () => {
    const user = userEvent.setup();
    const left = (over: Partial<TargetOut>) => target("t-l", east, {
      engine: "omnikrux", tool: null, where: "checked by OmniKrux", tool_state: "failed",
      tool_message: "Couldn't remove the rule from Shop logs: Shop logs answered HTTP 500. Try again, or check the tool.", ...over,
    });
    const moved = rule("r10", "LogErrors", east, { source_type: "loki", targets: [left({ tool_copy: "loki_ruler" })] });
    const { api } = open({ rules: [moved], overview: overview([]), syncAnswers: { "t-l": { kind: "done", target: null } } });
    await waitFor(() => expect(details().textContent).toBe("LogErrors"));
    expect(screen.getByText(
      "Still in Loki. Couldn't remove the rule from Shop logs: Shop logs answered HTTP 500. Try again, or check the tool.",
    )).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.requests.filter((r) => r.url.endsWith("/targets/t-l/sync"))).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    // `tool_copy` null: nothing is in a tool (a cancelled review, a failed first write): no bar.
    open({ rules: [{ ...moved, targets: [left({ tool_copy: null, tool_state: "needs_review" })] }], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("LogErrors"));
    expect(screen.queryByText(/^Still in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    cleanup();

    // An answer without `tool_copy`: the rule's source type says where the copy is.
    open({ rules: [{ ...moved, targets: [left({})] }], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("LogErrors"));
    expect(screen.getByText(/^Still in Loki\. Couldn't remove/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a Loki retry that answers with a review opens it without syncing again", async () => {
    const user = userEvent.setup();
    const plan: Plan = {
      plan_id: "plan-9", action: "create",
      target: { cluster_id: "c1", kind_key: "prometheusrules.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-logs-9" },
      kind: "PrometheusRule", cluster: { id: "c1", name: "kind-dev", provider: "kind", environment: "development" },
      title: "Create PrometheusRule omnikrux-logs-9", summary: [], warnings: [], blocked: [], diff: null, confirm_text: null,
      apply_label: "Create", expires_at: "2026-11-23T10:05:00Z",
    };
    const loki = rule("r11", "LogsMoved", east, {
      engine: "tool", source_type: "loki", state: "not_applied",
      targets: [target("t11", east, { engine: "tool", tool: "loki_ruler", where: "in Loki", state: "not_applied", tool_state: "failed", tool_message: "Loki said no." })],
    });
    const fallback = (url: string) => Promise.resolve(new Response(JSON.stringify({ detail: `Not found ${url}` }), { status: 404 }));
    const { api } = open({ rules: [loki], overview: overview([]), syncAnswers: { t11: { kind: "review", plan } } }, fallback);
    await waitFor(() => expect(details().textContent).toBe("LogsMoved"));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Create PrometheusRule omnikrux-logs-9");
    expect(api.requests.filter((r) => r.url.endsWith("/targets/t11/sync"))).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Checked says Not checked yet while any place is unchecked", async () => {
    const group = rule("r12", "Fleet", dev, {
      scope: { kind: "group", id: "g1", name: "Production" },
      targets: [target("t12a", dev, { last_eval_at: ago(1) }), target("t12b", east, { last_eval_at: null })],
    });
    open({ rules: [group], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("Fleet"));
    expect(document.querySelector("dl")!.textContent).toContain("CheckedNot checked yet");
    expect(screen.getByRole("table", { name: "Per project" })).toBeTruthy();
  });

  it("a new rule reads Not checked yet until its first check, never OK", async () => {
    const fresh = rule("r13", "Fresh", dev, {
      state: "waiting",
      targets: [target("t13", dev, { state: "waiting", last_eval_at: null, message: "Not checked yet: the first check runs within 1 min." })],
    });
    open({ rules: [fresh], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("Fresh"));
    expect(options().map((o) => o.getAttribute("aria-label"))).toEqual(["Fresh, not checked yet"]);
    const facts = document.querySelector("dl")!.textContent!;
    expect(facts).toContain("StateNot checked yet: the first check runs within 1 min.");
    expect(facts).not.toMatch(/OK/);
  });

  it("From panel opens the dashboard with the panel", async () => {
    const user = userEvent.setup();
    const fromPanel = rule("r9", "SlowCheckout", dev, {
      origin: "panel", panel: { dashboard_id: "d1", dashboard_title: "Shop", panel_id: "p-3", panel_title: "Latency" },
    });
    const { app } = open({ rules: [fromPanel], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("SlowCheckout"));
    await user.click(screen.getByRole("button", { name: "Latency on Shop" }));
    await waitFor(() => expect(view(app)).toEqual({ page: "dashboard", id: "d1", panel: "p-3" }));
    expect(app.current().tabs[0].back).toHaveLength(1);
  });

  it("rule state names the project", async () => {
    open();
    await waitFor(() => expect(details().textContent).toBe("PodCrashLooping"));
    const facts = document.querySelector("dl")!;
    expect(facts.textContent).toMatch(/StateFiring for 12 min( \d+ s)? in kind-omnikrux-dev · demo\/crasher/);
    // The stored query is shown trimmed, and a rule that has run shows when.
    expect(facts.textContent).toMatch(/Checked\d\d:\d\d:\d\d/);
    cleanup();

    // Before its first check there is no Checked time beside "Not checked yet".
    const waiting = rule("r14", "Tooled", dev, {
      state: "waiting", engine: "tool",
      targets: [target("t14", dev, {
        state: "waiting", engine: "tool", tool: "prometheus_rule", where: "in Prometheus", last_eval_at: ago(1),
        rule_text: "\n(up\n) > 5\n\n", message: "Not checked yet: the first check runs within 1 min.",
      })],
    });
    open({ rules: [waiting], overview: overview([]) });
    await waitFor(() => expect(details().textContent).toBe("Tooled"));
    expect(document.querySelector("dl")!.textContent).not.toContain("Checked");
    expect(document.querySelector("pre")!.textContent).toBe("(up\n) > 5");
  });

  it("a silence view for an alert that stopped firing says so", async () => {
    const quiet = rule("r1", "PodCrashLooping", dev);
    const { app } = open({ rules: [quiet, nodes, latency], overview: overview([]) });
    app.navigate({ page: "alerts", tab: "silences", silence: { rule: "r1", target: "t-r1" } }, "replace");
    expect(await screen.findByText("That alert isn't firing any more, so there's nothing to prefill.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "New silence" })).toBeNull();
    await waitFor(() => expect(view(app)).toEqual({ page: "alerts", tab: "silences" }));
    expect(screen.getByRole("tab", { name: "Silences", selected: true })).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a silence ask is decided on a fresh read, not on an older list", async () => {
    const quiet = rule("r1", "PodCrashLooping", dev);
    const { api, app } = open({ rules: [quiet, nodes, latency], overview: overview([]) });
    // The list read earlier says it isn't firing; it has started firing since.
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    api.state.rules = [crash, nodes, latency];
    app.navigate({ page: "alerts", tab: "silences", silence: { rule: "r1", target: "t-r1" } }, "replace");
    const matchers = (await screen.findByLabelText("Matchers")) as HTMLInputElement;
    expect(matchers.value).toBe('alertname="PodCrashLooping",project="kind-omnikrux-dev"');
    expect(screen.queryByText("That alert isn't firing any more, so there's nothing to prefill.")).toBeNull();
    await waitFor(() => expect(view(app)).toEqual({ page: "alerts", tab: "silences" }));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("silenced alerts leave the counts", async () => {
    const muted = { ...overview([{ ...firing(crash, 12), instances: 1, silenced: 1 }]) };
    open({ overview: { ...muted, counts: { ...muted.counts, firing: 1, firing_unsilenced: 0 } } });
    await waitFor(() => expect(details().textContent).toBe("PodCrashLooping"));
    const rulesTab = screen.getByRole("tab", { name: /^Rules/ });
    expect(rulesTab.textContent).toBe("Rules");
    expect(screen.getByRole("button", { name: "Alerts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alerts, \d+ firing/ })).toBeNull();
  });

  it("a chart that can't reach the server says so in words", async () => {
    open();
    const fake = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => (url.endsWith("/query/batch")
      ? Promise.reject(new TypeError("Failed to fetch"))
      : fake(url, init)));
    await waitFor(() => expect(details().textContent).toBe("PodCrashLooping"));
    expect(await screen.findByText("OmniKrux didn't answer. Check that it's running, then try again.")).toBeTruthy();
    expect(screen.queryByText("Failed to fetch")).toBeNull();
  });
});
