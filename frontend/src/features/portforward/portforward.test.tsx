// frontend/src/features/portforward/portforward.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Cluster, ForwardOut, ResourceRow } from "../../api/types";
import { container, describeBody, resourceDescribe } from "../../test/describe";
import { ActionsProvider } from "../actions/ActionDialog";
import { Inspector } from "../inspector/Inspector";
import { ForwardsMenu } from "./ForwardsMenu";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

const CLUSTER: Cluster = {
  id: "c1", name: "prod-gke", context_name: "x", server: "https://x", original_server: null,
  provider: "gke", region: null, environment: "production", state: "ready", message: null,
};

const FORWARD: ForwardOut = {
  id: "f1", cluster_id: "c1", cluster_name: "prod-gke", provider: "gke", namespace: "payments", kind: "pod",
  name: "payments-api-1", remote_port: 8080, local_port: 30001, address: "127.0.0.1:30001", pod: null,
  state: "listening", message: null, connections: 0, started_at: "2026-11-07T10:00:00Z",
};

const row: ResourceRow = {
  uid: "u1", cluster_id: "c1", kind: "Pod", namespace: "payments", name: "payments-api-1", created_at: null,
  labels: {}, columns: { status: "Running", status_class: "ok", resource_version: "1" },
};

type Call = { url: string; method: string; body: unknown };

function serve(handler: (call: Call) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const call = {
      url, method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    calls.push(call);
    if (call.url === "/api/clusters") return json([CLUSTER]);
    const out = handler(call);
    if (out === undefined) return json({ detail: `no route for ${call.method} ${call.url}` }, 500);
    if (out.status === 204) return Promise.resolve(new Response(null, { status: 204 }));
    return json(out.body, out.status ?? 200);
  }));
  return calls;
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const DESCRIBE_URL = "/api/clusters/c1/pods/payments/payments-api-1/describe";
const podDescribe = () => describeBody({ containers: [container({ ports: ["8080/TCP", "9090/TCP"] })] });

async function openDialog() {
  wrap(<ActionsProvider><Inspector row={row} provider="gke" kindKey="pods" verbs={[]} /></ActionsProvider>);
  fireEvent.click(await screen.findByRole("button", { name: /Port-forward/ }));
  return await screen.findByRole("dialog", { name: /Port-forward/ });
}

