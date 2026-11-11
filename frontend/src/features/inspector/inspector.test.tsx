// frontend/src/features/inspector/inspector.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Link, ResourceRow } from "../../api/types";
import { container, describeBody, resourceDescribe, secretDescribe } from "../../test/describe";
import { DescribeView } from "./DescribeView";
import { EventsTable } from "./EventsTable";
import { Inspector } from "./Inspector";
import { ResourceDescribeView } from "./ResourceDescribeView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

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
    client,
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
      { name: "DB_PASSWORD", value: null, source: "Secret payments-db key password", link: null },
      { name: "LOG_LEVEL", value: "info", source: null, link: null },
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

describe("pod describe links", () => {
  it("owner, node, service account, env sources and volumes are links", () => {
    const onLink = vi.fn<(l: Link) => void>();
    const secret: Link = { kind_key: "secrets", namespace: "payments", name: "payments-db" };
    const env = [{ name: "DB_PASSWORD", value: null, source: "Secret payments-db key password", link: secret }];
    const volumes = [
      { name: "config", type: "configMap", link: { kind_key: "configmaps", namespace: "payments", name: "payments-config" } },
      { name: "scratch", type: "emptyDir", link: null },
    ];
    render(<DescribeView data={describeBody({ containers: [container({ env })], volumes })} onLink={onLink} />);
    fireEvent.click(screen.getByRole("button", { name: "ReplicaSet payments-api-7f9c4" }));
    fireEvent.click(screen.getByRole("button", { name: "aks-np1-03" }));
    fireEvent.click(screen.getByRole("button", { name: "payments-api" }));
    fireEvent.click(screen.getByRole("button", { name: "Secret payments-db key password" }));
    fireEvent.click(screen.getByRole("button", { name: "payments-config" }));
    expect(onLink.mock.calls.map(([l]) => `${l.kind_key} ${l.namespace ?? "-"} ${l.name}`)).toEqual([
      "replicasets.apps payments payments-api-7f9c4",
      "nodes - aks-np1-03",
      "serviceaccounts payments payments-api",
      "secrets payments payments-db",
      "configmaps payments payments-config",
    ]);
    // A volume without anything to point at is listed by its type, as plain text.
    const scratch = screen.getByTestId("volume-scratch");
    expect(scratch.textContent).toContain("emptyDir");
    expect(within(scratch).queryByRole("button")).toBeNull();
  });
});

const deployRow: ResourceRow = {
  uid: "d-1", cluster_id: "c1", kind: "Deployment", namespace: "demo", name: "web", created_at: null, labels: {},
  columns: { status: "Progressing", status_class: "warn", ready: "1/2" },
};
const secretRow: ResourceRow = {
  uid: "s-1", cluster_id: "c1", kind: "Secret", namespace: "payments", name: "payments-db", created_at: null, labels: {},
  columns: { type: "Opaque", keys: 2, resource_version: "7" },
};
const nodeRow: ResourceRow = {
  uid: "n-1", cluster_id: "c1", kind: "Node", namespace: null, name: "aks-np1-03", created_at: null, labels: {},
  columns: { status: "Ready", status_class: "ok" },
};

const deployment = resourceDescribe({
  fields: [
    { label: "Controlled by", value: null, link: null },
    { label: "Replicas", value: "2 desired, 2 updated, 1 ready, 1 available", link: null },
    { label: "Strategy", value: "RollingUpdate (max surge 25%, max unavailable 25%)", link: null },
  ],
  sections: [
    {
      title: "Replica sets",
      columns: ["Name", "Revision", "Ready", "Created"],
      rows: [[
        { text: "web-5d8f", link: { kind_key: "replicasets.apps", namespace: "demo", name: "web-5d8f" }, cls: null },
        { text: "3", link: null, cls: null },
        { text: "1/2", link: null, cls: null },
        { text: null, link: null, cls: null },
      ]],
      note: null,
    },
    {
      title: "Pods",
      columns: ["Name", "Status", "Ready", "Restarts", "Node"],
      rows: [[
        { text: "web-5d8f-a", link: { kind_key: "pods", namespace: "demo", name: "web-5d8f-a" }, cls: null },
        { text: "CrashLoopBackOff", link: null, cls: "bad" },
        { text: "0/1", link: null, cls: null },
        { text: "4", link: null, cls: null },
        { text: "worker", link: { kind_key: "nodes", namespace: null, name: "worker" }, cls: null },
      ]],
      note: null,
    },
    { title: "Spec and status", columns: [], rows: [], note: "The YAML tab shows the full object." },
  ],
  conditions: [{ type: "Available", status: "False", reason: "MinimumReplicasUnavailable", message: null }],
  labels: { app: "web" },
  events: [{ type: "Normal", reason: "ScalingReplicaSet", message: "Scaled up replica set web-5d8f to 2", count: 1, last_seen: null }],
});

