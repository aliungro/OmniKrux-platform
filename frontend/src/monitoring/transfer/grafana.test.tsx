import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import { alertFormMarks, clearAlertForms } from "../alerts/rules/formSessions";
import { TransferRequestError, type GrafanaDashboardsOut, type GrafanaOut } from "./api";
import { GrafanaDashboardList } from "./GrafanaDashboardList";
import { grafanaWhere } from "./grafanaLabels";

const T = "2026-01-01T00:00:00Z";
const TOKEN = "glsa_example-token-4711";
const SIGN_IN = "Main rejected the sign-in (HTTP 401). Check the token, or the user name and password.";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const CLUSTERS = [{ id: "c1", name: "dev", context_name: "kind-dev", server: null, original_server: null, provider: "kind", region: null, environment: "dev", state: "connected", message: null, source: "file" }];
const fallback = async (url: string) => json(url === "/api/clusters" ? CLUSTERS : []);

function grafana(id: string, name: string, over: Partial<GrafanaOut> = {}): GrafanaOut {
  return {
    id, name, reach: "url", url: "http://grafana.example.invalid:3000", cluster_id: null, cluster_name: null, namespace: null, service: null,
    port: null, scheme: "http", path_prefix: "", auth: { type: "none", username: null, has_password: false, has_token: false },
    dashboards_imported: 0, created_at: T, updated_at: T, ...over,
  };
}
const bearer: GrafanaOut["auth"] = { type: "bearer", username: null, has_password: false, has_token: true };

const open = () => renderMonitoringApp({ tabs: tabsWith({ page: "sources" }) });
const frame = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const id of [...alertFormMarks.keys()]) clearAlertForms(id);
});

describe("grafanaWhere", () => {
  it("names the address or the cluster service", () => {
    expect(grafanaWhere(grafana("g", "G"))).toBe("http://grafana.example.invalid:3000");
    expect(grafanaWhere(grafana("g", "G", { reach: "cluster", url: null, cluster_id: "c1", cluster_name: "dev", namespace: "monitoring", service: "grafana", port: "80" })))
      .toBe("dev · monitoring/grafana:80");
    expect(grafanaWhere({ reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "grafana", port: "80" }, "prod")).toBe("prod · monitoring/grafana:80");
  });
});

