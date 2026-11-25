import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceOut } from "../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceForm } from "./SourceForm";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import { isQueryable, sortLinks, sourceTypeLabel, stateWords, whereLabel } from "./sourceLabels";
import { intercept } from "../test/dashboardSeeds";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const TOKEN = "s3cret-bearer-token-value";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);

function source(id: string, name: string, over: Partial<SourceOut> = {}): SourceOut {
  return {
    id, name, type: "prometheus", reach: "url", url: "http://prom.example:9090", cluster_id: null, cluster_name: null, namespace: null,
    service: null, port: null, scheme: "http", path_prefix: "",
    auth: { type: "none", username: null, header_name: null, has_password: false, has_token: false, has_api_key: false, has_client_key: false, has_client_cert: false },
    headers: [], has_ca: false, created_by_project_id: null, used_by: [], health: { state: "unknown", message: null, version: null, checked_at: null },
    created_at: T, updated_at: T, ...over,
  };
}
const bearer = (): SourceOut["auth"] => ({ type: "bearer", username: null, header_name: null, has_password: false, has_token: true, has_api_key: false, has_client_key: false, has_client_cert: false });

const open = () => renderMonitoringApp({ tabs: tabsWith({ page: "sources" }) });

describe("labels", () => {
  it("names types and places", () => {
    expect(sourceTypeLabel("prometheus")).toBe("Prometheus-compatible");
    expect(sourceTypeLabel("loki")).toBe("Loki");
    expect(whereLabel(source("a", "A"))).toBe("http://prom.example:9090");
    expect(whereLabel(source("a", "A", { reach: "cluster", url: null, cluster_name: "prod", namespace: "mon", service: "prom" }))).toBe("prod · mon/prom");
  });
});

describe("Sources page", () => {
  it("lists sources and says when there are none", async () => {
    installFakeMonitoringApi({}, fallback);
    open();
    expect(await screen.findByText("No sources yet. Add one here or while setting up a project.")).toBeTruthy();
    cleanup();
    installFakeMonitoringApi({ sources: [source("s1", "Prom", { used_by: [{ id: "p1", name: "Dev" }] }), source("s2", "Loki", { type: "loki" })] }, fallback);
    open();
    expect(await screen.findByText("Used by Dev")).toBeTruthy();
    expect(screen.getByText("Not used by a project")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Delete/ })).toHaveLength(2);
  });

  it("an Alertmanager source can be added by hand", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    await user.selectOptions(screen.getByLabelText("Type"), "alertmanager");
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    expect(address.placeholder).toBe("http://alertmanager.example:9093");
    expect((screen.getByLabelText("Name") as HTMLInputElement).placeholder).toBe("Alertmanager · address");
    await user.type(address, "http://alertmanager.example:9093");
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.state.sources).toHaveLength(1));
    expect(api.state.sources[0].type).toBe("alertmanager");
    expect(sourceTypeLabel("alertmanager")).toBe("Alertmanager");
    expect(isQueryable("alertmanager")).toBe(false);
    expect(isQueryable("loki") && isQueryable("prometheus")).toBe(true);
  });

  it("adding a source by hand sends no secret back into the page", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    const { client } = open();
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
    const field = screen.getByLabelText("Token") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");
    await user.type(field, TOKEN);
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.state.sources).toHaveLength(1));
    await screen.findByRole("button", { name: "Add a source" });
    const inValue = Array.from(document.querySelectorAll("input,textarea")).some((el) => (el as HTMLInputElement).value === TOKEN);
    expect(inValue).toBe(false);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state))).not.toContain(TOKEN);
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => ({ v: m.state.variables, d: m.state.data })))).not.toContain(TOKEN);
    expect(api.requests.some((r) => r.url.includes(TOKEN))).toBe(false);
  });

  it("refuses an empty secret before sending, in words", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
    await user.click(screen.getByRole("button", { name: "Save source" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Enter the token/);
    expect(api.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("stored secrets show the keep hint and PATCH omits them", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ sources: [source("s1", "Prom", { auth: bearer() })] }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Edit Prom" }));
    const token = screen.getByLabelText("Token") as HTMLInputElement;
    expect(token.value).toBe("");
    expect(screen.getByText("Saved. Leave empty to keep it.")).toBeTruthy();
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Prom main");
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "PATCH")).toBe(true));
    const body = api.requests.find((r) => r.method === "PATCH")!.body as { name: string; auth?: Record<string, unknown> };
    expect(body.name).toBe("Prom main");
    expect(body.auth?.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("\"token\"");
    await waitFor(() => expect(api.state.sources[0].name).toBe("Prom main"));
  });

  it("test connection shows version or words", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({}, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected · version fake")).toBeTruthy();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      url === "/api/monitoring/sources/test" ? Promise.resolve(json({ ok: false, version: null, message: "connection refused" })) : real(url, init));
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("connection refused")).toBeTruthy();
  });
});

