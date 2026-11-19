import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CloudAccount, Discovered } from "../../api/types";
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { KINDS } from "../../test/kinds";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { Shell } from "../shell/Shell";
import { defaultWorkspace, HOME, kindView } from "../shell/workspace";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const now = "2026-11-13T06:00:00Z";
const old = "2026-11-13T04:00:00Z";
const account: CloudAccount = {
  id: "subscription", name: "Azure engineering", provider: "azure", kube_provider: "aks", source: "entered",
  scope: "example", principal: "principal", regions: ["westeurope"], profile: null, has_secret: true,
  check: { state: "ok", checked_at: now, message: null, problems: [] },
  counts: { found: 0, added: 0, new: 0 },
};

const row = (id: string, name: string, changes: Partial<Discovered> = {}): Discovered => ({
  id, account_id: account.id, account_name: account.name, provider: "aks", name, region: "westeurope",
  kubernetes_version: "1.33", node_pools: [{ name: "pool", count: 1, machine_type: null, version: null }],
  node_count: 1, environment: "development", private: false, why_not: null, state: "new",
  cluster_id: null, first_seen: old, last_seen: now, missing_since: null, ...changes,
});

const registered = {
  ...FILE_CLUSTER_METADATA, id: "registered", name: "OmniKrux cluster", context_name: "ctx", provider: "kind",
  server: "https://kube.test", original_server: null, region: null, environment: "development", state: "ready", message: null,
};