describe("Grafana connections on the Sources page", () => {
  it("lists connections and says when there are none", async () => {
    installFakeMonitoringApi({}, fallback);
    open();
    expect(await screen.findByText("No Grafana connected. Connect one here or from Import.")).toBeTruthy();
    cleanup();
    installFakeMonitoringApi({ transfer: { grafana: [grafana("g1", "Main", { dashboards_imported: 3 })] } }, fallback);
    open();
    expect(await screen.findByText("3 dashboards imported")).toBeTruthy();
    expect(screen.getByText("http://grafana.example.invalid:3000")).toBeTruthy();
    for (const b of ["Test Main", "Edit Main", "Remove Main"]) expect(screen.getByRole("button", { name: b })).toBeTruthy();
  });

  it("a saved token shows the keep hint and PATCH omits it", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ transfer: { grafana: [grafana("g1", "Main", { auth: bearer })] } }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Edit Main" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Main" });
    const token = within(dialog).getByLabelText("Token") as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.type).toBe("password");
    expect(token.getAttribute("autocomplete")).toBe("off");
    expect(within(dialog).getByText("Saved. Leave empty to keep it.")).toBeTruthy();
    expect((within(dialog).getByLabelText("Sign-in") as HTMLSelectElement).value).toBe("bearer");
    await user.type(within(dialog).getByLabelText("Name"), "Main Grafana");
    await user.click(within(dialog).getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patch = api.requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toBe("/api/monitoring/grafana/g1");
    expect(patch?.body).toEqual({ name: "Main Grafana", url: "http://grafana.example.invalid:3000", auth: { type: "bearer" } });
    expect(api.state.transfer.grafana[0].auth.has_token).toBe(true);
    // Back on the Edit button it came from.
    await frame();
    expect(document.activeElement).toBe(await screen.findByRole("button", { name: "Edit Main Grafana" }));
  });

  it("inside a cluster the sign-in is none and says why", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Connect a Grafana" }));
    const dialog = screen.getByRole("dialog", { name: "Connect a Grafana" });
    const reach = within(dialog).getByRole("radiogroup", { name: "Reach it" });
    expect(document.activeElement).toBe(within(reach).getByRole("radio", { name: "By its address" }));
    expect((within(dialog).getByLabelText("Address") as HTMLInputElement).placeholder).toBe("http://grafana.example:3000");
    await user.selectOptions(within(dialog).getByLabelText("Sign-in"), "bearer");
    await user.click(within(reach).getByRole("radio", { name: "Inside a cluster" }));
    const signIn = within(dialog).getByLabelText("Sign-in") as HTMLSelectElement;
    expect(signIn.value).toBe("none");
    expect(signIn.disabled).toBe(true);
    expect(within(dialog).getByText("A Grafana reached through its cluster is read without a sign-in (anonymous access).")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
    // The backend's words for what is missing.
    await user.click(within(dialog).getByRole("button", { name: "Save connection" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("Pick the cluster, namespace, service and port.");
    await user.selectOptions(await within(dialog).findByLabelText("Cluster"), "c1");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).placeholder).toBe("Grafana · dev");
    await user.type(within(dialog).getByLabelText("Namespace"), "monitoring");
    await user.type(within(dialog).getByLabelText("Service"), "grafana");
    await user.type(within(dialog).getByLabelText("Port"), "80");
    await user.click(within(dialog).getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(api.state.transfer.grafana).toHaveLength(1));
    const post = api.requests.find((r) => r.method === "POST" && r.url === "/api/monitoring/grafana");
    expect(post?.body).toEqual({ reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "grafana", port: "80", scheme: "http", auth: { type: "none" } });
  });

  it("test connection shows the version and count, or the words", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ transfer: { grafanaTests: { new: { ok: true, version: "12.1.0", message: null, dashboards: 23 } } } }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Connect a Grafana" }));
    const dialog = screen.getByRole("dialog", { name: "Connect a Grafana" });
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("Use an http or https address with a host, like http://prometheus.example:9090.");
    await user.type(within(dialog).getByLabelText("Address"), "http://grafana.example.invalid:3000");
    await user.selectOptions(within(dialog).getByLabelText("Sign-in"), "bearer");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(within(dialog).getByRole("alert").textContent).toBe("A service account token is needed.");
    await user.type(within(dialog).getByLabelText("Token"), TOKEN);
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect((await within(dialog).findByRole("status")).textContent).toBe("Connected · Grafana 12.1.0 · 23 dashboards");
    api.state.transfer.grafanaTests.new = { status: 502, detail: { code: "grafana", message: SIGN_IN, key: null, problems: [] } };
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe(SIGN_IN));
    api.state.transfer.grafanaTests.new = { ok: false, version: "12.1.0", message: SIGN_IN, dashboards: null };
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe(SIGN_IN));
    // Nothing was saved, and the token only ever went in a request body.
    expect(api.state.transfer.grafana).toHaveLength(0);
    expect(api.requests.every((r) => !r.url.includes(TOKEN))).toBe(true);
  });

  it("a row's Test says the version and count", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({
      transfer: { grafana: [grafana("g1", "Main")], grafanaTests: { g1: { ok: true, version: "13.3.0", message: null, dashboards: 1 } } },
    }, fallback);
    open();
    await user.click(await screen.findByRole("button", { name: "Test Main" }));
    expect(await screen.findByText("Connected · Grafana 13.3.0 · 1 dashboard")).toBeTruthy();
  });

  it("removing a connection asks first and opens on its button", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ transfer: { grafana: [grafana("g1", "Main", { dashboards_imported: 2 })] } }, fallback);
    open();
    const remove = await screen.findByRole("button", { name: "Remove Main" });
    await user.click(remove);
    const ask = screen.getByRole("alertdialog", { name: "Remove the connection Main?" });
    expect(within(ask).getByText("Dashboards imported from it stay. To update them from their source later, pick their file.")).toBeTruthy();
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Remove connection" }));
    expect(within(ask).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(api.state.transfer.grafana).toHaveLength(1);
    await user.click(remove);
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.state.transfer.grafana).toHaveLength(0));
    expect(await screen.findByText("No Grafana connected. Connect one here or from Import.")).toBeTruthy();
    await frame();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Grafana connections" }));
  });

  it("the token never shows after saving", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({}, fallback);
    const { client } = open();
    await user.click(await screen.findByRole("button", { name: "Connect a Grafana" }));
    const dialog = screen.getByRole("dialog", { name: "Connect a Grafana" });
    await user.type(within(dialog).getByLabelText("Address"), "http://grafana.example.invalid:3000");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).placeholder).toBe("Grafana · grafana.example.invalid");
    await user.selectOptions(within(dialog).getByLabelText("Sign-in"), "bearer");
    await user.type(within(dialog).getByLabelText("Token"), TOKEN);
    await user.click(within(dialog).getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(api.state.transfer.grafana).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const leaks = () => {
      expect(document.body.innerHTML).not.toContain(TOKEN);
      for (const input of document.querySelectorAll("input")) expect(input.value).not.toContain(TOKEN);
      const cached = JSON.stringify(client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]));
      const mutations = JSON.stringify(client.getMutationCache().getAll().map((m) => [m.state.variables, m.state.data]));
      expect(cached).not.toContain(TOKEN);
      expect(mutations).not.toContain(TOKEN);
      expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    };
    leaks();
    // Sent once, in the body of the create only.
    expect(api.requests.filter((r) => JSON.stringify(r.body ?? null).includes(TOKEN)).map((r) => `${r.method} ${r.url}`)).toEqual(["POST /api/monitoring/grafana"]);
    await user.click(await screen.findByRole("button", { name: /^Edit Grafana/ }));
    const edit = screen.getByRole("dialog", { name: /^Edit Grafana/ });
    expect((within(edit).getByLabelText("Token") as HTMLInputElement).value).toBe("");
    expect(within(edit).getByText("Saved. Leave empty to keep it.")).toBeTruthy();
    leaks();
  });

  it("an unsaved connection form holds the tab, and Esc asks before discarding it", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({}, fallback);
    const app = open();
    const connect = await screen.findByRole("button", { name: "Connect a Grafana" });
    await user.click(connect);
    const dialog = screen.getByRole("dialog", { name: "Connect a Grafana" });
    await user.type(within(dialog).getByLabelText("Address"), "http://grafana.example.invalid");
    await user.selectOptions(within(dialog).getByLabelText("Sign-in"), "bearer");
    await user.type(within(dialog).getByLabelText("Token"), TOKEN);
    // The mark holds the form's title only.
    expect([...(alertFormMarks.get("start0")?.values() ?? [])]).toEqual([{ title: "Connect a Grafana", page: "sources" }]);
    expect(JSON.stringify([...alertFormMarks.entries()].map(([k, v]) => [k, [...v.values()]]))).not.toContain(TOKEN);
    app.navigate({ page: "home" }, "push");
    expect(app.current().tabs[0].view).toEqual({ page: "sources" });
    const leave = screen.getByRole("alertdialog", { name: 'Leave "Connect a Grafana" with unsaved changes?' });
    await user.click(within(leave).getByRole("button", { name: "Stay" }));
    await frame();
    // Esc asks first; Keep editing keeps it, Discard closes it.
    within(dialog).getByLabelText("Address").focus();
    await user.keyboard("{Escape}");
    const discard = screen.getByRole("alertdialog", { name: "Discard this Grafana connection?" });
    await user.click(within(discard).getByRole("button", { name: "Keep editing" }));
    expect((within(dialog).getByLabelText("Token") as HTMLInputElement).value).toBe(TOKEN);
    within(dialog).getByLabelText("Address").focus();
    await user.keyboard("{Escape}");
    await user.click(within(screen.getByRole("alertdialog", { name: "Discard this Grafana connection?" })).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(alertFormMarks.size).toBe(0);
    await frame();
    expect(document.activeElement).toBe(connect);
  });
});

