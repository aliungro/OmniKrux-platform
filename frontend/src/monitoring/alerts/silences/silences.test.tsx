import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LinkOut, SourceOut } from "../../api/types";
import { installFakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../../test/renderMonitoringApp";
import type { RuleOut, SilenceOut, TargetOut } from "../api";
import { noAlertmanager } from "./SilenceForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min: number) => new Date(NOW + min * 60_000).toISOString();

const link: LinkOut = { source_id: "s1", source_name: "Prometheus", source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false };
const amLink: LinkOut = { source_id: "am1", source_name: "Alertmanager", source_type: "alertmanager", filter: "", filter_origin: "none", created_by_project: false };
const dev = { ...seedProject("p1", "kind-dev"), links: [link, amLink] };

const target = (id: string, over: Partial<TargetOut> = {}): TargetOut => ({
  id, project_id: dev.id, project_name: dev.name, engine: "omnikrux", tool: null, where: "checked by OmniKrux", engine_note: null,
  state: "ok", state_since: ago(30), last_eval_at: ago(0.5), message: null, eval_expr: `expr_${id}`, rule_text: `rule_${id} > 5`,
  tool_state: null, tool_message: null, leaving: false, instances: [], ...over,
});
const rule = (id: string, name: string, over: Partial<RuleOut> = {}): RuleOut => ({
  id, name, scope: { kind: "project", id: dev.id, name: dev.name }, source_type: "prometheus", source_id: null, expr: "up",
  condition: { of: "each", op: "above", threshold: 5, for: "5m", every: "1m" }, severity: "warning", message: "",
  contact_points: [], engine: "omnikrux", channel: null, paused: false, origin: "page", panel: null, state: "ok", firing_since: null,
  targets: [target(`t-${id}`)], removing: false, version: 1, created_at: ago(90), updated_at: ago(90), ...over,
});
const crash = rule("r1", "PodCrashLooping");
const toolRule = rule("r7", "ApiDown", {
  engine: "tool", targets: [target("t-r7", { engine: "tool", tool: "prometheus_rule", where: "in Prometheus", tool_state: "in_sync" })],
});

const am = { id: "am1", name: "Alertmanager", type: "alertmanager", used_by: [] } as unknown as SourceOut;
const otherAm = { id: "am2", name: "Elsewhere", type: "alertmanager", used_by: [] } as unknown as SourceOut;
const silence = (over: Partial<SilenceOut> = {}): SilenceOut => ({
  id: "sil1", where: { kind: "omnikrux", source_id: null, source_name: null }, matchers: 'alertname="Slow",project="kind-dev"',
  starts_at: ago(10), ends_at: ahead(95), comment: "Deploy window", created_by: "ali", state: "active", affects: 2, ...over,
});

function open(seed: Partial<FakeMonitoringState> = {}, rule?: string) {
  const api = installFakeMonitoringApi({
    projects: [dev], rules: [crash, toolRule], queryAnswers: { "expr_t-r1": { series: [] }, "expr_t-r7": { series: [] } }, ...seed,
  });
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "alerts", ...(rule ? { rule } : {}) }) });
  return { api, app };
}
const posted = (api: ReturnType<typeof open>["api"]) => api.requests.filter((r) => r.method === "POST" && r.url.endsWith("/alerts/silences"));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("silences", () => {
  it("silence from a firing rule is prefilled for OmniKrux", async () => {
    const user = userEvent.setup();
    const { api, app } = open({}, "r1");
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("PodCrashLooping"));
    const button = screen.getByRole("button", { name: "Silence" });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("title")).toBeNull();
    // The key does the same as the button, from the list.
    await user.click(screen.getByRole("option", { name: /^PodCrashLooping/ }));
    await user.keyboard("s");

    const matchers = (await screen.findByLabelText("Matchers")) as HTMLInputElement;
    expect(matchers.value).toBe('alertname="PodCrashLooping",project="kind-dev"');
    await waitFor(() => expect(app.current().tabs[0].view).toEqual({ page: "alerts", tab: "silences", rule: "r1" }));
    const comment = screen.getByLabelText("Comment");
    expect(document.activeElement).toBe(comment);
    expect((screen.getByRole("radio", { name: /OmniKrux/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/for rules checked by OmniKrux/)).toBeTruthy();
    expect((screen.getByLabelText("Lasts") as HTMLSelectElement).value).toBe("1h");
    await waitFor(() => expect(screen.getByText("Silences 0 alerts now.")).toBeTruthy());

    // Comment is required.
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Add a comment so others know why.")).toBeTruthy();
    expect(document.activeElement).toBe(comment);
    expect(posted(api)).toHaveLength(0);

    await user.type(comment, "Deploying the fix");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    const body = posted(api)[0].body as { where: unknown; matchers: string; comment: string; ends_at: string };
    expect(body.where).toEqual({ kind: "omnikrux" });
    expect(body.matchers).toBe('alertname="PodCrashLooping",project="kind-dev"');
    expect(body.comment).toBe("Deploying the fix");
    expect(Date.parse(body.ends_at) - Date.now()).toBeGreaterThan(3_500_000);
    await waitFor(() => expect(screen.queryByRole("form", { name: "New silence" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New silence" }));
    expect(await screen.findByText("Deploying the fix")).toBeTruthy();
  });

  it("a tool rule silences in its Alertmanager", async () => {
    const user = userEvent.setup();
    const { api } = open({
      sources: [am, otherAm], channels: { p1: { alertmanager: { id: "am1", name: "Alertmanager" }, channels: [], message: null } },
    }, "r7");
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("ApiDown"));
    await user.click(screen.getByRole("button", { name: "Silence" }));
    const matchers = (await screen.findByLabelText("Matchers")) as HTMLInputElement;
    expect(matchers.value).toBe('omnikrux_rule="r7"');
    await waitFor(() => expect((screen.getByRole("radio", { name: /^Alertmanager —/ }) as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(/for rules that run in Prometheus or Loki/)).toBeTruthy();
    // Only the project's Alertmanager is offered; OmniKrux can't hold a tool rule's silence.
    expect(screen.queryByRole("radio", { name: /Elsewhere/ })).toBeNull();
    expect((screen.getByRole("radio", { name: /OmniKrux/ }) as HTMLInputElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Comment"), "Planned restart");
    await user.click(screen.getByRole("button", { name: "Silence" }));
    await waitFor(() => expect(posted(api)).toHaveLength(1));
    expect((posted(api)[0].body as { where: unknown }).where).toEqual({ kind: "alertmanager", source_id: "am1" });
    // Its preview is OmniKrux's alone.
    expect(api.requests.some((r) => r.url.endsWith("/silences/preview"))).toBe(false);
  });

  it("a tool rule without an Alertmanager says how to silence it", async () => {
    const user = userEvent.setup();
    const { api } = open({ projects: [{ ...dev, links: [link] }] }, "r7");
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("ApiDown"));
    await user.click(screen.getByRole("button", { name: "Silence" }));
    const words = await screen.findByText("This rule runs in Prometheus; link its Alertmanager to silence it from here.");
    expect(words.textContent).toBe(noAlertmanager("Prometheus"));
    const save = screen.getByRole("button", { name: "Silence" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.type(screen.getByLabelText("Comment"), "x");
    await user.click(save);
    expect(posted(api)).toHaveLength(0);
  });

  it("a failed read of the project's Alertmanager says so and can be tried again", async () => {
    const user = userEvent.setup();
    open({ sources: [am], channels: { p1: { alertmanager: { id: "am1", name: "Alertmanager" }, channels: [], message: null } } }, "r7");
    const real = globalThis.fetch;
    let fail = true;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      fail && String(url).includes("/alerts/channels") ? Promise.resolve(json({ detail: "The channels couldn't be read." }, 500)) : real(url, init));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("ApiDown"));
    await user.click(screen.getByRole("button", { name: "Silence" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The channels couldn't be read.");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect((screen.getByRole("radio", { name: /^Alertmanager —/ }) as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("New silence keeps what is typed in an open form", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    await user.click(await screen.findByRole("button", { name: "New silence" }));
    await user.type(await screen.findByLabelText("Matchers"), 'alertname="A"');
    await user.click(screen.getByRole("button", { name: "New silence" }));
    expect((screen.getByLabelText("Matchers") as HTMLInputElement).value).toBe('alertname="A"');
  });

  it("matchers are checked as you type", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    await user.click(await screen.findByRole("button", { name: "New silence" }));
    const matchers = (await screen.findByLabelText("Matchers")) as HTMLInputElement;
    expect(document.activeElement).toBe(matchers);
    expect(matchers.placeholder).toBe('alertname="HighErrorRate", project="prod-east"');
    await user.type(matchers, "alertname=bad");
    expect(screen.getByText('Use label matchers like cluster="prod-east", separated by commas.')).toBeTruthy();
    expect(matchers.getAttribute("aria-invalid")).toBe("true");
    await user.clear(matchers);
    await user.type(matchers, 'alertname="Slow"');
    expect(screen.queryByText(/Use label matchers/)).toBeNull();
    expect(matchers.getAttribute("aria-invalid")).toBeNull();
    // The options of Lasts, and a time to end at.
    const lasts = screen.getByLabelText("Lasts") as HTMLSelectElement;
    expect([...lasts.options].map((o) => o.textContent)).toEqual(["1 h", "2 h", "4 h", "1 day", "Until…"]);
    await user.selectOptions(lasts, "until");
    expect(screen.getByLabelText("Ends at")).toBeTruthy();
  });

  it("a pattern the server refuses shows under Matchers and takes the keyboard", async () => {
    const user = userEvent.setup();
    const { api } = open();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).endsWith("/alerts/silences") && init?.method === "POST"
        ? Promise.resolve(json({ detail: { code: "invalid_silence", message: "This pattern could take too long to match. Simplify it.", field: "matchers" } }, 422))
        : real(url, init));
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    await user.click(await screen.findByRole("button", { name: "New silence" }));
    await user.type(await screen.findByLabelText("Matchers"), 'alertname=~"(a+)+"');
    await user.type(screen.getByLabelText("Comment"), "why");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("This pattern could take too long to match. Simplify it.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Matchers"));
    expect(api.requests.filter((r) => r.method === "POST" && r.url.endsWith("/alerts/silences"))).toHaveLength(0);
  });

  it("expire asks first", async () => {
    const user = userEvent.setup();
    const { api } = open({ silences: [silence()] });
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    const row = (await screen.findByText("Deploy window")).closest("li")!;
    expect(row.textContent).toContain("Active until");
    expect(row.textContent).toMatch(/\(1 h 3[45] min left\)/);
    expect(row.textContent).toContain("In OmniKrux");
    expect(row.textContent).toContain("Silences 2 alerts now");

    expect(within(row).getByText('alertname="Slow"')).toBeTruthy();
    expect(within(row).getByText('project="kind-dev"')).toBeTruthy();

    const expire = within(row).getByRole("button", { name: /^Expire…/ });
    await user.click(expire);
    const dialog = await screen.findByRole("alertdialog", { name: "Expire this silence?" });
    expect(within(dialog).getByText("Its alerts notify again at their next check.")).toBeTruthy();
    const go = within(dialog).getByRole("button", { name: "Expire silence" });
    await waitFor(() => expect(document.activeElement).toBe(go));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(expire);
    expect(api.requests.some((r) => r.method === "DELETE")).toBe(false);

    await user.click(expire);
    await screen.findByRole("alertdialog", { name: "Expire this silence?" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.requests.some((r) => r.method === "DELETE" && r.url.endsWith("/silences/omnikrux/sil1"))).toBe(true));
    await waitFor(() => expect(screen.getByText("Expired")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Expire…/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New silence" }));
  });

  it("one affected alert is said in the singular", async () => {
    const user = userEvent.setup();
    open({ silences: [silence({ affects: 1 })] });
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    expect((await screen.findByText("Deploy window")).closest("li")!.textContent).toContain("Silences 1 alert now");
  });

  it("an Alertmanager's silence expires with its source", async () => {
    const user = userEvent.setup();
    const { api } = open({
      silences: [silence({ id: "x9", where: { kind: "alertmanager", source_id: "am1", source_name: "Alertmanager" }, affects: null })],
    });
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    const row = (await screen.findByText("Deploy window")).closest("li")!;
    expect(row.textContent).toContain("In Alertmanager");
    expect(row.textContent).not.toContain("In Alertmanager · Alertmanager");
    expect(row.textContent).not.toContain("alerts now");
    await user.click(within(row).getByRole("button", { name: /^Expire…/ }));
    await user.click(await screen.findByRole("button", { name: "Expire silence" }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "DELETE" && r.url.includes("/silences/alertmanager/x9?source_id=am1"))).toBe(true));
  });

  it("Alertmanager problems show without hiding OmniKrux silences", async () => {
    const user = userEvent.setup();
    open({ silences: [silence(), silence({ id: "sil2", comment: "Planned", state: "pending", starts_at: ahead(120), ends_at: ahead(240) })] });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).endsWith("/alerts/silences") && (init?.method ?? "GET") === "GET"
        ? Promise.resolve(json({
          silences: [silence(), silence({ id: "sil2", comment: "Planned", state: "pending", starts_at: ahead(120), ends_at: ahead(240) })],
          problems: [{ source_id: "am9", source_name: "Alertmanager east", message: "It didn't answer. Check that it is running.", unreachable: true }],
        }))
        : real(url, init));
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    const problem = await screen.findByText("Alertmanager east: It didn't answer. Check that it is running.");
    expect(problem.closest("ul")!.getAttribute("data-tone")).toBe("warn");
    expect(screen.getByText("Deploy window")).toBeTruthy();
    const planned = screen.getByText("Planned").closest("li")!;
    expect(planned.textContent).toMatch(/Starts /);
  });

  it("expired silences are folded apart and can be removed", async () => {
    const user = userEvent.setup();
    const ended = silence({ id: "old", comment: "Last night", state: "expired", starts_at: ago(300), ends_at: ago(60), affects: null });
    const theirs = silence({
      id: "x1", comment: "Their window", state: "expired", starts_at: ago(300), ends_at: ago(30), affects: null,
      where: { kind: "alertmanager", source_id: "am1", source_name: "Alertmanager" },
    });
    const { api } = open({ silences: [silence(), ended, theirs] });
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    const active = (await screen.findByText("Deploy window")).closest("li")!;
    expect(within(screen.getByRole("list", { name: "Silences" })).getAllByRole("listitem")).toEqual([active]);
    expect(active.textContent).toContain("In OmniKrux");

    const folded = screen.getByText("Expired (2)").closest("details")!;
    expect(folded.open).toBe(false);
    await user.click(screen.getByText("Expired (2)"));
    const old = within(folded).getByText("Last night").closest("li")!;
    expect(old.textContent).toMatch(/Expired at \d\d:\d\d/);
    expect(old.textContent).not.toContain("until");
    const other = within(folded).getByText("Their window").closest("li")!;
    expect(other.textContent).toContain("In Alertmanager");
    expect(other.textContent).not.toContain("In Alertmanager · Alertmanager");
    // Only OmniKrux's own can be removed: an Alertmanager keeps its expired silences itself.
    expect(within(other).queryByRole("button", { name: /Remove/ })).toBeNull();

    await user.click(within(old).getByRole("button", { name: /^Remove/ }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "DELETE" && r.url.endsWith("/silences/omnikrux/old?expired=1"))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Last night")).toBeNull());
    expect(screen.getByText("Expired (1)")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("an unreachable Alertmanager can't be picked", async () => {
    const user = userEvent.setup();
    const far = { ...amLink, source_id: "am2", source_name: "Far AM" };
    open({ projects: [{ ...dev, links: [link, amLink, far] }], silenceProblems: [
      { source_id: "am2", source_name: "Far AM", message: "Can't reach Far AM.", unreachable: true },
      { source_id: "am1", source_name: "Alertmanager", message: "Alertmanager answered HTTP 500.", unreachable: false },
    ] });
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    await screen.findByText("Far AM: Can't reach Far AM.");
    await user.click(screen.getByRole("button", { name: "New silence" }));
    const far1 = await screen.findByRole("radio", { name: /Far AM \(can't be reached\)/ });
    expect((far1 as HTMLInputElement).disabled).toBe(true);
    const near = screen.getByRole("radio", { name: /^Alertmanager/ });
    expect((near as HTMLInputElement).disabled).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("no silences says so, and a form with changes asks before the view goes", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("tab", { name: "Silences" }));
    expect(await screen.findByText("No silences.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "New silence" }));
    // Nothing typed: Esc closes at once, with the keyboard back on New silence.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Matchers")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New silence" }));

    await user.click(screen.getByRole("button", { name: "New silence" }));
    await user.type(await screen.findByLabelText("Matchers"), 'alertname="A"');
    await user.click(screen.getByRole("tab", { name: "Contact points" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard this silence?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Matchers") as HTMLInputElement).value).toBe('alertname="A"');
    await user.click(screen.getByRole("tab", { name: "Contact points" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await screen.findByRole("button", { name: "Add a contact point" })).toBeTruthy();
  });
});