describe("resource inspector", () => {
  it("shows clear, active, and unknown Node pressure conditions", () => {
    const { rerender } = render(<ResourceDescribeView clusterId="c1" data={resourceDescribe({
      kind_key: "nodes", kind: "Node", namespace: null,
      conditions: [
        { type: "Ready", status: "True", reason: null, message: null },
        { type: "MemoryPressure", status: "False", reason: "KubeletHasSufficientMemory", message: "sufficient memory available" },
        { type: "DiskPressure", status: "True", reason: null, message: null },
        { type: "PIDPressure", status: "Unknown", reason: null, message: null },
        { type: "NetworkUnavailable", status: "False", reason: null, message: null },
      ],
    })} />);

    function expectCondition(label: string, status: string, tone: string, mark: string, state?: string) {
      const condition = state
        ? screen.getByRole("listitem", { name: `${label}: ${state}` })
        : screen.getByText(label).closest("li")!;
      expect(condition.getAttribute("data-status")).toBe(status);
      expect(condition.getAttribute("data-tone")).toBe(tone);
      expect(within(condition).getByText(mark).getAttribute("aria-hidden")).toBe("true");
      return condition;
    }

    const memory = expectCondition("Memory pressure", "False", "ok", "✓", "clear");
    expectCondition("Ready", "True", "ok", "✓");
    expect(memory.title).toContain("MemoryPressure: False");
    expect(memory.title).toContain("KubeletHasSufficientMemory: sufficient memory available");
    expectCondition("Disk pressure", "True", "bad", "✕", "active");
    expectCondition("PID pressure", "Unknown", "warn", "?", "unknown");
    expectCondition("Network unavailable", "False", "ok", "✓", "clear");

    const clearPressure = ["DiskPressure", "PIDPressure"].map((type) => ({
      type, status: "False", reason: null, message: null,
    }));
    rerender(<ResourceDescribeView clusterId="c1" data={resourceDescribe({
      kind_key: "nodes", kind: "Node", namespace: null,
      conditions: [{ type: "Ready", status: "False", reason: null, message: null }, ...clearPressure],
    })} />);
    expectCondition("Ready", "False", "bad", "✕");
    expectCondition("Disk pressure", "False", "ok", "✓", "clear");
    expectCondition("PID pressure", "False", "ok", "✓", "clear");

    rerender(<ResourceDescribeView clusterId="c1" data={resourceDescribe({ conditions: clearPressure })} />);
    expectCondition("Disk pressure", "False", "bad", "✕");
    expect(screen.queryByRole("listitem", { name: "Disk pressure: clear" })).toBeNull();
  });

  it("deployment describe renders sections", async () => {
    const fetch = vi.fn((_url: string) => json(deployment));
    vi.stubGlobal("fetch", fetch);
    wrap(<Inspector row={deployRow} provider="kind" kindKey="deployments.apps" />);
    expect(await screen.findByText("2 desired, 2 updated, 1 ready, 1 available")).toBeTruthy();
    expect(fetch.mock.calls[0][0]).toBe("/api/clusters/c1/resources/deployments.apps/web/describe?namespace=demo");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Describe", "YAML", "Events"]);
    // A field with nothing to say reads as a dash, never "null".
    expect(screen.queryByText("null")).toBeNull();
    const sets = screen.getByRole("table", { name: "Replica sets" });
    expect(within(sets).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Revision", "Ready", "Created"]);
    expect(within(sets).getByRole("button", { name: "web-5d8f" })).toBeTruthy();
    const pods = screen.getByRole("table", { name: "Pods" });
    expect(within(pods).getByText("CrashLoopBackOff")).toBeTruthy();
    expect(pods.querySelector('[data-shape="diamond"]')).toBeTruthy();
    expect(within(pods).getByRole("button", { name: "worker" })).toBeTruthy();
    expect(screen.getByText("The YAML tab shows the full object.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Conditions" })).getByText("Available").getAttribute("data-status")).toBe("False");
    expect(screen.getByText("app=web")).toBeTruthy();
    expect(screen.getByText("Scaled up replica set web-5d8f to 2")).toBeTruthy();
    // No logs or shell for a deployment (those tools arrive with Tasks 13 and 15).
    expect(screen.queryByRole("button", { name: /Logs/ })).toBeNull();
  });

  it("section links call the navigation", () => {
    const onLink = vi.fn<(l: Link) => void>();
    render(<ResourceDescribeView data={deployment} clusterId="c1" onLink={onLink} />);
    fireEvent.click(screen.getByRole("button", { name: "web-5d8f-a" }));
    expect(onLink).toHaveBeenCalledWith({ kind_key: "pods", namespace: "demo", name: "web-5d8f-a" });
  });

  it("the yaml tab reads the kind's yaml and copies it", async () => {
    const yaml = "apiVersion: apps/v1\nkind: Deployment\n";
    const fetch = vi.fn((url: string) => (url.includes("/yaml") ? json({ yaml }) : json(deployment)));
    vi.stubGlobal("fetch", fetch);
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    wrap(<Inspector row={deployRow} provider="kind" kindKey="deployments.apps" />);
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect((await screen.findByTestId("yaml")).textContent).toContain("kind: Deployment");
    expect(fetch.mock.calls.some(([u]) => u === "/api/clusters/c1/resources/deployments.apps/web/yaml?namespace=demo")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(yaml);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("a cluster-scoped kind is asked for without a namespace, and a node has a metrics tab", async () => {
    const MIB = 1024 ** 2;
    const metrics = {
      state: "ok", message: null, at: new Date(Date.now() - 10_000).toISOString(), window_s: 20, stale: false,
      cpu_m: 950, memory_b: 3000 * MIB, allocatable_cpu_m: 1900, allocatable_memory_b: 6000 * MIB,
      capacity_cpu_m: 2000, capacity_memory_b: 8000 * MIB,
    };
    const fetch = vi.fn((url: string) =>
      url.endsWith("/metrics") ? json(metrics) : json(resourceDescribe({ kind_key: "nodes", kind: "Node", name: "aks-np1-03", namespace: null })));
    vi.stubGlobal("fetch", fetch);
    wrap(<Inspector row={nodeRow} provider="aks" kindKey="nodes" />);
    await waitFor(() => expect(fetch.mock.calls[0]?.[0]).toBe("/api/clusters/c1/resources/nodes/aks-np1-03/describe"));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Describe", "YAML", "Events", "Metrics"]);
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(await screen.findByText("950m")).toBeTruthy();
    expect(screen.getByText("allocatable 1900m · capacity 2000m")).toBeTruthy();
    expect(fetch.mock.calls.some(([u]) => u === "/api/clusters/c1/nodes/aks-np1-03/metrics")).toBe(true);
  });
});

describe("secret values", () => {
  const VALUE = "hunter2-correct-horse";
  const USERNAME = "private-user-42";
  const values: Record<string, string> = { password: VALUE, username: USERNAME };
  const bothKeys = () => vi.fn((url: string, init?: RequestInit) => {
    if (!url.endsWith("/reveal")) return json(secretDescribe());
    const { key } = JSON.parse(String(init?.body)) as { key: string };
    return json({ key, value: values[key], encoding: "utf-8" });
  });
  const clickReveal = (key: string) => fireEvent.click(within(screen.getByTestId(`secret-key-${key}`)).getByRole("button", { name: "Reveal" }));
  const revealBoth = async () => {
    await screen.findByTestId("secret-key-password");
    clickReveal("password");
    await screen.findByText(VALUE);
    clickReveal("username");
    await screen.findByText(USERNAME);
  };

  it("revealing a second key keeps the first", async () => {
    vi.stubGlobal("fetch", bothKeys());
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await revealBoth();
    expect(screen.getByText(VALUE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide all" })).toBeTruthy();
  });

  it("hide hides only that key", async () => {
    vi.stubGlobal("fetch", bothKeys());
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await revealBoth();
    fireEvent.click(within(screen.getByTestId("secret-key-username")).getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(USERNAME)).toBeNull();
    expect(screen.getByText(VALUE)).toBeTruthy();
    expect(screen.getByTestId("secret-key-username").textContent).toContain("•••••• (5 bytes)");
  });

  it("reveals different keys independently while both requests are on their way", async () => {
    const pending = new Map<string, { signal: AbortSignal; finish: (response: Response) => void }>();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (!url.endsWith("/reveal")) return json(secretDescribe());
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      return new Promise<Response>((finish) => pending.set(key, { signal: init!.signal!, finish }));
    }));
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await screen.findByTestId("secret-key-password");
    clickReveal("password");
    clickReveal("username");
    expect(screen.getAllByRole("button", { name: "Revealing…" })).toHaveLength(2);
    expect(pending.get("password")!.signal.aborted).toBe(false);
    await act(async () => { pending.get("username")!.finish(await json({ key: "username", value: USERNAME, encoding: "utf-8" })); });
    expect(screen.getByText(USERNAME)).toBeTruthy();
    expect((within(screen.getByTestId("secret-key-password")).getByRole("button", { name: "Revealing…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending.get("password")!.finish(await json({ key: "password", value: VALUE, encoding: "utf-8" })); });
    expect(screen.getByText(VALUE)).toBeTruthy();
    expect(screen.getByText(USERNAME)).toBeTruthy();
  });

  it("hide all hides every key", async () => {
    vi.stubGlobal("fetch", bothKeys());
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await revealBoth();
    fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
    expect(screen.queryByText(VALUE)).toBeNull();
    expect(screen.queryByText(USERNAME)).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide all" })).toBeNull();
  });

  it("a hidden browser tab hides every value", async () => {
    vi.stubGlobal("fetch", bothKeys());
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await revealBoth();
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(screen.queryByText(VALUE)).toBeNull();
      expect(screen.queryByText(USERNAME)).toBeNull();
    } finally {
      hidden.mockRestore();
    }
  });

  it("a new resource version drops every value", async () => {
    vi.stubGlobal("fetch", bothKeys());
    const { rerender } = wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await revealBoth();
    rerender(<Inspector row={{ ...secretRow, columns: { ...secretRow.columns, resource_version: "8" } }} provider="kind" kindKey="secrets" />);
    expect(screen.queryByText(VALUE)).toBeNull();
    expect(screen.queryByText(USERNAME)).toBeNull();
    await screen.findByTestId("secret-key-password");
    expect(screen.queryByText(VALUE)).toBeNull();
    expect(screen.queryByText(USERNAME)).toBeNull();
  });

  it("an error on one key keeps the others", async () => {
    vi.stubGlobal("fetch", answer());
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await screen.findByTestId("secret-key-password");
    clickReveal("password");
    await screen.findByText(VALUE);
    clickReveal("username");
    await screen.findByRole("alert");
    expect(screen.getByText(VALUE)).toBeTruthy();
  });

  it("values never reach the query cache or storage", async () => {
    const fetch = bothKeys();
    vi.stubGlobal("fetch", fetch);
    const { client } = wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await revealBoth();
    const retained = [
      JSON.stringify(client.getQueryCache().getAll().map((q) => [q.queryKey, q.state])),
      JSON.stringify(client.getMutationCache().getAll()),
      window.location.href,
      JSON.stringify(window.history.state),
      ...[window.localStorage, window.sessionStorage].flatMap((store) =>
        Array.from({ length: store.length }, (_, i) => store.getItem(store.key(i)!) ?? "")),
    ];
    for (const entry of retained) {
      expect(entry).not.toContain(VALUE);
      expect(entry).not.toContain(USERNAME);
    }
    for (const [url, init] of fetch.mock.calls.filter(([url]) => url.endsWith("/reveal"))) {
      expect(url).not.toContain(VALUE);
      expect(init).toMatchObject({ method: "POST", cache: "no-store" });
    }
  });

  it.each(["hide all", "hidden tab", "new version", "unmount"])("%s stops reveals on their way even when abort races response decoding", async (action) => {
    let finish!: (value: unknown) => void;
    let pendingSignal: AbortSignal | null | undefined;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (!url.endsWith("/reveal")) return json(secretDescribe());
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      if (key === "password") return json({ key, value: VALUE, encoding: "utf-8" });
      pendingSignal = init?.signal;
      // Deliberately ignore abort: the network has answered, JSON decoding is still on its way.
      return Promise.resolve({ ok: true, json: () => new Promise((resolve) => { finish = resolve; }) } as Response);
    });
    vi.stubGlobal("fetch", fetch);
    const { rerender, unmount, client } = wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await screen.findByTestId("secret-key-password");
    clickReveal("password");
    await screen.findByText(VALUE);
    clickReveal("username");
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    let hidden: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (action === "hide all") fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
      if (action === "hidden tab") {
        hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        act(() => document.dispatchEvent(new Event("visibilitychange")));
      }
      if (action === "new version") rerender(<Inspector row={{ ...secretRow, columns: { ...secretRow.columns, resource_version: "8" } }} provider="kind" kindKey="secrets" />);
      if (action === "unmount") unmount();
      expect(pendingSignal?.aborted).toBe(true);
      await act(async () => { finish({ key: "username", value: USERNAME, encoding: "utf-8" }); });
      expect(screen.queryByText(VALUE)).toBeNull();
      expect(screen.queryByText(USERNAME)).toBeNull();
      expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state))).not.toContain(USERNAME);
    } finally {
      hidden?.mockRestore();
    }
  });

  it("a held x does not repeat a reveal or hide another key", async () => {
    const fetch = bothKeys();
    vi.stubGlobal("fetch", fetch);
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await screen.findByTestId("secret-key-password");
    clickReveal("password");
    await screen.findByText(VALUE);
    const username = screen.getByTestId("secret-key-username");
    username.focus();
    fireEvent.keyDown(username, { key: "x", repeat: true });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/reveal"))).toHaveLength(1);
    fireEvent.keyDown(username, { key: "x" });
    await screen.findByText(USERNAME);
    expect(screen.getByText(VALUE)).toBeTruthy();
  });

  it("a cancelled response cannot replace a fresh reveal or clear its busy state", async () => {
    const finishes: ((value: unknown) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (!url.endsWith("/reveal")) return json(secretDescribe());
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      if (key === "password") return json({ key, value: VALUE, encoding: "utf-8" });
      return Promise.resolve({ ok: true, json: () => new Promise((resolve) => { finishes.push(resolve); }) } as Response);
    }));
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    await screen.findByTestId("secret-key-password");
    clickReveal("password");
    await screen.findByText(VALUE);
    clickReveal("username");
    await waitFor(() => expect(finishes).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
    clickReveal("username");
    await waitFor(() => expect(finishes).toHaveLength(2));
    await act(async () => { finishes[0]({ key: "username", value: "cancelled-secret-value", encoding: "utf-8" }); });
    expect(screen.queryByText("cancelled-secret-value")).toBeNull();
    expect(screen.queryByText(VALUE)).toBeNull();
    expect((within(screen.getByTestId("secret-key-username")).getByRole("button", { name: "Revealing…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finishes[1]({ key: "username", value: USERNAME, encoding: "utf-8" }); });
    expect(screen.getByText(USERNAME)).toBeTruthy();
    expect(screen.queryByText("cancelled-secret-value")).toBeNull();
  });
  /** Answers the describe, the YAML, and the reveal of `password` (any other key: the server's 404 words). */
  const answer = () =>
    vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/reveal")) {
        const { key } = JSON.parse(String(init?.body)) as { key: string };
        return key === "password"
          ? json({ key, value: VALUE, encoding: "utf-8" })
          : json({ detail: `Secret payments-db has no key ${key}.` }, 404);
      }
      if (url.includes("/yaml")) return json({ yaml: "data:\n  password: •••••• (12 bytes)\n" });
      return json(secretDescribe());
    });

  it("reveal shows one key and hides on close", async () => {
    const fetch = answer();
    vi.stubGlobal("fetch", fetch);
    const { unmount } = wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    const password = await screen.findByTestId("secret-key-password");
    const username = screen.getByTestId("secret-key-username");
    expect(password.textContent).toContain("•••••• (12 bytes)");
    expect(username.textContent).toContain("•••••• (5 bytes)");
    fireEvent.click(within(password).getByRole("button", { name: "Reveal" }));
    const value = await within(password).findByText(VALUE);
    expect(value.classList.contains("mono")).toBe(true);
    const [url, init] = fetch.mock.calls.find(([u]) => u.endsWith("/reveal"))!;
    expect(url).toBe("/api/clusters/c1/secrets/payments/payments-db/reveal");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ key: "password" });
    // Only the key asked for.
    expect(username.textContent).toContain("•••••• (5 bytes)");
    expect(screen.getAllByText(VALUE)).toHaveLength(1);

    fireEvent.click(within(password).getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(VALUE)).toBeNull();
    expect(password.textContent).toContain("•••••• (12 bytes)");

    // x on the focused key reveals it; another tab drops it.
    password.focus();
    fireEvent.keyDown(password, { key: "x" });
    await within(password).findByText(VALUE);
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    fireEvent.click(screen.getByRole("tab", { name: "Describe" }));
    expect(await screen.findByTestId("secret-key-password")).toBeTruthy();
    expect(screen.queryByText(VALUE)).toBeNull();

    // Closing the details drops it too.
    fireEvent.click(within(screen.getByTestId("secret-key-password")).getByRole("button", { name: "Reveal" }));
    await screen.findByText(VALUE);
    unmount();
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("a hidden browser tab drops the value, and a failed reveal says why", async () => {
    vi.stubGlobal("fetch", answer());
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    const password = await screen.findByTestId("secret-key-password");
    fireEvent.click(within(password).getByRole("button", { name: "Reveal" }));
    await within(password).findByText(VALUE);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.queryByText(VALUE)).toBeNull();
    hidden.mockRestore();

    fireEvent.click(within(screen.getByTestId("secret-key-username")).getByRole("button", { name: "Reveal" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reveal username: Secret payments-db has no key username.");
  });

  it("revealed values are not kept in the query cache", async () => {
    vi.stubGlobal("fetch", answer());
    const { client, unmount } = wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    const password = await screen.findByTestId("secret-key-password");
    fireEvent.click(within(password).getByRole("button", { name: "Reveal" }));
    await within(password).findByText(VALUE);
    const cached = client.getQueryCache().getAll().map((q) => JSON.stringify([q.queryKey, q.state]));
    expect(cached.length).toBeGreaterThan(0); // the describe is cached, the value is not
    for (const entry of cached) expect(entry).not.toContain(VALUE);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(window.location.href).not.toContain(VALUE);
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i++) expect(store.getItem(store.key(i)!) ?? "").not.toContain(VALUE);
    }
    unmount();
  });

  it("a new resource version drops the revealed value and reloads the describe", async () => {
    let version = "7";
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/reveal")) {
        const { key } = JSON.parse(String(init?.body)) as { key: string };
        return json({ key, value: VALUE, encoding: "utf-8" });
      }
      // The value changed; the key names and sizes did not.
      return json(secretDescribe({ resource_version: version }));
    });
    vi.stubGlobal("fetch", fetch);
    const describes = () => fetch.mock.calls.filter(([u]) => u.includes("/resources/secrets/payments-db/describe")).length;
    const { rerender } = wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    const password = await screen.findByTestId("secret-key-password");
    fireEvent.click(within(password).getByRole("button", { name: "Reveal" }));
    await within(password).findByText(VALUE);
    expect(describes()).toBe(1);

    version = "8";
    const changed = { ...secretRow, columns: { ...secretRow.columns, resource_version: "8" } };
    rerender(<Inspector row={changed} provider="kind" kindKey="secrets" />);
    // Gone at once, not when the new describe lands.
    expect(screen.queryByText(VALUE)).toBeNull();
    await waitFor(() => expect(describes()).toBe(2));
    expect((await screen.findByTestId("secret-key-password")).textContent).toContain("•••••• (12 bytes)");
    expect(screen.queryByText(VALUE)).toBeNull();
  });

  it("a row change drops the revealed value", async () => {
    vi.stubGlobal("fetch", answer());
    const { rerender } = wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    const password = await screen.findByTestId("secret-key-password");
    fireEvent.click(within(password).getByRole("button", { name: "Reveal" }));
    await within(password).findByText(VALUE);
    const other = { ...secretRow, uid: "s-2", name: "payments-api-token" };
    rerender(<Inspector row={other} provider="kind" kindKey="secrets" />);
    expect(screen.queryByText(VALUE)).toBeNull();
    // Nor is the other Secret's describe shown as this one's while it loads.
    expect(screen.getByText("Loading details…")).toBeTruthy();
  });

  it("helm releases list their keys but offer no reveal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(secretDescribe({ kind_key: "helm-releases", kind: "HelmRelease" }))));
    wrap(<Inspector row={{ ...secretRow, kind: "HelmRelease" }} provider="kind" kindKey="helm-releases" />);
    const password = await screen.findByTestId("secret-key-password");
    expect(password.textContent).toContain("•••••• (12 bytes)");
    expect(within(password).queryByRole("button", { name: "Reveal" })).toBeNull();
  });

  it("a helm release row asks for its Secret by the Secret's name and is titled by the release", async () => {
    const fetch = vi.fn((_u: string) => json(secretDescribe({ kind_key: "helm-releases", kind: "HelmRelease", name: "sh.helm.release.v1.web.v3" })));
    vi.stubGlobal("fetch", fetch);
    const helmRow: ResourceRow = {
      uid: "h-1", cluster_id: "c1", kind: "HelmRelease", namespace: "demo", name: "sh.helm.release.v1.web.v3", created_at: null,
      labels: { owner: "helm", name: "web" }, columns: { release: "web", revision: 3, status: "deployed", status_class: "ok", resource_version: "4" },
    };
    wrap(<Inspector row={helmRow} provider="kind" kindKey="helm-releases" />);
    expect(screen.getByRole("region", { name: "Details for web" })).toBeTruthy();
    await screen.findByTestId("secret-key-password");
    expect(fetch.mock.calls.map(([u]) => u)).toContain("/api/clusters/c1/resources/helm-releases/sh.helm.release.v1.web.v3/describe?namespace=demo");
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    await waitFor(() =>
      expect(fetch.mock.calls.map(([u]) => u)).toContain("/api/clusters/c1/resources/helm-releases/sh.helm.release.v1.web.v3/yaml?namespace=demo"),
    );
  });

  it("copy yaml copies masked secret", async () => {
    const fetch = answer();
    vi.stubGlobal("fetch", fetch);
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    wrap(<Inspector row={secretRow} provider="kind" kindKey="secrets" />);
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect((await screen.findByTestId("yaml")).textContent).toContain("password: •••••• (12 bytes)");
    expect(fetch.mock.calls.some(([u]) => u === "/api/clusters/c1/resources/secrets/payments-db/yaml?namespace=payments")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("data:\n  password: •••••• (12 bytes)\n");
    expect(fetch.mock.calls.some(([u]) => u.endsWith("/reveal"))).toBe(false);
  });
});
