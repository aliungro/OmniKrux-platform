import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Plan } from "../../../api/types";
import { emptyInstallState, installFakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { AlertChangeOut, ContactPointOut } from "../api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T = "2026-01-01T00:00:00Z";
const point = (over: Partial<ContactPointOut> = {}): ContactPointOut => ({
  id: "c1", name: "Ops hook", type: "webhook", settings: { url_host: "https://hooks.example.test" }, secrets_set: ["url", "bearer_token"],
  summary: "https://hooks.example.test", used_by: [], last_delivery: null, created_at: T, updated_at: T, ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function open(seed: Partial<FakeMonitoringState> = {}) {
  const api = installFakeMonitoringApi(seed);
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "alerts", tab: "contacts" }) });
  return { api, app };
}
const requests = (api: ReturnType<typeof open>["api"], method: string, tail: string) =>
  api.requests.filter((r) => r.method === method && r.url.endsWith(tail));

const ADDRESS = "https://hooks.example.test/services/T000/B000/XXSECRETXX";

describe("contact points", () => {
  it("lists them with their type, use and last delivery", async () => {
    open({
      contactPoints: [
        point({ used_by: [{ id: "r1", name: "A" }, { id: "r2", name: "B" }], last_delivery: { at: new Date().toISOString(), ok: true, message: null } }),
        point({ id: "c2", name: "Mail", type: "email", summary: "ops@example.test", secrets_set: [], last_delivery: { at: new Date().toISOString(), ok: false, message: "Mail server refused the sign-in." } }),
        point({ id: "c3", name: "Pager", type: "pagerduty", summary: "PagerDuty", secrets_set: ["routing_key"] }),
      ],
    });
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Webhook");
    expect(rows[0].textContent).toContain("Used by 2 rules");
    expect(rows[0].textContent).toMatch(/Last sent \d\d:\d\d/);
    expect(rows[1].textContent).toContain("Email");
    expect(rows[1].textContent).toContain("No rule uses it");
    const failed = within(rows[1]).getByText(/Last send failed \d\d:\d\d: Mail server refused the sign-in\./);
    expect(failed.getAttribute("data-failed")).toBe("true");
    expect(rows[2].textContent).toContain("PagerDuty");
  });

  it("an empty list invites adding one", async () => {
    open();
    expect(await screen.findByText("No contact points yet. Add one to be told when an alert fires.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a contact point" })).toBeTruthy();
  });

  it("saving a contact point keeps its secret out of the page", async () => {
    const user = userEvent.setup();
    const { api, app } = open();
    await user.click(await screen.findByRole("button", { name: "Add a contact point" }));
    const type = (await screen.findByLabelText("Type")) as HTMLSelectElement;
    expect(document.activeElement).toBe(type);
    expect([...type.options].map((o) => o.textContent)).toEqual(["Slack", "Email", "Teams", "PagerDuty", "Webhook"]);
    await user.type(screen.getByLabelText("Name"), "Team Slack");
    const field = screen.getByLabelText("Webhook address") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("new-password");
    await user.type(field, ADDRESS);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(requests(api, "POST", "/contact-points")).toHaveLength(1));
    expect((requests(api, "POST", "/contact-points")[0].body as { secrets: Record<string, string> }).secrets).toEqual({ webhook_url: ADDRESS });
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(await screen.findByText("Team Slack")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a contact point" }));

    // Nowhere: not in an element's value or text, nor in a query or a mutation of the cache.
    const values = [...document.querySelectorAll("input, textarea, select")].map((el) => (el as HTMLInputElement).value).join("|");
    expect(values).not.toContain("XXSECRETXX");
    expect(document.body.textContent).not.toContain("XXSECRETXX");
    expect(document.body.innerHTML).not.toContain("XXSECRETXX");
    const cache = JSON.stringify(app.client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]));
    const mutations = JSON.stringify(app.client.getMutationCache().getAll().map((m) => [m.options.mutationKey, m.state.variables, m.state.data]));
    expect(cache).not.toContain("XXSECRETXX");
    expect(mutations).not.toContain("XXSECRETXX");
    expect(JSON.stringify(app.current().tabs)).not.toContain("XXSECRETXX");
  });

  it("stored secrets show the keep hint and PATCH omits them", async () => {
    const user = userEvent.setup();
    const { api } = open({ contactPoints: [point()] });
    await user.click(await screen.findByRole("button", { name: "Edit Ops hook" }));
    const url = screen.getByLabelText("Address") as HTMLInputElement;
    const token = screen.getByLabelText("Bearer token (optional)") as HTMLInputElement;
    expect(url.value).toBe("");
    expect(token.value).toBe("");
    expect(screen.getAllByText("Saved. Leave empty to keep it.")).toHaveLength(2);
    expect((screen.getByLabelText("Type") as HTMLSelectElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), " 2");
    await user.click(screen.getByRole("button", { name: "Save contact point" }));
    await waitFor(() => expect(requests(api, "PATCH", "/contact-points/c1")).toHaveLength(1));
    const body = requests(api, "PATCH", "/contact-points/c1")[0].body as Record<string, unknown>;
    expect(body).toEqual({ name: "Ops hook 2", settings: {}, secrets: {} });
    expect(await screen.findByText("Ops hook 2")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Ops hook 2" }));
  });

  it("a stored Slack address that isn't Slack's says so on its row and in its form", async () => {
    const user = userEvent.setup();
    const words = "Use a Slack webhook address that starts with https://hooks.slack.com/.";
    open({ contactPoints: [point({ type: "slack", name: "Old Slack", secrets_set: ["webhook_url"], summary: "Slack webhook", problem: words })] });
    const row = (await screen.findByText("Old Slack")).closest("li")!;
    expect(within(row).getByText(words)).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Edit Old Slack" }));
    const field = await screen.findByLabelText("Webhook address");
    const said = screen.getByText(words);
    expect(field.getAttribute("aria-describedby")).toContain(said.id);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Edit on another row asks before it drops what is typed", async () => {
    const user = userEvent.setup();
    open({ contactPoints: [point(), point({ id: "c2", name: "Spare" })] });
    await user.click(await screen.findByRole("button", { name: "Edit Ops hook" }));
    await user.type(screen.getByLabelText("Address"), ADDRESS);
    await user.click(screen.getByRole("button", { name: "Edit Spare" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard this contact point?" });
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(ADDRESS);
    await user.click(screen.getByRole("button", { name: "Edit Spare" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Spare"));
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("");
  });

  it("an explicit clear removes an optional secret", async () => {
    const user = userEvent.setup();
    const { api } = open({ contactPoints: [point()] });
    await user.click(await screen.findByRole("button", { name: "Edit Ops hook" }));
    await user.click(screen.getByRole("checkbox", { name: "Remove the saved token" }));
    expect(screen.getByText("The saved token is removed when you save.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save contact point" }));
    await waitFor(() => expect(requests(api, "PATCH", "/contact-points/c1")).toHaveLength(1));
    expect((requests(api, "PATCH", "/contact-points/c1")[0].body as { secrets: unknown }).secrets).toEqual({ bearer_token: "" });
    // The address can't be cleared: it has no such box.
    expect(screen.queryByRole("checkbox", { name: /address/ })).toBeNull();
  });

  it("a secret asked for again is focused", async () => {
    const user = userEvent.setup();
    const { api } = open({ contactPoints: [point()] });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).endsWith("/contact-points/c1") && init?.method === "PATCH"
        ? Promise.resolve(json({ detail: [{ type: "secret_needed", loc: ["body", "secrets", "bearer_token"], msg: "Ops hook sends to a new address now. Enter its secret again." }] }, 422))
        : real(url, init));
    await user.click(await screen.findByRole("button", { name: "Edit Ops hook" }));
    await user.type(screen.getByLabelText("Address"), "https://other.example.test/hook");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByText("Ops hook sends to a new address now. Enter its secret again.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Bearer token (optional)"));
    expect(requests(api, "PATCH", "/contact-points/c1")).toHaveLength(0);
  });

  it("each type asks for its own fields", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Add a contact point" }));
    await user.selectOptions(await screen.findByLabelText("Type"), "email");
    for (const label of ["Mail server", "Port", "Security", "User name", "Password", "From", "To"]) expect(screen.getByLabelText(label)).toBeTruthy();
    const security = screen.getByLabelText("Security") as HTMLSelectElement;
    expect([...security.options].map((o) => o.textContent)).toEqual(["STARTTLS", "TLS", "None"]);
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    await user.selectOptions(screen.getByLabelText("Type"), "pagerduty");
    expect(screen.getByLabelText("Routing key")).toBeTruthy();
    expect((screen.getByLabelText("Events address") as HTMLInputElement).value).toBe("https://events.pagerduty.com/v2/enqueue");
    await user.selectOptions(screen.getByLabelText("Type"), "teams");
    expect(screen.getByLabelText("Webhook address")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Type"), "webhook");
    expect(screen.getByLabelText("Address")).toBeTruthy();
    expect(screen.getByLabelText("Bearer token (optional)")).toBeTruthy();
    // Nothing entered: the first missing field is named and takes the keyboard.
    await user.click(screen.getByRole("button", { name: "Save contact point" }));
    expect(await screen.findByText("Give the contact point a name.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("send a test shows the answer", async () => {
    const user = userEvent.setup();
    const { api, app } = open({ contactPoints: [point()] });
    await user.click(await screen.findByRole("button", { name: "Send a test to Ops hook" }));
    const row = screen.getByText("Ops hook").closest("li")!;
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("Sent. Check that the test message arrived."));
    expect(requests(api, "POST", "/contact-points/c1/test")).toHaveLength(1);
    // A plain call: no mutation was kept for it.
    expect(app.client.getMutationCache().getAll()).toHaveLength(0);
  });

  it("send a test from an unsaved form sends the form's values", async () => {
    const user = userEvent.setup();
    const { api, app } = open();
    await user.click(await screen.findByRole("button", { name: "Add a contact point" }));
    await user.selectOptions(await screen.findByLabelText("Type"), "webhook");
    await user.type(screen.getByLabelText("Name"), "Draft");
    await user.type(screen.getByLabelText("Address"), ADDRESS);
    await user.click(screen.getByRole("button", { name: "Send a test" }));
    expect(await screen.findByText("Sent. Check that the test message arrived.")).toBeTruthy();
    const sent = requests(api, "POST", "/contact-points/test");
    expect(sent).toHaveLength(1);
    expect((sent[0].body as { secrets: unknown }).secrets).toEqual({ url: ADDRESS });
    expect(JSON.stringify(app.client.getMutationCache().getAll().map((m) => m.state.variables))).not.toContain("XXSECRETXX");
    // Cancel with changes asks first.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard this contact point?" });
    await user.click(within(ask).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  });

  it("the email error clears when the address changes", async () => {
    const user = userEvent.setup();
    open();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).endsWith("/contact-points/test") && init?.method === "POST"
        ? Promise.resolve(json({ detail: "Use addresses like ops@example.test." }, 422))
        : real(url, init));
    await user.click(await screen.findByRole("button", { name: "Add a contact point" }));
    await user.selectOptions(await screen.findByLabelText("Type"), "email");
    await user.type(screen.getByLabelText("Name"), "Mail");
    await user.type(screen.getByLabelText("Mail server"), "smtp.example.test");
    await user.type(screen.getByLabelText("From"), "alerts@example.test");
    const to = screen.getByLabelText("To");
    await user.type(to, "ops@example");
    await user.click(screen.getByRole("button", { name: "Send a test" }));
    expect(await screen.findByText("Use addresses like ops@example.test.")).toBeTruthy();
    await user.type(to, ".test");
    expect(screen.queryByText("Use addresses like ops@example.test.")).toBeNull();
    expect(document.activeElement).toBe(to);
  });

  it("a wrong address is said under its field, and the list says when the last test went", async () => {
    const user = userEvent.setup();
    const slackWords = "Use a Slack webhook address that starts with https://hooks.slack.com/.";
    const { api } = open({ contactPoints: [point({ last_delivery: { at: new Date().toISOString(), ok: false, message: "Ops hook answered HTTP 405." } })] });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).endsWith("/contact-points") && init?.method === "POST"
        ? Promise.resolve(json({ detail: slackWords }, 422))
        : real(url, init));
    // A test's answer shows once: in the row's line, not again in the list's last delivery.
    const row = (await screen.findByText("Ops hook")).closest("li")!;
    expect(row.textContent).toContain("No rule uses it");
    expect(row.textContent).toContain("Ops hook answered HTTP 405.");
    await user.click(within(row).getByRole("button", { name: "Send a test to Ops hook" }));
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("Sent. Check that the test message arrived."));
    await waitFor(() => expect(row.textContent).toMatch(/No rule uses it · Last test \d\d:\d\d/));
    expect(api.requests.length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Add a contact point" }));
    await user.type(await screen.findByLabelText("Name"), "Team Slack");
    const field = screen.getByLabelText("Webhook address");
    await user.type(field, "http://example.com/not-slack");
    await user.keyboard("{Control>}{Enter}{/Control}");
    const error = await screen.findByText(slackWords);
    expect(field.getAttribute("aria-describedby")).toContain(error.id);
    expect(document.activeElement).toBe(field);
  });

  it("delete lists the rules that lose it and opens on Cancel", async () => {
    const user = userEvent.setup();
    const { api } = open({
      contactPoints: [point({ used_by: [{ id: "r1", name: "PodCrashLooping" }, { id: "r2", name: "NodeNotReady" }] }), point({ id: "c2", name: "Spare", secrets_set: ["url"] })],
    });
    const del = await screen.findByRole("button", { name: "Delete Ops hook…" });
    await user.click(del);
    const dialog = await screen.findByRole("alertdialog", { name: 'Delete the contact point "Ops hook"?' });
    expect(await within(dialog).findByText("These rules stop notifying it: PodCrashLooping, NodeNotReady.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    // Esc goes back to Delete….
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(del);
    expect(api.requests.some((r) => r.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete Spare…" }));
    const second = await screen.findByRole("alertdialog", { name: 'Delete the contact point "Spare"?' });
    expect(await within(second).findByText("No rule uses it.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(second).getByRole("button", { name: "Cancel" })));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.requests.some((r) => r.method === "DELETE" && r.url.includes("/contact-points/c2"))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Spare")).toBeNull());
    expect(screen.getByText("Ops hook")).toBeTruthy();
  });

  it("a delete the review didn't cover is reviewed again", async () => {
    const user = userEvent.setup();
    const { api } = open({ contactPoints: [point()] });
    const real = globalThis.fetch;
    let first = true;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && String(url).includes("/contact-points/c1") && first) {
        first = false;
        return Promise.resolve(json({ detail: "That changed since you looked. Review it again." }, 409));
      }
      return real(url, init);
    });
    await user.click(await screen.findByRole("button", { name: "Delete Ops hook…" }));
    const dialog = await screen.findByRole("alertdialog");
    const go = await within(dialog).findByRole("button", { name: "Delete contact point" });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    await user.click(go);
    expect(await within(dialog).findByText("Something changed since the review. Review it again.")).toBeTruthy();
    expect(api.requests.filter((r) => r.url.endsWith("/delete-review"))).toHaveLength(2);
    await user.click(await within(dialog).findByRole("button", { name: "Delete contact point" }));
    await waitFor(() => expect(screen.queryByText("Ops hook")).toBeNull());
  });
});

