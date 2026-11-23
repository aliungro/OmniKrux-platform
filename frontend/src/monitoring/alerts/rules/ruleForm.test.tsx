import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut, LinkOut, ProjectOut } from "../../api/types";
import { intercept } from "../../test/dashboardSeeds";
import { installFakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../../test/renderMonitoringApp";
import type { CapabilityOut, ContactPointOut, RuleIn, RuleOut, TargetOut } from "../api";
import { endRuleForm, ruleFormSessions } from "./formSessions";

afterEach(() => {
  cleanup();
  for (const id of [...ruleFormSessions.keys()]) endRuleForm(id);
  vi.unstubAllGlobals();
});

const T = "2026-01-01T00:00:00Z";
const link = (id: string, name: string, over: Partial<LinkOut> = {}): LinkOut => ({
  source_id: id, source_name: name, source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false, ...over,
});
const dev: ProjectOut = { ...seedProject("p1", "dev"), links: [link("s1", "Prometheus"), link("s4", "Logs", { source_type: "loki" })] };
const east: ProjectOut = { ...seedProject("p3", "prod-east", "kubernetes", { id: "c1", provider: "kind" }), links: [link("s2", "Central Prometheus")] };
const west: ProjectOut = {
  ...seedProject("p4", "prod-west", "kubernetes", { id: "c2", provider: "kind" }),
  links: [link("s2", "Central Prometheus", { filter: 'cluster="prod-west"', filter_origin: "auto" })],
};
const production: GroupOut = { id: "g1", name: "Production", project_ids: ["p3", "p4"], created_at: T, updated_at: T };

const target = (id: string, project: ProjectOut, over: Partial<TargetOut> = {}): TargetOut => ({
  id, project_id: project.id, project_name: project.name, engine: "omnikrux", tool: null, where: "checked by OmniKrux", engine_note: null,
  state: "ok", state_since: T, last_eval_at: T, message: null, eval_expr: "up", rule_text: "up > 5",
  tool_state: null, tool_message: null, leaving: false, instances: [], ...over,
});

const rule = (id: string, name: string, project: ProjectOut, over: Partial<RuleOut> = {}): RuleOut => ({
  id, name, scope: { kind: "project", id: project.id, name: project.name }, source_type: "prometheus", source_id: null, expr: "up",
  condition: { of: "each", op: "above", threshold: 5, for: "5m", every: "1m" }, severity: "warning", message: "",
  contact_points: [], engine: "omnikrux", channel: null, paused: false, origin: "page", panel: null, state: "ok", firing_since: null,
  targets: [target(`t-${id}`, project)], removing: false, version: 1, created_at: T, updated_at: T, ...over,
});

const latency = rule("rA", "LatencyHigh", dev);
const crossing = rule("rB", "NodesDown", east);

function open(seed: Partial<FakeMonitoringState> = {}, view: { rule?: string } = { rule: "rA" }) {
  const api = installFakeMonitoringApi({ projects: [dev, east, west], groups: [production], rules: [latency, crossing], ...seed });
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "alerts", ...view }) });
  return { api, app };
}

const details = () => screen.getByRole("heading", { level: 2 });
const posts = (api: ReturnType<typeof open>["api"]) => api.requests.filter((r) => r.method === "POST" && r.url.endsWith("/alerts/rules"));
const saveKeys = "{Control>}{Enter}{/Control}";

async function newRule(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(details().textContent).not.toBe(""));
  await user.click(screen.getByRole("button", { name: "New alert rule" }));
  await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "New alert rule" })).toBeTruthy());
}

