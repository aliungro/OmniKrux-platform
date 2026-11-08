// frontend/src/features/inspector/inspector.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ContainerInfo, PodDescribe, ResourceRow } from "../../api/types";
import { DescribeView } from "./DescribeView";
import { EventsTable } from "./EventsTable";
import { Inspector } from "./Inspector";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

const container = (over: Partial<ContainerInfo> = {}): ContainerInfo => ({
  name: "payments-api",
  image: "acmeprod.azurecr.io/payments-api:2.4.1",
  state: "Waiting: CrashLoopBackOff",
  state_class: "bad",
  ready: false,
  restarts: 14,
  last_state: "Terminated: OOMKilled (exit 137)",
  last_finished_at: "2026-11-07T14:04:14Z",
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "256Mi" },
  limit_hit: ["memory"],
  ports: ["8080/TCP"],
  probes: { liveness: "GET :8080/healthz every 10s" },
  env: [],
  mounts: [],
  ...over,
});

export const describeBody = (over: Partial<PodDescribe> = {}): PodDescribe => ({
  pod: {
    name: "payments-api-1",
    namespace: "payments",
    status: "CrashLoopBackOff",
    status_class: "bad",
    node: "aks-np1-03",
    pod_ip: "10.244.3.17",
    host_ip: "10.0.0.4",
    qos: "Burstable",
    service_account: "payments-api",
    owner: { kind: "ReplicaSet", name: "payments-api-7f9c4", selector: "app=payments-api,pod-template-hash=7f9c4" },
    started_at: "2026-11-07T14:02:00Z",
    resource_version: "1",
  },
  containers: [container()],
  init_containers: [],
  ephemeral_containers: [],
  conditions: [
    { type: "PodScheduled", status: "True", reason: null, message: null },
    { type: "Ready", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [payments-api]" },
  ],
  labels: { app: "payments-api" },
  annotations: {},
  events: [],
  events_error: null,
  ...over,
});

const row = (rv = "1"): ResourceRow => ({
  uid: "u1",
  cluster_id: "c1",
  kind: "Pod",
  namespace: "payments",
  name: "payments-api-1",
  created_at: null,
  labels: {},
  columns: { status: "CrashLoopBackOff", status_class: "bad", resource_version: rv },
});

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...out,
    rerender: (next: ReactNode) => out.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}

describe("describe view", () => {
  it("describe shows OOMKilled last state in bad style", () => {
    render(<DescribeView data={describeBody()} />);
    const last = screen.getByText("Terminated: OOMKilled (exit 137)");
    expect(last.getAttribute("data-tone")).toBe("bad");
    // The memory limit the container ran into is highlighted; the CPU limit is not.
    expect(screen.getByText("256Mi").getAttribute("data-tone")).toBe("bad");
    expect(screen.getByText("500m").getAttribute("data-tone")).toBeNull();
  });

  it("a clean exit is not shown as bad", () => {
    render(<DescribeView data={describeBody({ containers: [container({ last_state: "Terminated: Completed (exit 0)", limit_hit: [] })] })} />);
    expect(screen.getByText("Terminated: Completed (exit 0)").getAttribute("data-tone")).toBeNull();
  });

  it("a failed exit without a reason from Kubernetes is still shown as bad", () => {
    render(<DescribeView data={describeBody({ containers: [container({ last_state: "Terminated (exit 2)", limit_hit: [] })] })} />);
    expect(screen.getByText("Terminated (exit 2)").getAttribute("data-tone")).toBe("bad");
  });

  it("secret env shows source but no value", () => {
    const env = [
      { name: "DB_PASSWORD", value: null, source: "Secret payments-db key password" },
      { name: "LOG_LEVEL", value: "info", source: null },
    ];
    render(<DescribeView data={describeBody({ containers: [container({ env })] })} />);
    const secret = screen.getByTestId("env-DB_PASSWORD");
    expect(secret.textContent).toContain("Secret payments-db key password");
    expect(within(secret).queryByTestId("env-value")).toBeNull();
    expect(within(screen.getByTestId("env-LOG_LEVEL")).getByTestId("env-value").textContent).toBe("info");
  });

  it("marks init and ephemeral containers", () => {
    render(
      <DescribeView
        data={describeBody({
          init_containers: [container({ name: "migrate", state: "Terminated: Completed (exit 0)", state_class: "done" })],
          ephemeral_containers: [container({ name: "debugger-x1", state: "Running", state_class: "ok" })],
        })}
      />,
    );
    expect(within(screen.getByTestId("ctr-migrate")).getByText("Init")).toBeTruthy();
    expect(within(screen.getByTestId("ctr-debugger-x1")).getByText("Ephemeral")).toBeTruthy();
  });

  it("shows conditions as true and false chips and labels as tags", () => {
    render(<DescribeView data={describeBody()} />);
    const conds = within(screen.getByRole("list", { name: "Conditions" }));
    expect(conds.getByText("Pod scheduled").getAttribute("data-status")).toBe("True");
    expect(conds.getByText("Ready").getAttribute("data-status")).toBe("False");
    expect(screen.getByText("app=payments-api")).toBeTruthy();
  });
});