describe("contact points sent from an Alertmanager OmniKrux installed", () => {
  const contactsPlan: Plan = {
    plan_id: "plan-c", action: "edit",
    target: { cluster_id: "k1", kind_key: "alertmanagerconfigs.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-contact-points" },
    kind: "AlertmanagerConfig", cluster: { id: "k1", name: "kind-install", provider: "kind", environment: "development" },
    title: "Update contact points in monitoring", summary: ["Routes 1 rule to 1 contact point."], warnings: [], blocked: [], diff: null,
    confirm_text: null, apply_label: "Update", expires_at: "2026-11-24T10:05:00Z",
  };
  const contacts: AlertChangeOut = {
    target_id: "", rule_id: "", rule_name: "", project_id: "", project_name: "kind-install", kind: "contacts", message: null, cluster_id: "k1",
  };
  const seed = (): Partial<FakeMonitoringState> => ({
    contactPoints: [point({ used_by: [{ id: "r1", name: "PodCrashLooping" }] })],
    contactPointChanges: [contacts],
    install: { ...emptyInstallState(), contacts: { k1: { kind: "review", plan: contactsPlan } } },
  });
  const installStatus = () => screen.getByTestId("install-review-status").querySelector('[role="status"]') as HTMLElement;

  it("saving a contact point queues the contacts review", async () => {
    const user = userEvent.setup();
    const { api, app } = open(seed());
    await user.click(await screen.findByRole("button", { name: "Edit Ops hook" }));
    await user.type(screen.getByLabelText("Address"), ADDRESS);
    await user.click(screen.getByRole("button", { name: "Save contact point" }));
    await waitFor(() => expect(requests(api, "PATCH", "/contact-points/c1")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Update contact points in monitoring");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(requests(api, "POST", "/install/clusters/k1/contacts/sync")).toHaveLength(1);
    // The review never carries the secret, and nothing kept it.
    expect(document.body.innerHTML).not.toContain("XXSECRETXX");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(installStatus().textContent).toBe("Contact points in kind-install's Alertmanager aren't updated yet. Review them from Monitoring tools.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Ops hook" }));
    const cache = JSON.stringify(app.client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]));
    const mutations = JSON.stringify(app.client.getMutationCache().getAll().map((m) => [m.options.mutationKey, m.state.variables, m.state.data]));
    expect(cache).not.toContain("XXSECRETXX");
    expect(mutations).not.toContain("XXSECRETXX");
    expect(JSON.stringify(app.current().tabs)).not.toContain("XXSECRETXX");
  });

  it("deleting a contact point reads the 200 answer and queues the review", async () => {
    const user = userEvent.setup();
    const { api } = open(seed());
    await user.click(await screen.findByRole("button", { name: "Delete Ops hook…" }));
    const ask = await screen.findByRole("alertdialog", { name: 'Delete the contact point "Ops hook"?' });
    expect(await within(ask).findByText("These rules stop notifying it: PodCrashLooping.")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Delete contact point" }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "DELETE" && r.url.includes("/contact-points/c1"))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Ops hook")).toBeNull());

    // The delete's answer (200, with its changes) opens the review of the contact points left.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Update contact points in monitoring");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(installStatus().textContent).toBe("Contact points in kind-install's Alertmanager aren't updated yet. Review them from Monitoring tools.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a contact point" }));
  });
});