describe("deleting a source", () => {
  const seed = () => {
    const prom = source("s1", "Prom", { used_by: [{ id: "p1", name: "Dev" }] });
    const dev = { ...seedProject("p1", "Dev"), links: [{ source_id: "s1", source_name: "Prom", source_type: "prometheus" as const, filter: "", filter_origin: "none" as const, created_by_project: false }] };
    return installFakeMonitoringApi({ sources: [prom], projects: [dev] }, fallback);
  };

  it("delete review opens on its action button and Ctrl+Enter confirms", async () => {
    const api = seed();
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Prom" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete source Prom?" });
    expect(await within(dialog).findByText("Projects that use it lose it: Dev.")).toBeTruthy();
    const go = within(dialog).getByRole("button", { name: "Delete source" });
    expect(document.activeElement).toBe(go);
    fireEvent.keyDown(go, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.state.sources).toHaveLength(0));
    expect(await screen.findByText("No sources yet. Add one here or while setting up a project.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("stale delete review asks again", async () => {
    const api = seed();
    const real = globalThis.fetch;
    let first = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/delete-review") && first) {
        first = false;
        return json({ source_id: "s1", name: "Prom", projects: [], token: "old" });
      }
      return real(url, init);
    });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Prom" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Delete source" }));
    expect(await screen.findByText("Something changed since the review. Review it again.")).toBeTruthy();
    expect(api.state.sources).toHaveLength(1);
    expect(await screen.findByText("Projects that use it lose it: Dev.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    await waitFor(() => expect(api.state.sources).toHaveLength(0));
  });

  it("Esc in the review returns focus to Delete", async () => {
    seed();
    open();
    const row = await screen.findByRole("button", { name: "Delete Prom" });
    row.focus();
    fireEvent.click(row);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Delete source" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete Prom" }));
  });
});

describe("collect mode", () => {
  it("hands the entered source to the caller and stores nothing", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    const onCollect = vi.fn();
    render(<QueryClientProvider client={new QueryClient()}><SourceForm mode="collect" onCancel={() => {}} onCollect={onCollect} /></QueryClientProvider>);
    await user.type(screen.getByLabelText("Address"), "http://loki.example:3100");
    await user.selectOptions(screen.getByLabelText("Type"), "loki");
    await user.click(screen.getByRole("button", { name: "Use this source" }));
    expect(onCollect).toHaveBeenCalledWith(expect.objectContaining({ type: "loki", reach: "url", url: "http://loki.example:3100" }));
    expect(api.requests).toHaveLength(0);
  });
});

describe("fix round", () => {
  it("a save-mode form that is not unmounted holds no secret after saving", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    render(<QueryClientProvider client={new QueryClient()}><SourceForm mode="save" onSaved={() => {}} onCancel={() => {}} /></QueryClientProvider>);
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.selectOptions(screen.getByLabelText("Authentication"), "bearer");
    await user.type(screen.getByLabelText("Token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.state.sources).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save source" }).getAttribute("aria-disabled")).toBeNull());
    expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("two identical failed deletes in a row leave focus on Delete source", async () => {
    const api = installFakeMonitoringApi({ sources: [source("s1", "Prom")] }, fallback);
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response(JSON.stringify({ detail: "The server could not delete it." }), { status: 500, headers: { "content-type": "application/json" } }) : real(url, init));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Prom" }));
    const go = await screen.findByRole("button", { name: "Delete source" });
    for (let i = 0; i < 2; i++) {
      fireEvent.click(go);
      await screen.findByText("The server could not delete it.");
      await waitFor(() => expect(document.activeElement).toBe(go));
      (document.activeElement as HTMLElement).blur();
      fireEvent.click(go);
      await waitFor(() => expect(document.activeElement).toBe(go));
    }
    expect(api.state.sources).toHaveLength(1);
  });

  it("focus returns to Add a source after Cancel", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({}, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a source" })));
  });

  it("a failed source list on the source page says so and can retry", async () => {
    installFakeMonitoringApi({}, fallback);
    const real = globalThis.fetch;
    let fail = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      url === "/api/monitoring/sources" && fail ? new Response(JSON.stringify({ detail: "Sources could not be read." }), { status: 500, headers: { "content-type": "application/json" } }) : real(url, init));
    renderMonitoringApp({ tabs: tabsWith({ page: "source", id: "s1" }) });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Sources could not be read/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("Remove saved CA sends an empty ca_pem", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ sources: [source("s1", "Prom", { has_ca: true })] }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Edit Prom" }));
    await user.click(screen.getByLabelText("Remove saved CA"));
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "PATCH")).toBe(true));
    expect((api.requests.find((r) => r.method === "PATCH")!.body as { ca_pem?: string }).ca_pem).toBe("");
  });
});

