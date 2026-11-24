import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeMonitoringSeed } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import { GenerateTools, type AnsweredTools } from "./GenerateTools";
import type { ProbeResultOut } from "./api";

beforeEach(() => localStorage.clear());
const restore: (() => void)[] = [];
afterEach(() => {
  restore.splice(0).forEach((f) => f());
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async (url: string) => json(url === "/api/clusters" ? [] : []);
const HOST = "docker-host.example";
const URLS = { prometheus: `http://${HOST}:9090`, alertmanager: `http://${HOST}:9093`, loki: `http://${HOST}:3100` };
const up = (version: string): Partial<ProbeResultOut> => ({ ok: true, version, message: null });
const ALL_UP = { [URLS.prometheus]: up("3.1.0"), [URLS.alertmanager]: up("0.28.0"), [URLS.loki]: up("3.5.0") };

const NO_SIGN_IN = "the tools have no sign-in.";
const WAITING = "Waiting for the tools to answer…";
const GAVE_UP = "Still waiting. Check that the tools are running and the ports are open, then wait again.";
const ANSWERED = "The tools answer. They're added to this project's sources.";

const probes = (api: ReturnType<typeof installFakeMonitoringApi>) => api.requests.filter((r) => r.url === "/api/monitoring/install/probe");

function install(extra: FakeMonitoringSeed = {}) {
  return installFakeMonitoringApi(extra, fallback);
}

function renderGenerate(kind: "docker" | "servers", onAnswered: (t: AnsweredTools) => void = () => {}) {
  const user = userEvent.setup();
  render(<GenerateTools kind={kind} onAnswered={onAnswered} />);
  return user;
}

async function write(user: ReturnType<typeof userEvent.setup>, kind: "docker" | "servers" = "docker", address = HOST) {
  await user.type(screen.getByLabelText("Address OmniKrux will reach them at"), address);
  if (kind === "servers") await user.type(screen.getByLabelText("Servers to watch"), "web-1.example\ndb-1.example:9100");
  await user.click(screen.getByRole("button", { name: kind === "docker" ? "Write the file" : "Write the script" }));
}

describe("Generated files", () => {
  it("writing the file shows it with copy and download", async () => {
    const api = install({ install: { generated: {
      kind: "docker", files: [{ name: "docker-compose.yml", content: "services:\n  prometheus: {}\n", executable: false }], urls: URLS, ports: [9090, 9093, 3100],
    } } });
    const user = renderGenerate("docker");
    expect(screen.getByRole("heading", { name: "Install the tools on the Docker host" })).toBeTruthy();
    expect(screen.getByText(/OmniKrux writes a docker-compose file for Prometheus, Alertmanager, node-exporter, Loki and Grafana Alloy\. You run it on the host; OmniKrux never needs SSH or the Docker socket\./)).toBeTruthy();
    expect(screen.getByPlaceholderText(HOST)).toBeTruthy();
    await write(user);

    const post = api.requests.find((r) => r.url === "/api/monitoring/install/generate");
    expect(post?.body).toEqual({ kind: "docker", address: HOST, retention_days: 7 });
    const file = await screen.findByLabelText("docker-compose.yml");
    expect(file.tagName).toBe("PRE");
    expect(file.textContent).toBe("services:\n  prometheus: {}\n");

    const written: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    restore.push(() => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { written.push(t); } } });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(written).toEqual(["services:\n  prometheus: {}\n"]);
    await waitFor(() => expect(screen.getByText("Copied.")).toBeTruthy());

    const blobs: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => { blobs.push(b as Blob); return "blob:x"; };
    URL.revokeObjectURL = () => {};
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    await user.click(screen.getByRole("button", { name: "Download docker-compose.yml" }));
    expect(clicked).toEqual(["docker-compose.yml"]);
    await waitFor(() => expect(document.querySelector("a[download]")).toBeNull());
    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blobs[0]); });
    expect(text).toBe("services:\n  prometheus: {}\n");
  });

  it("the instructions warn that the ports have no sign-in", async () => {
    install();
    const user = renderGenerate("docker");
    await write(user);
    const list = await screen.findByRole("list", { name: "What to do next" });
    const steps = within(list).getAllByRole("listitem");
    expect(steps.map((li) => li.textContent)).toEqual([
      "Copy docker-compose.yml to the Docker host.",
      "In its folder, run docker compose up -d.",
      `Make sure ports 9090, 9093 and 3100 are reachable from OmniKrux, and from nowhere else: ${NO_SIGN_IN}`,
    ]);
  });

  it("servers script instructions name the central address", async () => {
    const api = install();
    const user = renderGenerate("servers");
    expect(screen.getByRole("heading", { name: "Install the tools on your servers" })).toBeTruthy();
    expect(screen.getByPlaceholderText("monitor-1.example")).toBeTruthy();
    expect((screen.getByLabelText("Servers to watch") as HTMLTextAreaElement).placeholder).toBe("web-1.example\ndb-1.example:9100");
    await write(user, "servers", "monitor-1.example");

    const post = api.requests.find((r) => r.url === "/api/monitoring/install/generate");
    expect(post?.body).toEqual({ kind: "servers", address: "monitor-1.example", retention_days: 7, servers: ["web-1.example", "db-1.example:9100"] });
    const list = await screen.findByRole("list", { name: "What to do next" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "On the server that keeps the data (monitor-1.example), run sudo bash omnikrux-monitoring.sh --role central.",
      "On every other server, run sudo bash omnikrux-monitoring.sh --role agent --central monitor-1.example.",
      `Make sure ports 9090, 9093 and 3100 on monitor-1.example are reachable from OmniKrux, and from nowhere else: ${NO_SIGN_IN}`,
      "To remove them later, run the script with --uninstall.",
    ]);
    expect(screen.getByRole("button", { name: /^Download .*\.sh$/ })).toBeTruthy();
  });

  it("validation words appear under their field", async () => {
    const refuse = (message: string) => ({ error: { message }, status: 422 });
    const api = install({ install: { generated: refuse("Use a host name or IP address, without http:// or a port.") } });
    const user = renderGenerate("servers");
    await write(user, "servers", "http://bad");
    const address = screen.getByLabelText("Address OmniKrux will reach them at");
    const words = await screen.findByText("Use a host name or IP address, without http:// or a port.");
    expect(address.getAttribute("aria-describedby")).toBe(words.id);
    expect(address.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(address);
    expect(screen.queryByLabelText(/^docker-compose/)).toBeNull();

    api.state.install.generated = refuse("Keep data for 1 to 90 days.");
    await user.click(screen.getByRole("button", { name: "Write the script" }));
    const days = screen.getByLabelText("Keep data for");
    expect((await screen.findByText("Keep data for 1 to 90 days.")).id).toBe(days.getAttribute("aria-describedby"));
    expect(screen.queryByText("Use a host name or IP address, without http:// or a port.")).toBeNull();

    api.state.install.generated = refuse("Use one host or host:port per line.");
    await user.click(screen.getByRole("button", { name: "Write the script" }));
    const servers = screen.getByLabelText("Servers to watch");
    expect((await screen.findByText("Use one host or host:port per line.")).id).toBe(servers.getAttribute("aria-describedby"));
    expect(document.activeElement).toBe(servers);
  });
});

