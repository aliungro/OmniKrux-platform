import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectOut, SourceOut } from "../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import type { ProbeResultOut } from "./api";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const T = "2026-01-01T00:00:00Z";
const HOST = "docker-host.example";
const URLS = { prometheus: `http://${HOST}:9090`, alertmanager: `http://${HOST}:9093`, loki: `http://${HOST}:3100` };
const up = (version: string): Partial<ProbeResultOut> => ({ ok: true, version, message: null });
const ALL_UP = { [URLS.prometheus]: up("3.1.0"), [URLS.alertmanager]: up("0.28.0"), [URLS.loki]: up("3.5.0") };
const ANSWERED = "The tools answer. They're added to this project's sources.";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);

function source(id: string, name: string, type: SourceOut["type"], url: string): SourceOut {
  return {
    id, name, type, reach: "url", url, cluster_id: null, cluster_name: null, namespace: null, service: null, port: null, scheme: "http", path_prefix: "",
    auth: { type: "none", username: null, header_name: null, has_password: false, has_token: false, has_api_key: false, has_client_key: false, has_client_cert: false },
    headers: [], has_ca: false, created_by_project_id: null, used_by: [], health: { state: "unknown", message: null, version: null, checked_at: null },
    created_at: T, updated_at: T,
  };
}
const project = (id: string, name: string, over: Partial<ProjectOut> = {}): ProjectOut => ({ ...seedProject(id, name, "docker"), ...over });

type Api = ReturnType<typeof installFakeMonitoringApi>;
const posts = (api: Api) => api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/sources");
const puts = (api: Api) => api.requests.filter((r) => r.method === "PUT");

async function write(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Monitoring tools" });
  await user.type(screen.getByLabelText("Address OmniKrux will reach them at"), HOST);
  await user.click(screen.getByRole("button", { name: "Write the file" }));
}
const open = (id: string) => renderMonitoringApp({ tabs: tabsWith({ page: "project", id }) });

describe("Connecting answered tools to a project", () => {
  it("a second answer creates no duplicate and links nothing twice", async () => {
    const api = installFakeMonitoringApi({ projects: [project("p1", "Home lab")], install: { probe: ALL_UP } }, fallback);
    const user = userEvent.setup();
    open("p1");
    await write(user);
    expect(await screen.findByText("Connected 3 sources to Home lab.")).toBeTruthy();
    expect(posts(api)).toHaveLength(3);
    expect(puts(api)).toHaveLength(3);

    cleanup();
    open("p1");
    await write(user);
    expect(await screen.findByText(ANSWERED)).toBeTruthy();
    expect(await screen.findByText("Connected 3 sources to Home lab.")).toBeTruthy();
    expect(posts(api)).toHaveLength(3);
    expect(puts(api)).toHaveLength(3);
    expect(api.state.sources).toHaveLength(3);
  });

  it("reuses a source that already reaches the address, for this project only", async () => {
    const prom = source("s-prom", "Prometheus on the box", "prometheus", URLS.prometheus);
    const other = source("s-other", "Elsewhere", "prometheus", "http://other.example:9090");
    const api = installFakeMonitoringApi({
      sources: [prom, other], install: { probe: ALL_UP },
      projects: [project("p1", "Home lab"), project("p2", "Other", { links: [{ source_id: "s-other", source_name: "Elsewhere", source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false }] })],
    }, fallback);
    const user = userEvent.setup();
    open("p1");
    await write(user);
    expect(await screen.findByText(ANSWERED)).toBeTruthy();
    expect(posts(api).map((r) => (r.body as { type: string }).type)).toEqual(["alertmanager", "loki"]);
    expect(puts(api).every((r) => r.url.startsWith("/api/monitoring/projects/p1/sources/"))).toBe(true);
    expect(puts(api).some((r) => r.url.endsWith("/s-prom"))).toBe(true);
    const p2 = api.state.projects.find((p) => p.id === "p2")!;
    expect(p2.links.map((l) => l.source_id)).toEqual(["s-other"]);
    expect(api.state.projects.find((p) => p.id === "p1")!.links).toHaveLength(3);
  });

  it("a link that fails says which tool, claims nothing false, and retry links the existing source", async () => {
    const api = installFakeMonitoringApi({ projects: [project("p1", "Home lab")], install: { probe: ALL_UP } }, fallback);
    const real = globalThis.fetch;
    let failing = true;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (failing && (init?.method ?? "GET") === "PUT" && url.startsWith("/api/monitoring/projects/p1/sources/")) {
        const made = api.state.sources.find((x) => url.endsWith(`/${x.id}`));
        if (made?.type === "loki") {
          return Promise.resolve(new Response(JSON.stringify({ detail: "The link couldn't be saved." }), { status: 500, headers: { "content-type": "application/json" } }));
        }
      }
      return real(input, init);
    });
    const user = userEvent.setup();
    open("p1");
    await write(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`Couldn't connect Loki · ${HOST}: The link couldn't be saved.`);
    expect(screen.getByText("Connected 2 sources to Home lab.")).toBeTruthy();
    expect(screen.queryByText(ANSWERED)).toBeNull();
    expect(screen.getByText("The tools answer.")).toBeTruthy();
    expect(posts(api)).toHaveLength(3);

    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(ANSWERED)).toBeTruthy();
    expect(screen.getByText("Connected 3 sources to Home lab.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(posts(api)).toHaveLength(3);
    expect(api.state.sources).toHaveLength(3);
    expect(api.state.projects[0].links).toHaveLength(3);
  });
});

describe("In setup the generated picks are created with the project", () => {
  it("generated picks reach the Create project request", async () => {
    const api = installFakeMonitoringApi({ install: { probe: ALL_UP } }, fallback);
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "setup" }) });
    await user.click(await screen.findByRole("radio", { name: /A Docker host/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText("Address OmniKrux will reach them at"), HOST);
    await user.click(screen.getByRole("button", { name: "Write the file" }));
    await screen.findByRole("group", { name: `Loki · ${HOST}` });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "Home lab");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(api.requests.some((r) => r.url === "/api/monitoring/setup")).toBe(true));
    const body = api.requests.find((r) => r.url === "/api/monitoring/setup")!.body as { kind: string; sources: { source: Record<string, unknown>; filter: string }[] };
    expect(body.kind).toBe("docker");
    expect(body.sources.map((x) => x.source)).toEqual([
      { name: `Prometheus · ${HOST}`, type: "prometheus", reach: "url", url: URLS.prometheus },
      { name: `Alertmanager · ${HOST}`, type: "alertmanager", reach: "url", url: URLS.alertmanager },
      { name: `Loki · ${HOST}`, type: "loki", reach: "url", url: URLS.loki },
    ]);
    expect(body.sources.every((x) => x.filter === "")).toBe(true);
  });
});
