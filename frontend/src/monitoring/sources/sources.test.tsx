import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceOut } from "../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceForm } from "./SourceForm";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import { isQueryable, sourceTypeLabel, whereLabel } from "./sourceLabels";

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