describe("Waiting for the tools", () => {
  it("shows a row per tool and never says connected before a probe answered", async () => {
    install();
    const user = renderGenerate("docker");
    await write(user);
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screen.getByText(`Prometheus · ${URLS.prometheus}`)).toBeTruthy();
    expect(screen.getByText(`Alertmanager · ${URLS.alertmanager}`)).toBeTruthy();
    expect(screen.getByText(`Loki · ${URLS.loki}`)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("Not answering yet")).toHaveLength(3));
    expect(screen.queryByText(ANSWERED)).toBeNull();
    expect(screen.queryByText(/^Answering/)).toBeNull();
  });

  it("waiting polls every 5 seconds and stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const api = install();
    render(<GenerateTools kind="docker" onAnswered={() => {}} />);
    // userEvent waits on timers that stay still here: the events are fired directly.
    fireEvent.change(screen.getByLabelText("Address OmniKrux will reach them at"), { target: { value: HOST } });
    fireEvent.click(screen.getByRole("button", { name: "Write the file" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(probes(api)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(probes(api)).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Wait again" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(probes(api)).toHaveLength(3);
  });

  it("when every tool answers it says so once and hands the tools over", async () => {
    install({ install: { probe: ALL_UP } });
    const answered: AnsweredTools[] = [];
    const user = renderGenerate("docker", (t) => answered.push(t));
    await write(user);
    expect(await screen.findByText(ANSWERED)).toBeTruthy();
    expect(screen.getByText("Answering · v3.1.0")).toBeTruthy();
    expect(screen.getByText("Answering · v0.28.0")).toBeTruthy();
    expect(screen.getByText("Answering · v3.5.0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull();
    await waitFor(() => expect(answered).toHaveLength(1));
    expect(answered[0].map((t) => t.type).sort()).toEqual(["alertmanager", "loki", "prometheus"]);
    expect(answered[0].find((t) => t.type === "loki")).toEqual({ type: "loki", url: URLS.loki, version: "3.5.0" });
  });

  it("some tools answering is not enough", async () => {
    install({ install: { probe: { [URLS.prometheus]: up("3.1.0") } } });
    const answered: AnsweredTools[] = [];
    const user = renderGenerate("docker", (t) => answered.push(t));
    await write(user);
    expect(await screen.findByText("Answering · v3.1.0")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("Not answering yet")).toHaveLength(2));
    expect(screen.queryByText(ANSWERED)).toBeNull();
    expect(answered).toHaveLength(0);
  });

  it("giving up offers wait again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const api = install();
    render(<GenerateTools kind="docker" onAnswered={() => {}} />);
    // userEvent waits on timers that stay still here: the events are fired directly.
    fireEvent.change(screen.getByLabelText("Address OmniKrux will reach them at"), { target: { value: HOST } });
    fireEvent.click(screen.getByRole("button", { name: "Write the file" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000); });
    expect(screen.getByText(GAVE_UP)).toBeTruthy();
    expect(screen.queryByText(WAITING)).toBeNull();
    const again = screen.getByRole("button", { name: "Wait again" });
    const asked = probes(api).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(probes(api)).toHaveLength(asked);

    fireEvent.click(again);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(WAITING)).toBeTruthy();
    expect(probes(api).length).toBe(asked + 1);
  });
});