describe("the rule form", () => {
  it("New alert rule opens the form with focus on Name, for the shown rule's project", async () => {
    const user = userEvent.setup();
    open();
    await newRule(user);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
    const forSelect = screen.getByLabelText("For") as HTMLSelectElement;
    await waitFor(() => expect(forSelect.selectedOptions[0]?.textContent).toBe("dev"));
    expect([...forSelect.options].map((o) => o.textContent)).toEqual(["dev", "prod-east", "prod-west", "Group · Production"]);
    const source = screen.getByLabelText("Source") as HTMLSelectElement;
    expect([...source.options].map((o) => o.textContent)).toEqual(["Prometheus (Prometheus-compatible)", "Logs (Loki)"]);
    await user.selectOptions(forSelect, "Group · Production");
    expect([...source.options].map((o) => o.textContent)).toEqual(["Each project's Prometheus-compatible source", "Each project's Loki source"]);
    const query = screen.getByLabelText("Query") as HTMLTextAreaElement;
    expect(query.getAttribute("spellcheck")).toBe("false");
    await user.type(query, "sum by (route) (rate(errors_total[[5m]))");
    expect(screen.getByRole("group", { name: "Alert when any route is above 0 for 5 min, checked every 1 min" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("saving a new rule selects it and queues its review", async () => {
    const user = userEvent.setup();
    const { api, app } = open({
      ruleChanges: [{ target_id: "t9", rule_id: "r1", rule_name: "Errors high", project_id: "p1", project_name: "dev", kind: "review", message: null }],
    });
    await newRule(user);
    await user.type(screen.getByLabelText("Name"), "Errors high");
    await user.type(screen.getByLabelText("Query"), "sum by (route) (rate(errors_total[[5m]))");
    const threshold = screen.getByLabelText("Threshold");
    await user.clear(threshold);
    await user.type(threshold, "2");
    await user.keyboard(saveKeys);
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    const sent = posts(api)[0].body as RuleIn;
    expect(sent).toEqual({
      name: "Errors high", scope: { kind: "project", id: "p1" }, source: { type: "prometheus", id: "s1" },
      expr: "sum by (route) (rate(errors_total[5m]))", condition: { of: "each", op: "above", threshold: 2, for: "5m", every: "1m" },
      severity: "warning", message: "", contact_point_ids: [], engine: "omnikrux", channel: null,
    });
    await waitFor(() => expect(details().textContent).toBe("Errors high"));
    expect(app.current().tabs[0].view).toEqual({ page: "alerts", rule: "r1" });
    expect(app.current().tabs[0].back).toHaveLength(0);
    // The review change was queued: its target is synced for a review.
    await waitFor(() => expect(api.requests.some((r) => r.method === "POST" && r.url.endsWith("/alerts/targets/t9/sync"))).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(details()));
    expect(screen.getAllByRole("option").some((o) => o.getAttribute("aria-label")?.startsWith("Errors high"))).toBe(true);
  });

  it("a stale save offers Open it again", async () => {
    const user = userEvent.setup();
    const { api } = open();
    await waitFor(() => expect(details().textContent).toBe("LatencyHigh"));
    await user.click(screen.getByRole("button", { name: "Edit rule" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: 'Edit "LatencyHigh"' })).toBeTruthy());
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe("LatencyHigh");
    // Saved somewhere else meanwhile.
    api.state.rules[0] = { ...api.state.rules[0], name: "Latency too high", version: 2 };
    await user.type(name, " now");
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    const alert = await screen.findByText("This rule was changed somewhere else since you opened it (version 2). Open it again.");
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    const again = screen.getByRole("button", { name: "Open it again" });
    await waitFor(() => expect(document.activeElement).toBe(again));
    await user.click(again);
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Latency too high"));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: 'Edit "Latency too high"' })).toBeTruthy();
  });

  it("a 422 focuses the field it names", async () => {
    const user = userEvent.setup();
    open();
    await newRule(user);
    await user.type(screen.getByLabelText("Query"), "up");
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    const words = await screen.findByText("Use 1 to 120 characters, without line breaks.");
    const name = screen.getByLabelText("Name");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(words.id);

    await user.type(name, "Up");
    expect(screen.queryByText("Use 1 to 120 characters, without line breaks.")).toBeNull();
    const refusal = "Uses $env, which isn't a variable here. Write the value into the query.";
    intercept((url, pass) => (url.endsWith("/alerts/rules") ? Promise.resolve(new Response(
      JSON.stringify({ detail: { code: "invalid_rule", message: refusal, field: "query" } }), { status: 422, headers: { "content-type": "application/json" } },
    )) : pass()));
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    await screen.findByText(refusal);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Query")));
  });

  it("a tool rule picks a channel instead of contact points", async () => {
    const user = userEvent.setup();
    const ops: ContactPointOut = {
      id: "c1", name: "Slack #ops", type: "slack", settings: {}, secrets_set: ["url"], summary: "Slack, #ops", used_by: [], last_delivery: null,
      created_at: T, updated_at: T,
    };
    const cap: CapabilityOut = { project_id: "p1", project_name: "dev", source_id: "s1", source_name: "Prometheus", tool: "prometheus_rule", reason: null };
    const pattern = 'Its route matches team=~"ops.*", a pattern OmniKrux can\'t send a label for.';
    const { api } = open({
      contactPoints: [ops], capabilities: [cap],
      channels: {
        p1: {
          alertmanager: { id: "am1", name: "Alertmanager" }, message: null,
          channels: [
            { receiver: "ops-slack", labels: { team: "ops" }, usable: false, reason: pattern },
            { receiver: "oncall", labels: { severity: "critical" }, usable: true, reason: null },
          ],
        },
      },
    });
    await newRule(user);
    const notify = await screen.findByRole("group", { name: "Notify" });
    expect(within(notify).getByRole("checkbox", { name: /Slack #ops/ })).toBeTruthy();
    expect(screen.queryByLabelText("Channel")).toBeNull();
    await waitFor(() => expect(screen.getByText("In Prometheus (dev), fires even when OmniKrux is off")).toBeTruthy());
    await user.click(screen.getByRole("radio", { name: "In the tool" }));
    expect(screen.queryByRole("group", { name: "Notify" })).toBeNull();
    const channel = await screen.findByLabelText("Channel") as HTMLSelectElement;
    await waitFor(() => expect(channel.options).toHaveLength(3));
    expect([...channel.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ["Wherever its Alertmanager sends it", false],
      [`ops-slack: ${pattern}`, true],
      ["oncall · severity=critical", false],
    ]);
    await user.selectOptions(channel, "oncall · severity=critical");
    await user.type(screen.getByLabelText("Name"), "Paging");
    await user.type(screen.getByLabelText("Query"), "up == 0");
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    const sent = posts(api)[0].body as RuleIn;
    expect(sent.engine).toBe("tool");
    expect(sent.channel).toEqual({ receiver: "oncall", labels: { severity: "critical" } });
    expect(sent.contact_point_ids).toEqual([]);
  });

  it("Esc leaves an untouched form at once and asks about one with changes", async () => {
    const user = userEvent.setup();
    open();
    await newRule(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(details().textContent).toBe("LatencyHigh"));
    expect(document.activeElement).toBe(details());

    await newRule(user);
    await user.type(screen.getByLabelText("Name"), "Half");
    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("alertdialog", { name: "Discard this rule?" });
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Keep editing" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Half");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Discard this rule?" })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(details().textContent).toBe("LatencyHigh"));
    expect(document.activeElement).toBe(details());
  });
});

describe("a source that may hold other clusters", () => {
  const words = "prod-east's data from Central Prometheus may include other clusters: OmniKrux couldn't tell which label separates them, so this rule may fire on another cluster's data. Add a filter on the project page.";

  it("the rule's details and the rule form warn about it", async () => {
    const user = userEvent.setup();
    open({}, { rule: "rB" });
    await waitFor(() => expect(details().textContent).toBe("NodesDown"));
    const shown = await screen.findByText(words);
    expect(shown.getAttribute("data-tone")).toBe("warn");

    await user.click(screen.getByRole("button", { name: "New alert rule" }));
    await waitFor(() => expect((screen.getByLabelText("For") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe("prod-east"));
    expect(screen.getByText(words).getAttribute("data-tone")).toBe("warn");
    // A filter OmniKrux set (prod-west) needs no warning; the group warns for prod-east alone.
    await user.selectOptions(screen.getByLabelText("For"), "prod-west");
    expect(screen.queryByText(/may include other clusters/)).toBeNull();
    await user.selectOptions(screen.getByLabelText("For"), "Group · Production");
    expect(screen.getAllByText(/may include other clusters/).map((p) => p.textContent)).toEqual([words]);
    await user.selectOptions(screen.getByLabelText("For"), "dev");
    expect(screen.queryByText(/may include other clusters/)).toBeNull();
  });

  it("a rule on a project whose link is filtered says nothing", async () => {
    open({}, { rule: "rA" });
    await waitFor(() => expect(details().textContent).toBe("LatencyHigh"));
    await screen.findByText("up > 5");
    expect(screen.queryByText(/may include other clusters/)).toBeNull();
  });
});

describe("the rule form, fix round 1", () => {
  it("Use moves the keyboard to the threshold it set", async () => {
    const user = userEvent.setup();
    open({
      dryRun: {
        start: 0, end: 21600, step: 60, fired: 5, firing_now: false, periods: [{ start: 100, end: 200, ongoing: false }], projects: [],
        candidates: [{ threshold: 0.8, fired: 1 }], took_ms: 2,
      },
    });
    await newRule(user);
    await user.type(screen.getByLabelText("Query"), "up");
    const use = await screen.findByRole("button", { name: "Use 0.8" }, { timeout: 3000 });
    await user.click(use);
    const threshold = screen.getByLabelText("Threshold") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(threshold));
    expect(threshold.value).toBe("0.8");
  });

  it("Discard from New alert rule lands on Name of the new form", async () => {
    const user = userEvent.setup();
    open();
    await newRule(user);
    await user.type(screen.getByLabelText("Name"), "Half");
    await user.click(screen.getByRole("button", { name: "New alert rule" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Discard this rule?" })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  it("a threshold that isn't a number yet counts as a change", async () => {
    const user = userEvent.setup();
    open();
    await newRule(user);
    const threshold = screen.getByLabelText("Threshold");
    await user.clear(threshold);
    await user.type(threshold, "abc");
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("alertdialog", { name: "Discard this rule?" })).toBeTruthy();
  });

  it("an edit keeps a project rule on the first source of its type", async () => {
    const user = userEvent.setup();
    const { api } = open();
    await waitFor(() => expect(details().textContent).toBe("LatencyHigh"));
    await user.click(screen.getByRole("button", { name: "Edit rule" }));
    const source = await screen.findByLabelText("Source") as HTMLSelectElement;
    await waitFor(() => expect(source.selectedOptions[0]?.textContent).toBe("The first Prometheus-compatible source (now Prometheus)"));
    expect([...source.options].map((o) => o.textContent)).toEqual([
      "The first Prometheus-compatible source (now Prometheus)", "Prometheus (Prometheus-compatible)", "Logs (Loki)",
    ]);
    await user.type(screen.getByLabelText("Name"), "!");
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    const put = await waitFor(() => {
      const found = api.requests.find((r) => r.method === "PUT" && r.url.endsWith("/alerts/rules/rA"));
      expect(found).toBeTruthy();
      return found!;
    });
    expect((put.body as RuleIn).source).toEqual({ type: "prometheus", id: null });
  });

  it("the Alerts views ask about a form with changes, and not about one without", async () => {
    const user = userEvent.setup();
    const { app } = open();
    await newRule(user);
    // Untouched: Silences goes at once.
    await user.click(screen.getByRole("tab", { name: "Silences" }));
    await waitFor(() => expect(app.current().tabs[0].view).toEqual({ page: "alerts", tab: "silences", rule: "rA" }));
    await user.click(screen.getByRole("tab", { name: /^Rules/ }));
    await newRule(user);
    await user.type(screen.getByLabelText("Name"), "Half");
    // With changes: a click, and the 2 key from the form's own buttons, both ask first.
    await user.click(screen.getByRole("tab", { name: "Silences" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard this rule?" });
    expect(app.current().tabs[0].view).toEqual({ page: "alerts", rule: "rA" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Half");
    screen.getByRole("tab", { name: /^Rules/ }).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(within(await screen.findByRole("alertdialog", { name: "Discard this rule?" })).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(app.current().tabs[0].view).toEqual({ page: "alerts", tab: "silences", rule: "rA" }));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Silences" }));
  });
});