function serve(rows: () => Discovered[], check: CloudAccount["check"] = account.check, write?: (url: string, ids: string[]) => Response | Promise<Response>) {
  const requests: { url: string; ids: string[] }[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && write) {
      const { ids } = JSON.parse(init.body as string) as { ids: string[] };
      requests.push({ url, ids });
      return write(url, ids);
    }
    if (url === "/api/cloud/accounts") return json([{
      ...account, check, counts: { found: rows().length, added: rows().filter(r => r.state === "added").length,
        new: rows().filter(r => r.state === "new").length },
    }]);
    if (url === "/api/cloud/discovered") return json(rows());
    if (url === "/api/clusters") return json([registered]);
    if (url.startsWith("/api/kinds")) return json(KINDS);
    if (url === "/api/metrics/pods") return json({ clusters: {} });
    if (url === "/api/port-forwards") return json([]);
    throw new Error(`Unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  return requests;
}

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("adds exactly the checked IDs and retains only the selection that failed", async () => {
  let rows = [row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma")];
  let finish!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { finish = resolve; });
  const writes = serve(() => rows, account.check, () => response);
  renderShell();
  const user = userEvent.setup();
  const group = await screen.findByRole("region", { name: "Clusters in Azure engineering" });
  await user.click(within(group).getByRole("checkbox", { name: "Alpha" }));
  await user.click(within(group).getByRole("checkbox", { name: "Gamma" }));
  await user.click(screen.getByRole("button", { name: "Add 2 clusters" }));
  expect(screen.getByRole("button", { name: "Adding…" })).toBeTruthy();
  expect(writes).toEqual([{ url: "/api/cloud/discovered/add", ids: ["a", "c"] }]);

  rows = rows.map(r => r.id === "a" ? { ...r, state: "added", cluster_id: registered.id } : r);
  await act(async () => finish(new Response(JSON.stringify({
    added: [registered], failed: [{ id: "c", message: "Check this cluster's permissions." }],
  }))));
  expect(await screen.findByText(/Gamma.*Check this cluster's permissions/)).toBeTruthy();
  expect(await within(group).findByText("In OmniKrux")).toBeTruthy();
  expect(within(group).queryByRole("checkbox", { name: "Alpha" })).toBeNull();
  expect(within(group).getByRole<HTMLInputElement>("checkbox", { name: "Gamma" }).checked).toBe(true);
  expect(within(group).getByRole<HTMLInputElement>("checkbox", { name: "Beta" }).checked).toBe(false);
  expect(screen.getByRole("button", { name: "Add 1 cluster" })).toBeTruthy();
});

it("shows why private and local-account clusters can't be checked", async () => {
  serve(() => [
    row("a", "Public"),
    row("b", "Private", { private: true, why_not: "Private API endpoint. Connect through the in-cluster agent." }),
    row("c", "Local", { why_not: "This cluster uses local accounts. Turn on Entra ID integration." }),
  ]);
  renderShell();
  const group = within(await screen.findByRole("region", { name: "Clusters in Azure engineering" }));
  expect(group.getAllByRole("checkbox")).toEqual([group.getByRole("checkbox", { name: "Public" })]);
  expect(group.getByText(/Can't add: Private API endpoint/)).toBeTruthy();
  expect(group.getByText(/Can't add: This cluster uses local accounts/)).toBeTruthy();
  expect(group.getAllByText("1 node pool · 1 node")).toHaveLength(3);
});

it("shows the failed check time and dates the last observed clusters separately", async () => {
  serve(() => [row("a", "Alpha", { last_seen: old, missing_since: old, node_count: null })], {
    state: "error", checked_at: now, message: "Azure did not answer.", problems: [],
  });
  renderShell();
  expect(await screen.findByText(/The last check failed: Azure did not answer\. These clusters are from 2h ago\./)).toBeTruthy();
  expect(screen.getByText(/Last checked 0s ago/)).toBeTruthy();
  expect(screen.getByText("Not found at the last check")).toBeTruthy();
  expect(screen.getByText("1 node pool")).toBeTruthy();
});

it("shows partial regional problems and labels old rows by when they were last seen", async () => {
  serve(() => [row("a", "Old", { last_seen: old }), row("b", "Current")], {
    state: "ok", checked_at: now, message: null, problems: ["Couldn't list clusters in northeurope: permission denied."],
  });
  renderShell();
  expect(await screen.findByText("Couldn't list clusters in northeurope: permission denied.")).toBeTruthy();
  expect(screen.getByText("Last seen 2h ago")).toBeTruthy();
  expect(screen.queryByText("Not found at the last check")).toBeNull();
});

it("dismisses the checked discovery and clears the Pods notice on Back", async () => {
  let rows = [row("a", "Alpha")];
  const writes = serve(() => rows, account.check, () => {
    rows = rows.map(r => ({ ...r, state: "dismissed" }));
    return new Response(null, { status: 204 });
  });
  const workspace = defaultWorkspace();
  workspace.kubernetes.tabs[0].view = kindView(HOME, "pods");
  localStorage.setItem("omnikrux.workspace", JSON.stringify(workspace));
  renderShell();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "1 new cluster found" }));
  await user.click(await screen.findByRole("checkbox", { name: "Alpha" }));
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(writes).toEqual([{ url: "/api/cloud/discovered/dismiss", ids: ["a"] }]);
  expect(await screen.findByText("Dismissed")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("grid", { name: "Pods by cluster" });
  await waitFor(() => expect(screen.queryByRole("button", { name: /new cluster.*found/ })).toBeNull());
});

it("can add an eligible dismissed discovery again while blocked and missing rows stay unavailable", async () => {
  let rows = [
    row("a", "Restore me", { state: "dismissed" }),
    row("b", "Private", { state: "dismissed", private: true, why_not: "Private API endpoint." }),
    row("c", "Missing", { state: "dismissed", missing_since: old }),
    row("d", "New", {}),
  ];
  const writes = serve(() => rows, account.check, (url, ids) => {
    if (url.endsWith("/dismiss")) {
      rows = rows.map(r => ids.includes(r.id) ? { ...r, state: "dismissed" } : r);
      return new Response(null, { status: 204 });
    }
    rows = rows.map(r => ids.includes(r.id) ? { ...r, state: "added", cluster_id: registered.id } : r);
    return new Response(JSON.stringify({ added: [registered], failed: [] }));
  });
  renderShell();
  const user = userEvent.setup();
  const group = within(await screen.findByRole("region", { name: "Clusters in Azure engineering" }));
  const restored = group.getByRole<HTMLInputElement>("checkbox", { name: "Restore me" });
  expect(group.queryByRole("checkbox", { name: "Private" })).toBeNull();
  expect(group.queryByRole("checkbox", { name: "Missing" })).toBeNull();
  expect(group.getByText("Can't add: Private API endpoint.")).toBeTruthy();
  await user.click(restored);
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  await user.click(group.getByRole("checkbox", { name: "New" }));
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(writes).toEqual([{ url: "/api/cloud/discovered/dismiss", ids: ["d"] }]));
  expect(restored.checked).toBe(true);

  await user.click(await screen.findByRole("button", { name: "Add 1 cluster" }));
  expect(await group.findByText("In OmniKrux")).toBeTruthy();
  expect(writes.at(-1)).toEqual({ url: "/api/cloud/discovered/add", ids: ["a"] });
});