// --- The dashboard checklist ------------------------------------------------------------------

function boards(n: number): GrafanaDashboardsOut {
  const items = Array.from({ length: n }, (_, i) => ({
    uid: `u${i + 1}`, title: `Board ${String(i + 1).padStart(2, "0")}`, folder: i < 20 ? "Team" : null, tags: [],
  }));
  if (n > 4) items[4] = { ...items[4], title: "Node exporter" };
  if (n > 21) items[21] = { ...items[21], folder: "Nodes" };
  return { items, truncated: false };
}

function Checklist({ load, defaultAll = false, initial = [] }: { load: () => Promise<GrafanaDashboardsOut>; defaultAll?: boolean; initial?: string[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  return <GrafanaDashboardList load={load} loadKey="k" selected={selected} onChange={setSelected} name="Main" defaultAll={defaultAll} />;
}

describe("Grafana dashboard checklist", () => {
  it("the checklist selects all, filters and moves by keys", async () => {
    const user = userEvent.setup();
    render(<Checklist load={async () => boards(25)} />);
    expect(screen.getByRole("status").textContent).toBe("Loading dashboards…");
    const group = await screen.findByRole("group", { name: "Dashboards in Main" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(25);
    expect(screen.getByText("0 selected")).toBeTruthy();
    // Labelled by the title, the folder after it.
    const node = within(group).getByRole("checkbox", { name: "Node exporter" });
    expect(node.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(node.getAttribute("aria-describedby")!)?.textContent).toBe("Team");
    await user.type(screen.getByLabelText("Filter dashboards"), "node");
    const shown = within(group).getAllByRole("checkbox");
    expect(shown.map((c) => c.getAttribute("aria-labelledby") && document.getElementById(c.getAttribute("aria-labelledby")!)?.textContent))
      .toEqual(["Node exporter", "Board 22"]);
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    await user.clear(screen.getByLabelText("Filter dashboards"));
    // One checkbox takes Tab; arrows move, Home/End jump, Space toggles.
    const all = within(group).getAllByRole("checkbox") as HTMLInputElement[];
    expect(all.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    all[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(all[1]);
    expect(all[1].tabIndex).toBe(0);
    await user.keyboard(" ");
    expect(all[1].checked).toBe(true);
    expect(screen.getByText("3 selected")).toBeTruthy();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(all[24]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(all[23]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(all[0]);
    await user.click(screen.getByRole("button", { name: "Select none" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("a short list has no filter; defaultAll starts with everything", async () => {
    render(<Checklist defaultAll load={async () => boards(4)} />);
    await screen.findByRole("group", { name: "Dashboards in Main" });
    expect(screen.queryByLabelText("Filter dashboards")).toBeNull();
    expect(await screen.findByText("4 selected")).toBeTruthy();
  });

  it("more than 100 picks none by default and stops at 100", async () => {
    const user = userEvent.setup();
    render(<Checklist defaultAll load={async () => ({ ...boards(120), truncated: true })} />);
    await screen.findByRole("group", { name: "Dashboards in Main" });
    expect(screen.getByText("Showing the first 5000 dashboards.")).toBeTruthy();
    expect(screen.getByText("Pick up to 100 dashboards at a time.")).toBeTruthy();
    expect(screen.getByText("0 selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("100 selected")).toBeTruthy();
    const last = screen.getAllByRole("checkbox").at(-1) as HTMLInputElement;
    await user.click(last);
    expect(last.checked).toBe(false);
    expect(screen.getByText("100 selected")).toBeTruthy();
  });

  it("an empty Grafana says so", async () => {
    render(<Checklist load={async () => ({ items: [], truncated: false })} />);
    expect(await screen.findByText("This Grafana has no dashboards.")).toBeTruthy();
  });

  it("a failed load offers Try again", async () => {
    const user = userEvent.setup();
    const load = vi.fn<() => Promise<GrafanaDashboardsOut>>()
      .mockRejectedValueOnce(new TransferRequestError(502, "grafana", SIGN_IN))
      .mockResolvedValueOnce(boards(3));
    render(<Checklist load={load} />);
    expect((await screen.findByRole("alert")).textContent).toContain(SIGN_IN);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    const group = await screen.findByRole("group", { name: "Dashboards in Main" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(within(group).getAllByRole("checkbox")[0]);
  });
});
