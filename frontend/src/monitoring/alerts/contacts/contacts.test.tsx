import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { ContactPointOut } from "../api";

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
    expect(rows[1].textContent).toContain("Not used yet");
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

  it("delete lists the rules that lose it and opens on its action", async () => {
    const user = userEvent.setup();
    const { api } = open({
      contactPoints: [point({ used_by: [{ id: "r1", name: "PodCrashLooping" }, { id: "r2", name: "NodeNotReady" }] }), point({ id: "c2", name: "Spare", secrets_set: ["url"] })],
    });
    const del = await screen.findByRole("button", { name: "Delete Ops hook…" });
    await user.click(del);
    const dialog = await screen.findByRole("alertdialog", { name: 'Delete the contact point "Ops hook"?' });
    expect(await within(dialog).findByText("These rules stop notifying it: PodCrashLooping, NodeNotReady.")).toBeTruthy();
    const go = within(dialog).getByRole("button", { name: "Delete contact point" });
    await waitFor(() => expect(document.activeElement).toBe(go));
    // Esc goes back to Delete….
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(del);
    expect(api.requests.some((r) => r.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete Spare…" }));
    const second = await screen.findByRole("alertdialog", { name: 'Delete the contact point "Spare"?' });
    expect(await within(second).findByText("No rule uses it.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(second).getByRole("button", { name: "Delete contact point" })));
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
    await waitFor(() => expect(document.activeElement).toBe(go));
    await user.click(go);
    expect(await within(dialog).findByText("Something changed since the review. Review it again.")).toBeTruthy();
    expect(api.requests.filter((r) => r.url.endsWith("/delete-review"))).toHaveLength(2);
    await user.click(await within(dialog).findByRole("button", { name: "Delete contact point" }));
    await waitFor(() => expect(screen.queryByText("Ops hook")).toBeNull());
  });
});