describe("Source page focus", () => {
  it("Back to Sources keeps the keyboard on the workspace", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ sources: [source("s1", "Prom")] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "source", id: "s1" }) });
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeTruthy();
    expect(document.activeElement?.tagName).toBe("MAIN");
  });
});

describe("Source errors in plain words", () => {
  const DOWN = "Can't reach the console's server. Check that it's running, then try again.";

  it("the Sources page and a source's page say the server can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    open();
    const list = document.querySelector<HTMLElement>("[data-monitoring-page]")!;
    expect((await within(list).findByRole("alert")).textContent).toBe(`${DOWN}Try again`);
    cleanup();
    renderMonitoringApp({ tabs: tabsWith({ page: "source", id: "s1" }) });
    const page = document.querySelector<HTMLElement>("[data-monitoring-page]")!;
    expect((await within(page).findByRole("alert")).textContent).toBe(`${DOWN}Try again`);
  });
});

describe("Saving once", () => {
  it("Save stays busy until the caller has finished, so a second press adds nothing", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    let finish = () => {};
    const onSaved = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<QueryClientProvider client={new QueryClient()}><SourceForm mode="save" onSaved={onSaved} onCancel={() => {}} /></QueryClientProvider>);
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    const save = screen.getByRole("button", { name: "Save source" });
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const busy = screen.getByRole("button", { name: "Saving…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    await user.click(busy);
    await user.type(screen.getByLabelText("Address"), "{Enter}");
    expect(api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/sources")).toHaveLength(1);
    expect(api.state.sources).toHaveLength(1);
    // The pressed button keeps the keyboard while it waits.
    expect(document.activeElement).not.toBe(document.body);
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save source" }).getAttribute("aria-disabled")).toBeNull());
  });
});

/** Records every Escape that gets past the page to the document, where the shell's keys live. */
function escapesToDocument() {
  const seen: string[] = [];
  const listen = (e: KeyboardEvent) => { if (e.key === "Escape") seen.push(e.key); };
  document.addEventListener("keydown", listen);
  return { seen, stop: () => document.removeEventListener("keydown", listen) };
}

describe("Esc closes the source forms", () => {
  it("Esc closes Add a source and Edit, returning the keyboard to the button that opened each", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ sources: [source("s1", "Prom")] }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    const doc = escapesToDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Address")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a source" })));

    await user.click(screen.getByRole("button", { name: "Edit Prom" }));
    expect(await screen.findByRole("form", { name: "Edit Prom" })).toBeTruthy();
    await user.keyboard("{Escape}");
    doc.stop();
    expect(screen.queryByRole("form", { name: "Edit Prom" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Prom" })));
    expect(doc.seen).toEqual([]);
  });
});

describe("Sources OmniKrux installed", () => {
  it("installed sources show the chip", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({
      sources: [
        source("s1", "Prometheus · kind", { reach: "cluster", url: null, cluster_id: "c1", cluster_name: "kind", namespace: "monitoring", service: "prom", installed_by_omnikrux: true }),
        source("s2", "Central"),
      ],
    }, fallback);
    const { current } = open();
    const rows = await screen.findAllByRole("listitem");
    const ours = rows.find((r) => within(r).queryByText("Prometheus · kind")) as HTMLElement;
    const theirs = rows.find((r) => within(r).queryByText("Central")) as HTMLElement;
    expect(within(ours).getByText("Installed by OmniKrux")).toBeTruthy();
    expect(within(theirs).queryByText("Installed by OmniKrux")).toBeNull();
    expect(within(theirs).queryByRole("button", { name: "Monitoring tools" })).toBeNull();
    await user.click(within(ours).getByRole("button", { name: "Monitoring tools" }));
    await waitFor(() => expect(current().tabs[0].view).toEqual({ page: "tools", clusterId: "c1" }));
  });
});