describe("port-forward dialog", () => {
  it("start forward from a pod port shows localhost address", async () => {
    const calls = serve((c) => {
      if (c.url === DESCRIBE_URL) return { body: podDescribe() };
      if (c.method === "POST" && c.url === "/api/port-forwards") return { body: FORWARD };
      if (c.url === "/api/port-forwards") return { body: [FORWARD] };
      if (c.url.startsWith("/api/audit")) return { body: { records: [], next_before: null } };
    });
    const dialog = await openDialog();
    // The cluster is named and the path says where the forward goes.
    expect(await within(dialog).findByText("prod-gke / payments / payments-api-1")).toBeTruthy();
    expect(within(dialog).getByText("GKE")).toBeTruthy();
    // The container ports of the describe are the choices; the second one is picked.
    const second = await within(dialog).findByRole("radio", { name: /9090/ });
    fireEvent.click(second);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start forwarding" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ cluster_id: "c1", namespace: "payments", kind: "pod", name: "payments-api-1", port: 9090 });
    expect(await screen.findByText(/localhost:30001/)).toBeTruthy();
  });

  it("a free port number can be typed", async () => {
    const calls = serve((c) => {
      if (c.url === DESCRIBE_URL) return { body: podDescribe() };
      if (c.method === "POST") return { body: FORWARD };
      return { body: [] };
    });
    const dialog = await openDialog();
    fireEvent.change(await within(dialog).findByLabelText("Another port"), { target: { value: "5432" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start forwarding" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ port: 5432 });
  });

  it("port exhaustion message shown", async () => {
    const message = "All 20 port-forward ports (30000–30019) are in use. Stop one first.";
    serve((c) => {
      if (c.url === DESCRIBE_URL) return { body: podDescribe() };
      if (c.method === "POST") return { status: 409, body: { detail: message } };
      return { body: [] };
    });
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Start forwarding" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(message);
    // It stays open, so the port can be changed or the dialog cancelled.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("port-forward tool", () => {
  it("f on the details opens the dialog", async () => {
    serve((c) => (c.url === DESCRIBE_URL ? { body: podDescribe() } : { body: [] }));
    wrap(<ActionsProvider><Inspector row={row} provider="gke" kindKey="pods" verbs={[]} /></ActionsProvider>);
    const section = await screen.findByRole("region", { name: /Details for payments-api-1/ });
    fireEvent.keyDown(section, { key: "f" });
    expect(await screen.findByRole("dialog", { name: /Port-forward/ })).toBeTruthy();
  });

  it("a service offers its own ports and starts a service forward", async () => {
    const svc: ResourceRow = { ...row, kind: "Service", name: "web", columns: { resource_version: "3" } };
    const calls = serve((c) => {
      if (c.url.includes("/resources/services/web/describe")) {
        return {
          body: resourceDescribe({
            kind_key: "services", kind: "Service", name: "web", namespace: "payments",
            sections: [{
              title: "Ports", columns: ["Name", "Port", "Target port", "Node port", "Protocol"], note: null,
              rows: [[{ text: "http", link: null, cls: null }, { text: "80", link: null, cls: null }, { text: "8080", link: null, cls: null },
                { text: null, link: null, cls: null }, { text: "TCP", link: null, cls: null }]],
            }],
          }),
        };
      }
      if (c.method === "POST") return { body: { ...FORWARD, kind: "service", name: "web", remote_port: 80 } };
      return { body: [] };
    });
    wrap(<ActionsProvider><Inspector row={svc} provider="gke" kindKey="services" verbs={[]} /></ActionsProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Port-forward/ }));
    const dialog = await screen.findByRole("dialog", { name: /Port-forward service web/ });
    expect(await within(dialog).findByRole("radio", { name: /80\/TCP/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start forwarding" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ cluster_id: "c1", namespace: "payments", kind: "service", name: "web", port: 80 });
  });
});

describe("forwards menu", () => {
  it("forwards menu lists cluster identity and stops", async () => {
    let listed: ForwardOut[] = [FORWARD];
    const calls = serve((c) => {
      if (c.method === "DELETE" && c.url === "/api/port-forwards/f1") {
        listed = [];
        return { status: 204 };
      }
      if (c.url === "/api/port-forwards") return { body: listed };
    });
    wrap(<ForwardsMenu />);
    fireEvent.click(await screen.findByRole("button", { name: "1 port-forward" }));
    const panel = await screen.findByRole("group", { name: "Port-forwards" });
    expect(within(panel).getByText("GKE")).toBeTruthy();
    expect(within(panel).getByText("prod-gke / payments / payments-api-1")).toBeTruthy();
    expect(within(panel).getByText("localhost:30001 → 8080")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(within(panel).getByText("Listening")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /port-forward/ })).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("an error forward says why in the server's words", async () => {
    const failed = { ...FORWARD, state: "error" as const, message: "Pod payments-api-1 is gone; stop this forward and start a new one." };
    serve((c) => (c.url === "/api/port-forwards" ? { body: [failed] } : undefined));
    wrap(<ForwardsMenu />);
    fireEvent.click(await screen.findByRole("button", { name: "1 port-forward" }));
    expect((await screen.findByRole("group", { name: "Port-forwards" })).textContent).toContain(failed.message);
  });

  it("a failed poll stops claiming the forwards are listening", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let down = false;
      serve((c) => {
        if (c.url !== "/api/port-forwards") return undefined;
        return down ? { status: 503, body: { detail: "The console is stopping." } } : { body: [FORWARD] };
      });
      wrap(<ForwardsMenu />);
      const trigger = await screen.findByRole("button", { name: /1 port-forward/ });
      expect(trigger.querySelector("[data-pulse]")).not.toBeNull();
      down = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      await waitFor(() => expect(screen.getByRole("button", { name: /1 port-forward/ }).textContent).toContain("Not confirmed"));
      expect(screen.getByRole("button", { name: /1 port-forward/ }).querySelector("[data-pulse]")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /1 port-forward/ }));
      const panel = await screen.findByRole("group", { name: "Port-forwards" });
      expect(within(panel).queryByText("Listening")).toBeNull();
      expect(within(panel).getByText("Status unknown")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is absent while no forward exists", async () => {
    const calls = serve((c) => (c.url === "/api/port-forwards" ? { body: [] } : undefined));
    wrap(<ForwardsMenu />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