describe("In setup", () => {
  it("when all tools answer they become setup picks", async () => {
    install({ install: { probe: ALL_UP } });
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "setup" }) });
    await user.click(await screen.findByRole("radio", { name: /A Docker host/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeTruthy();

    // the generator sits above the existing sources and the add-by-hand button
    const generator = screen.getByRole("heading", { name: "Install the tools on the Docker host" });
    const existing = screen.getByText("Use an existing source");
    const byHand = screen.getByRole("button", { name: "+ Add a source by hand" });
    expect(generator.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(existing.compareDocumentPosition(byHand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await write(user);
    const prom = await screen.findByRole("group", { name: `Prometheus · ${HOST}` });
    expect(screen.getByRole("group", { name: `Alertmanager · ${HOST}` })).toBeTruthy();
    expect(screen.getByRole("group", { name: `Loki · ${HOST}` })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(prom));
    expect(screen.getByText("3 sources in use")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("On a project page", () => {
  it("on a project page answered tools are created and linked", async () => {
    const api = install({ projects: [seedProject("p1", "Home lab", "docker")], install: { probe: ALL_UP } });
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p1" }) });
    await screen.findByRole("heading", { name: "Monitoring tools" });
    await write(user);

    expect(await screen.findByText("Connected 3 sources to Home lab.")).toBeTruthy();
    const created = api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/sources");
    expect(created.map((r) => r.body)).toEqual([
      { name: `Prometheus · ${HOST}`, type: "prometheus", reach: "url", url: URLS.prometheus },
      { name: `Alertmanager · ${HOST}`, type: "alertmanager", reach: "url", url: URLS.alertmanager },
      { name: `Loki · ${HOST}`, type: "loki", reach: "url", url: URLS.loki },
    ]);
    const linked = api.requests.filter((r) => r.method === "PUT" && r.url.startsWith("/api/monitoring/projects/p1/sources/"));
    expect(linked).toHaveLength(3);
    expect(linked.every((r) => (r.body as { filter: string }).filter === "")).toBe(true);
  });
});