describe("leaving a source form with changes", () => {
  it("closing the tab while a source is edited asks first", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ sources: [source("s1", "Prom")] }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "sources" }, { page: "home" }) });
    await user.click(await screen.findByRole("button", { name: "Edit Prom" }));
    expect(document.activeElement).not.toBe(document.body);
    const close = screen.getByRole("button", { name: "Close Sources" });
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    await user.type(address, "/x");
    expect(document.activeElement).not.toBe(document.body);
    await user.click(close);
    const ask = screen.getByRole("alertdialog", { name: 'Leave "Prom" with unsaved changes?' });
    expect(within(ask).getByText("Leaving loses what you entered in this form.")).toBeTruthy();
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("http://prom.example:9090/x");
    expect(document.activeElement).not.toBe(document.body);

    // Typed back to how it started: nothing to lose, nothing asked.
    await user.type(screen.getByLabelText("Address"), "{Backspace}{Backspace}");
    await user.click(screen.getByRole("button", { name: "Close Sources" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a new source form asks under its own name, and Cancel lets the tab go", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({}, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "sources" }, { page: "home" }) });
    const off = () => expect(document.activeElement).not.toBe(document.body);
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    off();
    await user.type(screen.getByLabelText("Address"), "http://new.example:9090");
    off();
    await user.click(screen.getByRole("button", { name: "Close Sources" }));
    const ask = screen.getByRole("alertdialog", { name: 'Leave "New source" with unsaved changes?' });
    off();
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    off();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    off();
    await user.click(screen.getByRole("button", { name: "Close Sources" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    off();
  });

  it("another source's page is a way out of an edited source; the same source is not", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ sources: [source("s1", "Prom"), source("s2", "Other")] }, fallback);
    const { navigate, current } = renderMonitoringApp({ tabs: tabsWith({ page: "source", id: "s1" }) });
    const off = () => expect(document.activeElement).not.toBe(document.body);
    await screen.findByRole("heading", { name: "Prom" });
    await user.type(screen.getByLabelText("Address"), "/x");
    off();
    // The same source again (a link to it) keeps the form: nothing asked, nothing lost.
    navigate({ page: "source", id: "s1" }, "push");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("http://prom.example:9090/x");
    off();
    // Another source (Find, a link) would remount the form: asked first.
    navigate({ page: "source", id: "s2" }, "push");
    const ask = screen.getByRole("alertdialog", { name: 'Leave "Prom" with unsaved changes?' });
    expect(current().tabs[0].view).toEqual({ page: "source", id: "s1" });
    off();
    await user.click(within(ask).getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("heading", { name: "Other" })).toBeTruthy();
    expect(current().tabs[0].view).toEqual({ page: "source", id: "s2" });
    off();
  });
});

const NOW = () => new Date().toISOString();
const down = (over: Partial<SourceOut["health"]> = {}): SourceOut["health"] =>
  ({ state: "down", message: "Prom answered, but not as a Prometheus API (HTTP 404). Check the address and the type.", version: null, checked_at: NOW(), ...over });

describe("state words and order", () => {
  it("names a state, and a source that answers is not called unreachable", () => {
    expect(stateWords({ state: "up", message: null, version: null, checked_at: NOW() }, "loki")).toBe("Up");
    expect(stateWords({ state: "unknown", message: null, version: null, checked_at: null }, "loki")).toBe("Not checked yet");
    expect(stateWords(down(), "prometheus")).toBe("Can't be reached");
    expect(stateWords(down({ answered: true }), "prometheus")).toBe("Answers, but not as Prometheus");
    expect(stateWords(down({ answered: true }), "loki")).toBe("Answers, but not as Loki");
    expect(stateWords(down({ answered: true }), "alertmanager")).toBe("Answers, but not as Alertmanager");
  });

  it("orders Prometheus, Loki, Alertmanager, then by name", () => {
    const l = (source_type: "prometheus" | "loki" | "alertmanager", source_name: string) => ({ source_type, source_name });
    const sorted = sortLinks([l("alertmanager", "A"), l("loki", "Z"), l("prometheus", "Y"), l("prometheus", "B"), l("loki", "C")]);
    expect(sorted.map((x) => x.source_name)).toEqual(["B", "Y", "C", "Z", "A"]);
  });

  it("a source that answers is not called unreachable on the list", async () => {
    installFakeMonitoringApi({ sources: [source("s1", "Prom"), source("s2", "Other")], health: { s1: down({ answered: true }), s2: down({ message: "Can't reach Other: the connection was refused." }) } }, fallback);
    open();
    expect(await screen.findByText("Answers, but not as Prometheus")).toBeTruthy();
    expect(screen.getByText("Can't be reached")).toBeTruthy();
  });
});