describe("events", () => {
  it("events show grouped count ×58", () => {
    render(
      <EventsTable
        events={[
          { type: "Warning", reason: "BackOff", message: "Back-off restarting failed container", count: 58, last_seen: null },
          { type: "Normal", reason: "Pulled", message: "Image already present", count: 1, last_seen: null },
        ]}
        error={null}
      />,
    );
    expect(screen.getByText("×58")).toBeTruthy();
    expect(screen.getByText("Back-off restarting failed container")).toBeTruthy();
    // A single event shows no count.
    expect(screen.queryByText("×1")).toBeNull();
  });

  it("an events error is shown plainly instead of an empty list", () => {
    render(<EventsTable events={[]} error="Couldn't list events for this pod: forbidden" />);
    expect(screen.getByText("Couldn't list events for this pod: forbidden")).toBeTruthy();
    expect(screen.queryByText("No events")).toBeNull();
  });

  it("no events says so", () => {
    render(<EventsTable events={[]} error={null} />);
    expect(screen.getByText("No events")).toBeTruthy();
  });
});

describe("inspector", () => {
  it("refetches when resource_version changes", async () => {
    const fetch = vi.fn((_url: string) => json(describeBody()));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = wrap(<Inspector row={row("1")} provider="aks" />);
    await screen.findByText("aks-np1-03");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/clusters/c1/pods/payments/payments-api-1/describe");
    rerender(<Inspector row={row("2")} provider="aks" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // The earlier answer stays on screen while the new one loads.
    expect(screen.queryByText("Loading details…")).toBeNull();
  });

  it("shows loading first", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    wrap(<Inspector row={row()} provider="aks" />);
    expect(await screen.findByText("Loading details…")).toBeTruthy();
  });

  it("error shows detail and retry", async () => {
    const detail = "Pod payments/payments-api-1 no longer exists. It may have been deleted or replaced.";
    const fetch = vi.fn()
      .mockImplementationOnce(() => json({ detail }, 404))
      .mockImplementation(() => json(describeBody()));
    vi.stubGlobal("fetch", fetch);
    wrap(<Inspector row={row()} provider="aks" />);
    expect(await screen.findByText(detail)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("aks-np1-03");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("yaml tab shows the manifest with line numbers", async () => {
    const fetch = vi.fn((url: string) =>
      url.endsWith("/yaml") ? json({ yaml: "apiVersion: v1\nkind: Pod\n" }) : json(describeBody()),
    );
    vi.stubGlobal("fetch", fetch);
    wrap(<Inspector row={row()} provider="aks" />);
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    const pre = await screen.findByTestId("yaml");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toContain("kind: Pod");
    expect(within(pre).getByText("2")).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => u === "/api/clusters/c1/pods/payments/payments-api-1/yaml")).toBe(true);
  });

  it("events tab shows the events table", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(describeBody({ events_error: "Couldn't list events: forbidden" }))));
    wrap(<Inspector row={row()} provider="aks" />);
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(await screen.findByText("Couldn't list events: forbidden")).toBeTruthy();
  });

  it("logs and shell buttons call their props", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(describeBody())));
    const onOpenLogs = vi.fn();
    const onOpenShell = vi.fn();
    wrap(<Inspector row={row()} provider="aks" onOpenLogs={onOpenLogs} onOpenShell={onOpenShell} />);
    fireEvent.click(screen.getByRole("button", { name: /Logs/ }));
    fireEvent.click(screen.getByRole("button", { name: /Shell/ }));
    expect(onOpenLogs).toHaveBeenCalledWith(row());
    expect(onOpenShell).toHaveBeenCalledWith(row());
  });
});