describe("Sources page, states and words", () => {
  it("the sources list shows the full Used by on hover", async () => {
    const used = [{ id: "p1", name: "Alpha" }, { id: "p2", name: "Beta" }, { id: "p3", name: "Gamma" }];
    installFakeMonitoringApi({ sources: [source("s1", "Prom", { used_by: used, url: "http://prom.example:9090/very/long/path" })] }, fallback);
    open();
    const usedBy = await screen.findByText("Used by Alpha, Beta, Gamma");
    expect(usedBy.getAttribute("title")).toBe("Used by Alpha, Beta, Gamma");
    expect(screen.getByText("http://prom.example:9090/very/long/path").getAttribute("title")).toBe("http://prom.example:9090/very/long/path");
  });

  it("rows read Checking until the first health read", async () => {
    installFakeMonitoringApi({ sources: [source("s1", "Prom")], health: { s1: { state: "up", message: null, version: "3", checked_at: NOW() } } }, fallback);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    intercept((url, pass) => (url.startsWith("/api/monitoring/sources/health") ? held.then(pass) : null));
    open();
    expect(await screen.findByText("Checking…")).toBeTruthy();
    expect(screen.queryByText("Not checked yet")).toBeNull();
    release();
    expect(await screen.findByText("Up")).toBeTruthy();
    expect(screen.queryByText("Checking…")).toBeNull();
  });
});

describe("Source form, states and words", () => {
  it("switching type clears the old test result and sets that type's placeholder", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({}, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected · version fake")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Type"), "loki");
    expect(screen.queryByText("Connected · version fake")).toBeNull();
    expect((screen.getByLabelText("Address") as HTMLInputElement).placeholder).toBe("http://loki.example:3100");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("saving a source that failed its test says so", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    open();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      url === "/api/monitoring/sources/test" ? Promise.resolve(json({ ok: false, version: null, message: "connection refused" })) : real(url, init));
    await user.click(await screen.findByRole("button", { name: "Add a source" }));
    await user.type(screen.getByLabelText("Address"), "http://prom.example:9090");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("connection refused")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.state.sources).toHaveLength(1));
    const name = api.state.sources[0].name;
    expect((await screen.findByText(`Saved ${name}. It didn't answer the last test, so its panels say so until it does.`)).getAttribute("role")).toBe("status");
  });

  it("editing keeps the name and locks an in-cluster type", async () => {
    const user = userEvent.setup();
    const inCluster = source("s1", "Prom in dev", { reach: "cluster", url: null, cluster_id: "c1", cluster_name: "dev", namespace: "monitoring", service: "prom", port: "9090", has_ca: true });
    const api = installFakeMonitoringApi({ sources: [inCluster, source("s2", "By address")] }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Edit Prom in dev" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Prom in dev");
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
    expect(document.querySelector("[data-fixed-type]")?.textContent).toBe("Prometheus-compatible");
    expect(screen.queryByLabelText(/CA certificate/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Edit By address" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("By address");
    expect(screen.getByLabelText(/CA certificate/)).toBeTruthy();
    expect(api.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("the source page shows its state and Test", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ sources: [source("s1", "Prom", { used_by: [{ id: "p1", name: "Dev" }] })], health: { s1: down({ answered: true }) } }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "source", id: "s1" }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Prom" })).toBeTruthy();
    expect(await screen.findByText("Answers, but not as Prometheus")).toBeTruthy();
    expect(screen.getByText("Used by Dev")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Test Prom" }));
    expect(await screen.findByText(/Connected · version fake/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete Prom" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("Source form, fix round 1", () => {
  it("the buttons, not only the message, are scrolled into view", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({}, fallback);
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      open();
      await user.click(await screen.findByRole("button", { name: "Add a source" }));
      await user.click(screen.getByRole("button", { name: "Save source" }));
      await screen.findByRole("alert");
      expect(scrolled.at(-1)?.contains(screen.getByRole("button", { name: "Test connection" }))).toBe(true);
      expect(scrolled.at(-1)?.tagName).toBe("DIV");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("an existing source's type is read-only text, and clearing the name says it is kept", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ sources: [source("s1", "Prom")] }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Edit Prom" }));
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
    expect(document.querySelector("[data-fixed-type]")?.textContent).toBe("Prometheus-compatible");
    expect(screen.queryByText("Leave empty to keep the name.")).toBeNull();
    await user.clear(screen.getByLabelText("Name"));
    expect(screen.getByText("Leave empty to keep the name.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(api.requests.some((r) => r.method === "PATCH")).toBe(true));
    expect(api.requests.find((r) => r.method === "PATCH")!.body).not.toHaveProperty("type");
  });
});