describe("metrics tab", () => {
  const MIB = 1024 ** 2;
  const metricsBody = (over: Record<string, unknown> = {}) => ({
    state: "ok", message: null, at: new Date(Date.now() - 20_000).toISOString(), window_s: 15, stale: false,
    containers: [
      { name: "payments-api", cpu_m: 110, memory_b: 301 * MIB, cpu_request_m: 100, cpu_limit_m: 500, memory_request_b: 128 * MIB, memory_limit_b: 256 * MIB },
      { name: "sidecar", cpu_m: 5, memory_b: 20 * MIB, cpu_request_m: null, cpu_limit_m: null, memory_request_b: null, memory_limit_b: null },
    ],
    ...over,
  });
  const answer = (metrics: () => Promise<Response>) =>
    vi.fn((url: string) => (url.endsWith("/metrics") ? metrics() : json(describeBody())));

  it("metrics tab lists containers", async () => {
    const fetch = answer(() => json(metricsBody()));
    vi.stubGlobal("fetch", fetch);
    wrap(<Inspector row={row()} provider="aks" />);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    await screen.findByText("sidecar");
    expect(screen.getByText("payments-api")).toBeTruthy();
    expect(screen.getByText("301 / 256 Mi")).toBeTruthy();
    expect(screen.getByLabelText("near its limit")).toBeTruthy();
    expect(screen.getByText("request 100m · limit 500m")).toBeTruthy();
    expect(screen.getAllByText("no request or limit").length).toBe(2);
    expect(screen.getByText(/Measured (19|20|21)s ago over 15 s/)).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => u === "/api/clusters/c1/pods/payments/payments-api-1/metrics")).toBe(true);
  });

  it("shows the server's words when there are no metrics", async () => {
    const message = "No metrics yet: metrics-server hasn't measured payments-api-1. Check again in a minute.";
    vi.stubGlobal("fetch", answer(() => json(metricsBody({ state: "unavailable", message, containers: [] }))));
    wrap(<Inspector row={row()} provider="aks" />);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("a failed request hides the numbers with the out-of-date copy", async () => {
    vi.stubGlobal("fetch", answer(() => json({ detail: "Bad gateway" }, 502)));
    wrap(<Inspector row={row()} provider="aks" />);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(await screen.findByText(/Metrics are out of date, so they're hidden: Bad gateway/)).toBeTruthy();
    expect(screen.queryByText("sidecar")).toBeNull();
  });

  it("a stale measurement says so", async () => {
    vi.stubGlobal("fetch", answer(() => json(metricsBody({ stale: true }))));
    wrap(<Inspector row={row()} provider="aks" />);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    await screen.findByText("sidecar");
    expect(document.querySelector('[title^="Measured "][title$="; metrics-server has nothing newer."]')).toBeTruthy();
  });
});

describe("metrics tab expiry", () => {
  const ok = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));
  const metrics = () => ({
    state: "ok", message: null, at: new Date().toISOString(), window_s: 15, stale: false,
    containers: [{ name: "payments-api", cpu_m: 110, memory_b: 1024 ** 2, cpu_request_m: null, cpu_limit_m: null, memory_request_b: null, memory_limit_b: null }],
  });
  const answerWith = (fn: () => Promise<Response>) => vi.fn((url: string) => (url.endsWith("/metrics") ? fn() : ok(describeBody())));
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  afterEach(() => vi.useRealTimers());

  it("numbers are hidden 45 s after the last answer, not at the next tick", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", answerWith(vi.fn().mockImplementationOnce(() => ok(metrics())).mockImplementation(() => new Promise(() => {}))));
    wrap(<Inspector row={row()} provider="aks" />);
    await advance(0);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    await advance(0);
    expect(screen.getByText("payments-api")).toBeTruthy();
    await advance(44_000);
    expect(screen.getByText("payments-api")).toBeTruthy();
    await advance(1_200);
    expect(screen.queryByText("payments-api")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/^Metrics are out of date, so they're hidden: /);
  });

  it("a failed poll after a good one hides the numbers, a recovered one shows them", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", answerWith(vi.fn()
      .mockImplementationOnce(() => ok(metrics()))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ detail: "Bad gateway" }), { status: 502 })))
      .mockImplementation(() => ok(metrics()))));
    wrap(<Inspector row={row()} provider="aks" />);
    await advance(0);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    await advance(0);
    expect(screen.getByText("payments-api")).toBeTruthy();
    await advance(15_100);
    expect(screen.queryByText("payments-api")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Metrics are out of date, so they're hidden: Bad gateway");
    await advance(15_100);
    expect(screen.getByText("payments-api")).toBeTruthy();
  });

  it("reopening the tab with old cached numbers shows loading, not an alert", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(["pod-metrics", "c1", "payments", "payments-api-1"], metrics(), { updatedAt: Date.now() - 120_000 });
    vi.stubGlobal("fetch", answerWith(() => new Promise(() => {})));
    render(<QueryClientProvider client={client}><Inspector row={row()} provider="aks" /></QueryClientProvider>);
    await advance(0);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    await advance(0);
    expect(screen.getByText("Loading metrics…")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("payments-api")).toBeNull();
  });
});
