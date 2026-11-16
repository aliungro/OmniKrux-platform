import { FILE_CLUSTER_METADATA } from "../../test/clusters";
// frontend/src/features/actions/actions.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Job, Plan, ResourceRow } from "../../api/types";
import { resourceDescribe } from "../../test/describe";
import { DEPLOYMENTS } from "../../test/kinds";
import { Table } from "../../test/table";
import { Inspector } from "../inspector/Inspector";
import { ActionDialog, ActionsProvider } from "./ActionDialog";
import { DrainProgress } from "./DrainProgress";
import { loadCodeMirror } from "./lazyCodeMirror";

// CodeMirror itself doesn't run in jsdom: a stand-in kit draws both sides of a diff as text and
// the editor as a textarea, and tells the tests when (and whether) it was loaded.
const kit = vi.hoisted(() => ({
  mergeView: (parent: HTMLElement, before: string, after: string) => {
    const a = document.createElement("pre");
    a.dataset.testid = "diff-before";
    a.textContent = before;
    const b = document.createElement("pre");
    b.dataset.testid = "diff-after";
    b.textContent = after;
    parent.append(a, b);
    return { destroy: () => parent.replaceChildren() };
  },
  editor: (parent: HTMLElement, doc: string, onChange: (text: string) => void, label: string) => {
    const area = document.createElement("textarea");
    area.value = doc;
    area.setAttribute("aria-label", label);
    area.addEventListener("input", () => onChange(area.value));
    parent.append(area);
    return { focus: () => area.focus(), destroy: () => area.remove() };
  },
}));
vi.mock("./lazyCodeMirror", () => ({ loadCodeMirror: vi.fn(() => Promise.resolve(kit)) }));

beforeEach(() => vi.mocked(loadCodeMirror).mockClear());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

type Call = { url: string; method: string; body: unknown };

/** A fake server: `routes` maps "METHOD path" (query included) to answers, used in order. */
function serve(routes: Record<string, unknown[] | ((body: unknown) => unknown)>) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(init.body as string);
    calls.push({ url, method, body });
    const route = routes[`${method} ${url}`];
    if (route === undefined) return json({ detail: `no route for ${method} ${url}` }, 500);
    if (typeof route === "function") {
      const out = route(body) as { status?: number; body: unknown };
      return json(out.body, out.status ?? 200);
    }
    const next = route.length > 1 ? route.shift() : route[0];
    const { status, body: answer } = next as { status?: number; body: unknown };
    return json(answer, status ?? 200);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}
const ok = (body: unknown) => ({ body });

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...out,
    client,
    rerender: (next: ReactNode) => out.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}

const plan = (over: Partial<Plan> = {}): Plan => ({
  plan_id: "p1",
  action: "restart",
  target: { cluster_id: "c1", kind_key: "deployments.apps", namespace: "demo", name: "web" },
  kind: "Deployment",
  cluster: { id: "c1", name: "aks-prod-east", provider: "aks", environment: "development" },
  title: "Restart Deployment web",
  summary: ["Restart every pod of Deployment demo/web, following its update strategy (RollingUpdate)."],
  warnings: [],
  blocked: [],
  diff: null,
  confirm_text: null,
  apply_label: "Restart",
  expires_at: "2026-11-08T10:05:00Z",
  ...over,
});

const deployment = (over: Partial<ResourceRow> = {}): ResourceRow => ({
  uid: "d-1",
  cluster_id: "c1",
  kind: "Deployment",
  namespace: "demo",
  name: "web",
  created_at: null,
  labels: {},
  columns: { ready: "2/3", resource_version: "100", status_class: "warn" },
  ...over,
});

const node = (status = "Ready"): ResourceRow => ({
  uid: "n-1",
  cluster_id: "c1",
  kind: "Node",
  namespace: null,
  name: "kind-worker",
  created_at: null,
  labels: {},
  columns: { resource_version: "55", status, status_class: "ok" },
});

const VERBS = ["get", "list", "watch", "update", "patch", "delete"];
const DESCRIBE = "GET /api/clusters/c1/resources/deployments.apps/web/describe?namespace=demo";
const YAML = "GET /api/clusters/c1/resources/deployments.apps/web/yaml?namespace=demo";
const NODE_DESCRIBE = "GET /api/clusters/c1/resources/nodes/kind-worker/describe";

const dialog = () => screen.getByRole("dialog");
const button = (name: string, scope: HTMLElement = document.body) => within(scope).getByRole("button", { name }) as HTMLButtonElement;
const tools = () => screen.getByRole("toolbar", { name: "Tools" });

describe("action dialog", () => {
  it("dialog names the plan's cluster not the selection", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "GET /api/clusters/c2/resources/deployments.apps/web/describe?namespace=shop": [ok(resourceDescribe({ namespace: "shop" }))],
      "POST /api/actions/plan": [ok(plan({ cluster: { id: "c1", name: "aks-prod-east", provider: "aks", environment: "production" } }))],
      "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Restarting.", job_id: null, audit_id: 1 })],
    });
    const out = wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Restart", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/actions/plan")?.body).toEqual({
      action: "restart",
      target: { cluster_id: "c1", kind_key: "deployments.apps", namespace: "demo", name: "web" },
      params: {},
    });

    // The selection moves to the same name on another cluster, in another namespace.
    out.rerender(
      <ActionsProvider>
        <Inspector row={deployment({ uid: "d-2", cluster_id: "c2", namespace: "shop" })} provider="gke" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    const where = within(dialog()).getByTestId("action-where");
    expect(where.textContent).toBe("aks-prod-east / demo / Deployment web");
    expect(dialog().getAttribute("data-provider")).toBe("aks");

    fireEvent.click(button("Restart", dialog()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const apply = calls.filter((c) => c.method === "POST" && c.url.endsWith("/apply"));
    expect(apply).toEqual([{ url: "/api/actions/p1/apply", method: "POST", body: {} }]);
  });

  it("apply sends only the plan id and typed text", async () => {
    const calls = serve({ "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Restarting.", job_id: null, audit_id: 1 })] });
    const onDone = vi.fn();
    wrap(<ActionDialog plan={plan()} onDone={onDone} onReview={vi.fn()} />);
    fireEvent.click(button("Restart", dialog()));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls).toEqual([{ url: "/api/actions/p1/apply", method: "POST", body: {} }]);

    cleanup();
    calls.length = 0;
    const typed = plan({ plan_id: "p2", action: "delete", apply_label: "Delete", confirm_text: "web" });
    serve({ "POST /api/actions/p2/apply": [ok({ outcome: "succeeded", message: "Deleted.", job_id: null, audit_id: 2 })] });
    const fetch = vi.mocked(globalThis.fetch);
    wrap(<ActionDialog plan={typed} onDone={onDone} onReview={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Type web to confirm"), { target: { value: "web" } });
    fireEvent.click(button("Delete", dialog()));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/actions/p2/apply");
    expect(init.body).toBe('{"confirm_text":"web"}');
  });

  it("typed confirmation enables apply only on exact name", () => {
    wrap(<ActionDialog plan={plan({ action: "delete", apply_label: "Delete", confirm_text: "web" })} onDone={vi.fn()} onReview={vi.fn()} />);
    const input = screen.getByLabelText("Type web to confirm");
    const apply = button("Delete", dialog());
    expect(apply.disabled).toBe(true);
    for (const wrong of ["we", "web ", "Web", "web1"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(apply.disabled).toBe(true);
    }
    fireEvent.change(input, { target: { value: "web" } });
    expect(apply.disabled).toBe(false);
  });

  it("production plan shows production warning", () => {
    const prod = plan({
      cluster: { id: "c1", name: "aks-prod-east", provider: "aks", environment: "production" },
      warnings: ["This is a production cluster.", "This deployment is paused: the restart happens once it's resumed."],
    });
    wrap(<ActionDialog plan={prod} onDone={vi.fn()} onReview={vi.fn()} />);
    const d = dialog();
    expect(within(d).getAllByText("This is a production cluster.")).toHaveLength(1);
    expect(within(d).getByText("This is a production cluster.").getAttribute("data-tone")).toBe("warn");
    expect(within(d).getByText("Production")).toBeTruthy();
    expect(within(d).getByText("This deployment is paused: the restart happens once it's resumed.").closest("[data-tone]")?.getAttribute("data-tone")).toBe("warn");

    cleanup();
    wrap(<ActionDialog plan={plan()} onDone={vi.fn()} onReview={vi.fn()} />);
    expect(screen.queryByText("This is a production cluster.")).toBeNull();
  });

  it("blocked plan can't be applied", () => {
    const blocked = plan({ action: "scale", apply_label: "Scale", blocked: ["Nothing changes: web already runs 3 replicas."] });
    wrap(<ActionDialog plan={blocked} onDone={vi.fn()} onReview={vi.fn()} />);
    expect(within(dialog()).getByText("Nothing changes: web already runs 3 replicas.").closest("[data-tone]")?.getAttribute("data-tone")).toBe("bad");
    expect(button("Scale", dialog()).disabled).toBe(true);
  });

  it("conflict keeps dialog open with review again", async () => {
    const conflict = "Deployment web changed since you reviewed this change. Review it again.";
    serve({ "POST /api/actions/p1/apply": [{ status: 409, body: { detail: conflict } }] });
    const onDone = vi.fn();
    const onReview = vi.fn(() => Promise.resolve());
    wrap(<ActionDialog plan={plan()} onDone={onDone} onReview={onReview} />);
    fireEvent.click(button("Restart", dialog()));
    await waitFor(() => expect(within(dialog()).getByText(conflict)).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
    // The plan is used up: only a new review can apply.
    expect(button("Restart", dialog()).disabled).toBe(true);
    fireEvent.click(button("Review again", dialog()));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("an expired plan offers review again too", async () => {
    const expired = "This change expired or was already applied. Review it again.";
    serve({ "POST /api/actions/p1/apply": [{ status: 404, body: { detail: expired } }] });
    wrap(<ActionDialog plan={plan()} onDone={vi.fn()} onReview={vi.fn(() => Promise.resolve())} />);
    fireEvent.click(button("Restart", dialog()));
    await waitFor(() => expect(within(dialog()).getByText(expired)).toBeTruthy());
    expect(button("Review again", dialog())).toBeTruthy();
  });

  it("other failures stay in the dialog and can be tried again", async () => {
    serve({
      "POST /api/actions/p1/apply": [
        { status: 503, body: { detail: "Nothing was changed: the audit log can't be written (disk full)." } },
        ok({ outcome: "succeeded", message: "Restarting.", job_id: null, audit_id: 1 }),
      ],
    });
    const onDone = vi.fn();
    wrap(<ActionDialog plan={plan()} onDone={onDone} onReview={vi.fn()} />);
    fireEvent.click(button("Restart", dialog()));
    await waitFor(() => expect(within(dialog()).getByRole("alert").textContent).toContain("audit log can't be written"));
    expect(screen.queryByRole("button", { name: "Review again" })).toBeNull();
    fireEvent.click(button("Restart", dialog()));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("cancel takes first focus, applying says so and locks the dialog", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    const onDone = vi.fn();
    wrap(<ActionDialog plan={plan()} onDone={onDone} onReview={vi.fn()} />);
    expect(document.activeElement).toBe(button("Cancel", dialog()));
    fireEvent.click(button("Restart", dialog()));
    expect(button("Applying…", dialog()).disabled).toBe(true);
    expect(button("Cancel", dialog()).disabled).toBe(true);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => answer(new Response(JSON.stringify({ outcome: "succeeded", message: "ok", job_id: null, audit_id: 1 }), { status: 200 })));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("tab stays inside the dialog", () => {
    wrap(<ActionDialog plan={plan({ confirm_text: "web" })} onDone={vi.fn()} onReview={vi.fn()} />);
    const cancel = button("Cancel", dialog());
    const input = screen.getByLabelText("Type web to confirm");
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(input); // Restart is off until the name is typed
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
  });
});

describe("changes from the details", () => {
  it("edit review shows diff and applies", async () => {
    const before = "kind: Deployment\nmetadata:\n  name: web\n  resourceVersion: \"100\"\nspec:\n  replicas: 3\n";
    const edited = before.replace("replicas: 3", "replicas: 4");
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      [YAML]: [ok({ yaml: before })],
      "POST /api/actions/plan": [
        ok(plan({ action: "edit", title: "Edit Deployment web", apply_label: "Save", diff: { before: "spec:\n  replicas: 3\n", after: "spec:\n  replicas: 4\n" } })),
      ],
      "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Saved Deployment demo/web.", job_id: null, audit_id: 3 })],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Edit", tools()));
    const area = (await screen.findByLabelText("Edit Deployment YAML")) as HTMLTextAreaElement;
    expect(area.value).toBe(before);
    fireEvent.input(area, { target: { value: edited } });
    fireEvent.click(button("Review changes"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/actions/plan")?.body).toEqual({
      action: "edit",
      target: { cluster_id: "c1", kind_key: "deployments.apps", namespace: "demo", name: "web" },
      params: { yaml: edited },
    });
    expect((await within(dialog()).findByTestId("diff-after")).textContent).toBe("spec:\n  replicas: 4\n");
    expect(within(dialog()).getByTestId("diff-before").textContent).toBe("spec:\n  replicas: 3\n");
    fireEvent.click(button("Save", dialog()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.url.endsWith("/apply"))).toEqual([{ url: "/api/actions/p1/apply", method: "POST", body: {} }]);
    // Saved: the editor goes, the YAML is read again.
    await waitFor(() => expect(screen.queryByLabelText("Edit Deployment YAML")).toBeNull());
  });

  it("an edit the server refuses keeps the edited text", async () => {
    serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      [YAML]: [ok({ yaml: "kind: Deployment\n" })],
      "POST /api/actions/plan": [{ status: 422, body: { detail: "An edit can't change the kind, name or namespace. Create a new object with kubectl instead." } }],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Edit", tools()));
    const area = (await screen.findByLabelText("Edit Deployment YAML")) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: "kind: Service\n" } });
    fireEvent.click(button("Review changes"));
    expect(await screen.findByText("An edit can't change the kind, name or namespace. Create a new object with kubectl instead.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("Edit Deployment YAML") as HTMLTextAreaElement).value).toBe("kind: Service\n");
    fireEvent.click(button("Discard"));
    expect(screen.queryByLabelText("Edit Deployment YAML")).toBeNull();
  });

  it("secrets get no edit button", () => {
    serve({ "GET /api/clusters/c1/resources/secrets/db/describe?namespace=demo": [ok(resourceDescribe({ kind_key: "secrets", kind: "Secret", name: "db" }))] });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment({ kind: "Secret", name: "db" })} provider="aks" kindKey="secrets" verbs={VERBS} />
      </ActionsProvider>,
    );
    expect(within(tools()).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(button("Delete", tools())).toBeTruthy();
  });

  it("tools follow the kind", () => {
    serve({ [NODE_DESCRIBE]: [ok(resourceDescribe({ kind_key: "nodes", kind: "Node", name: "kind-worker", namespace: null }))] });
    wrap(
      <ActionsProvider>
        <Inspector row={node()} provider="kind" kindKey="nodes" verbs={VERBS} />
      </ActionsProvider>,
    );
    // Each button's own words, without its keycap; a schedulable node offers Cordon only.
    const names = within(tools()).getAllByRole("button").map((b) => b.childNodes[0].textContent);
    expect(names).toEqual(["Edit", "Cordon", "Drain", "Node shell", "Delete"]);
  });

  it("only the cordon or uncordon that applies is offered", () => {
    serve({ [NODE_DESCRIBE]: [ok(resourceDescribe({ kind_key: "nodes", kind: "Node", name: "kind-worker", namespace: null }))] });
    const out = wrap(
      <ActionsProvider>
        <Inspector row={node("Ready, SchedulingDisabled")} provider="kind" kindKey="nodes" verbs={VERBS} />
      </ActionsProvider>,
    );
    expect(within(tools()).queryByRole("button", { name: /^Cordon/ })).toBeNull();
    expect(button("Uncordon", tools())).toBeTruthy();
    // A node that isn't Ready doesn't say whether it is cordoned: both are offered.
    out.rerender(
      <ActionsProvider>
        <Inspector row={node("NotReady")} provider="kind" kindKey="nodes" verbs={VERBS} />
      </ActionsProvider>,
    );
    expect(button("Cordon", tools())).toBeTruthy();
    expect(button("Uncordon", tools())).toBeTruthy();
  });

  it("a successful change says what the server did, until you move on", async () => {
    serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan())],
      "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Restarting every pod of Deployment demo/web.", job_id: null, audit_id: 1 })],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Restart", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Restart", dialog()));
    const said = await screen.findByText("Restarting every pod of Deployment demo/web.");
    expect(said.getAttribute("data-tone")).toBe("ok");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Still there after the page re-renders; gone once another tool starts.
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByText("Restarting every pod of Deployment demo/web.")).toBeTruthy();
    fireEvent.click(button("Scale", tools()));
    expect(screen.queryByText("Restarting every pod of Deployment demo/web.")).toBeNull();
  });

  it("a cancelled change says nothing", async () => {
    serve({ [DESCRIBE]: [ok(resourceDescribe())], "POST /api/actions/plan": [ok(plan())] });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Restart", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Cancel", dialog()));
    await waitFor(() => expect(button("Restart", tools()).disabled).toBe(false));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a scale applied keeps focus in the details and says so", async () => {
    serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan({ action: "scale", apply_label: "Scale" }))],
      "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Scaled Deployment demo/web to 5 replicas.", job_id: null, audit_id: 1 })],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Scale", tools()));
    fireEvent.change(screen.getByLabelText("Replicas"), { target: { value: "5" } });
    const review = button("Review");
    review.focus();
    fireEvent.click(review);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Scale", dialog()));
    await screen.findByText("Scaled Deployment demo/web to 5 replicas.");
    expect(screen.queryByLabelText("Replicas")).toBeNull();
    const details = screen.getByRole("region", { name: "Details for web" });
    await waitFor(() => expect(details.contains(document.activeElement)).toBe(true));
  });

  it("a drain closed after it ended leaves its message in the details", async () => {
    const ended = "Drain stopped after 5m: 1 pods are still protected by a PodDisruptionBudget (demo/web-1). kind-worker stays cordoned.";
    serve({
      [NODE_DESCRIBE]: [ok(resourceDescribe({ kind_key: "nodes", kind: "Node", name: "kind-worker", namespace: null }))],
      "POST /api/actions/plan": [
        ok(plan({ action: "drain", target: { cluster_id: "c1", kind_key: "nodes", namespace: null, name: "kind-worker" }, apply_label: "Drain" })),
      ],
      "POST /api/actions/p1/apply": [ok({ outcome: "started", message: "Cordoned kind-worker; evicting 2 pods.", job_id: "j1", audit_id: 9 })],
      "GET /api/actions/jobs/j1": [
        ok({ id: "j1", action: "drain", state: "failed", message: ended, total: 2, done: 1, blocked: [], started_at: "", finished_at: "" }),
      ],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={node()} provider="kind" kindKey="nodes" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Drain", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Drain", dialog()));
    await within(dialog()).findByText(ended);
    fireEvent.click(button("Close", dialog()));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((await screen.findByText(ended)).getAttribute("data-tone")).toBe("warn");
  });

  it("the editor takes focus on load only if you haven't moved on", async () => {
    serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: "kind: Deployment" })] });
    let resolve!: (k: typeof kit) => void;
    vi.mocked(loadCodeMirror).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    wrap(
      <>
        <input aria-label="Elsewhere" />
        <ActionsProvider>
          <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
        </ActionsProvider>
      </>,
    );
    fireEvent.click(button("Edit", tools()));
    await screen.findByText("Loading the editor…");
    const elsewhere = screen.getByLabelText("Elsewhere");
    elsewhere.focus();
    await act(async () => resolve(kit));
    expect(screen.getByLabelText("Edit Deployment YAML")).toBeTruthy();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("the editor takes focus on load when you're still at Edit", async () => {
    serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: "kind: Deployment" })] });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    const edit = button("Edit", tools());
    edit.focus();
    fireEvent.click(edit);
    const area = await screen.findByLabelText("Edit Deployment YAML");
    await waitFor(() => expect(document.activeElement).toBe(area));
  });

  it("scale form plans with replicas", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan({ action: "scale", title: "Scale Deployment web", apply_label: "Scale" }))],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Scale", tools()));
    const replicas = screen.getByLabelText("Replicas") as HTMLInputElement;
    expect(replicas.value).toBe("3"); // the desired count from the row's Ready column
    fireEvent.change(replicas, { target: { value: "5" } });
    fireEvent.click(button("Review"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/actions/plan")?.body).toEqual({
      action: "scale",
      target: { cluster_id: "c1", kind_key: "deployments.apps", namespace: "demo", name: "web" },
      params: { replicas: 5 },
    });
  });

  it("rollback defaults to the previous revision", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "GET /api/clusters/c1/deployments/demo/web/revisions": [
        ok([
          { revision: 4, created_at: null, images: ["web:4"], current: true },
          { revision: 3, created_at: null, images: ["web:3"], current: false },
          { revision: 1, created_at: null, images: ["web:1"], current: false },
        ]),
      ],
      "POST /api/actions/plan": [ok(plan({ action: "rollback", apply_label: "Roll back" }))],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Roll back", tools()));
    const previous = (await screen.findByRole("radio", { name: /Revision 3/ })) as HTMLInputElement;
    expect(previous.checked).toBe(true);
    expect((screen.getByRole("radio", { name: /Revision 4/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Revision 1/ }));
    fireEvent.click(button("Review"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/actions/plan")?.body).toMatchObject({ action: "rollback", params: { revision: 1 } });
  });

  it("drain shows blocked pods and replans with options", async () => {
    const unmanaged = "1 pods aren't managed by a controller and won't be recreated: demo/loner.";
    const calls = serve({
      [NODE_DESCRIBE]: [ok(resourceDescribe({ kind_key: "nodes", kind: "Node", name: "kind-worker", namespace: null }))],
      "POST /api/actions/plan": (body) => {
        const force = (body as { params: { force?: boolean } }).params.force === true;
        return ok(
          plan({
            plan_id: force ? "p2" : "p1",
            action: "drain",
            target: { cluster_id: "c1", kind_key: "nodes", namespace: null, name: "kind-worker" },
            kind: "Node",
            cluster: { id: "c1", name: "kind-omnikrux-dev", provider: "kind", environment: "development" },
            title: "Drain kind-worker",
            summary: ["Cordon kind-worker, then evict 2 pods. 1 DaemonSet pods stay.", "demo/loner", "demo/web-1"],
            warnings: force ? [unmanaged] : [],
            blocked: force ? [] : [unmanaged],
            confirm_text: "kind-worker",
            apply_label: "Drain",
          }),
        );
      },
      "POST /api/actions/p2/apply": [ok({ outcome: "started", message: "Draining kind-worker.", job_id: "j1", audit_id: 9 })],
      "GET /api/actions/jobs/j1": [ok({ id: "j1", action: "drain", state: "succeeded", message: "Drained kind-worker: 2 pods evicted.", total: 2, done: 2, blocked: [], started_at: "", finished_at: "" })],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={node()} provider="kind" kindKey="nodes" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Drain", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(within(dialog()).getByText(unmanaged).closest("[data-tone]")?.getAttribute("data-tone")).toBe("bad");
    expect(within(dialog()).getByTestId("action-where").textContent).toBe("kind-omnikrux-dev / Node kind-worker");
    fireEvent.change(within(dialog()).getByLabelText("Type kind-worker to confirm"), { target: { value: "kind-worker" } });
    expect(button("Drain", dialog()).disabled).toBe(true);

    fireEvent.click(within(dialog()).getByLabelText("Evict pods without a controller"));
    await waitFor(() => expect(within(dialog()).getByText(unmanaged).closest("[data-tone]")?.getAttribute("data-tone")).toBe("warn"));
    const plans = calls.filter((c) => c.url === "/api/actions/plan");
    expect(plans.map((c) => (c.body as { params: unknown }).params)).toEqual([
      {},
      { force: true, delete_emptydir_data: false },
    ]);
    // A new plan needs the name typed again.
    expect(button("Drain", dialog()).disabled).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText("Type kind-worker to confirm"), { target: { value: "kind-worker" } });
    fireEvent.click(button("Drain", dialog()));
    expect(await within(dialog()).findByText("Drained kind-worker: 2 pods evicted.")).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/apply"))).toEqual([
      { url: "/api/actions/p2/apply", method: "POST", body: { confirm_text: "kind-worker" } },
    ]);
  });

  it("a plan that fails says so in the details", async () => {
    serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [{ status: 403, body: { detail: "You can't restart deployments in demo." } }],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Restart", tools()));
    expect(await screen.findByText("You can't restart deployments in demo.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("delete from the details pins the row's uid, like bulk delete", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan({ action: "delete", apply_label: "Delete", confirm_text: "web" }))],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Delete", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/actions/plan")?.body).toMatchObject({
      action: "delete", params: { expected_uid: "d-1" },
    });
  });

  it("a review closed without applying is closed on the server too", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [
        ok(plan({ plan_id: "first", action: "delete", apply_label: "Delete", confirm_text: "web" })),
        ok(plan({ plan_id: "second", action: "delete", apply_label: "Delete", confirm_text: "web" })),
      ],
      "DELETE /api/actions/first": [ok({})],
      "DELETE /api/actions/second": [ok({})],
    });
    const view = wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Delete", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Cancel", dialog()));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/actions/first"]));
    // A review still open when the page leaves is closed as well.
    fireEvent.click(button("Delete", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    view.unmount();
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/actions/first", "/api/actions/second"]));
  });

  it("an applied review is not closed again", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan())],
      "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Restarted.", job_id: null, audit_id: 1 })],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Restart", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Restart", dialog()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("tool keys work in the details but not in a field", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan())],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Scale", tools()));
    fireEvent.keyDown(screen.getByLabelText("Replicas"), { key: "r" });
    expect(calls.some((c) => c.url === "/api/actions/plan")).toBe(false);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Describe" }), { key: "r" });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(calls.find((c) => c.url === "/api/actions/plan")?.body).toMatchObject({ action: "restart" });
  });

  it("ctrl+delete in the details plans the delete, but in a field it edits the field", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan({ action: "delete" }))],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Scale", tools()));
    const field = new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      screen.getByLabelText("Replicas").dispatchEvent(field);
    });
    expect(field.defaultPrevented).toBe(false);
    expect(calls.some((c) => c.url === "/api/actions/plan")).toBe(false);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Describe" }), { key: "Delete", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(calls.filter((c) => c.url === "/api/actions/plan").map((c) => c.body)).toEqual([
      expect.objectContaining({ action: "delete", params: { expected_uid: deployment().uid } }),
    ]);
  });
});

describe("tool keys on rows", () => {
  beforeEach(() => {
    // jsdom has no layout; give everything a size so the virtualizer renders rows.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  const territory = {
    cluster: { id: "c1", name: "aks-prod-east", context_name: "x", server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null, provider: "aks" as const,
      region: null, environment: "development" as const, state: "ready" as const, message: null },
    state: "ready" as const, message: null, rows: [deployment()], total: 1, failing: 0, pending: 0,
  };

  it.each([
    [{ key: "r" }, "restart"],
    [{ key: "d", ctrlKey: true }, "delete"],
    [{ key: "Delete", ctrlKey: true }, "delete"],
    [{ key: "Backspace", metaKey: true }, "delete"],
  ])("%o on a row opens its details and plans %s", async (press, action) => {
    const calls = serve({ [DESCRIBE]: [ok(resourceDescribe())], "POST /api/actions/plan": [ok(plan({ action: action as Plan["action"] }))] });
    wrap(
      <ActionsProvider>
        <div style={{ height: 600 }}>
          <Table territories={[territory]} kind={{ ...DEPLOYMENTS, verbs: VERBS }} onRetry={() => {}} />
        </div>
      </ActionsProvider>,
    );
    const row = document.querySelector<HTMLElement>("[data-row-key]")!;
    row.focus();
    fireEvent.keyDown(row, press);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByRole("region", { name: "Details for web" })).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/actions/plan").map((c) => (c.body as { action: string }).action)).toEqual([action]);
  });

  it("s on a deployment row opens the scale form", async () => {
    serve({ [DESCRIBE]: [ok(resourceDescribe())] });
    wrap(
      <ActionsProvider>
        <div style={{ height: 600 }}>
          <Table territories={[territory]} kind={{ ...DEPLOYMENTS, verbs: VERBS }} onRetry={() => {}} />
        </div>
      </ActionsProvider>,
    );
    const row = document.querySelector<HTMLElement>("[data-row-key]")!;
    fireEvent.keyDown(row, { key: "s" });
    expect(((await screen.findByLabelText("Replicas")) as HTMLInputElement).value).toBe("3");
  });
});

describe("late plans", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  it("drops a plan response when its still-visible pane is no longer active", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => { answer = resolve; });
      return json(resourceDescribe());
    }));
    const row = deployment();
    const ui = (paneActive: boolean) => (
      <ActionsProvider>
        <Inspector row={row} provider="aks" kindKey="deployments.apps" verbs={VERBS} paneActive={paneActive} />
      </ActionsProvider>
    );
    const view = wrap(ui(true));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    view.rerender(ui(false));
    await act(async () => answer(await json(plan())));
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(ui(true));
    expect((screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([["Escape"], ["ArrowDown"]])("a plan that comes back after %s left its details never opens", async (away) => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((r) => { answer = r; });
      return json(resourceDescribe());
    }));
    const territory = {
      cluster: { id: "c1", name: "aks-prod-east", context_name: "x", server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null, provider: "aks" as const,
        region: null, environment: "development" as const, state: "ready" as const, message: null },
      state: "ready" as const, message: null, rows: [deployment(), deployment({ uid: "d-2", name: "worker" })], total: 2, failing: 0, pending: 0,
    };
    wrap(
      <ActionsProvider>
        <div style={{ height: 600 }}>
          <Table territories={[territory]} kind={{ ...DEPLOYMENTS, verbs: VERBS }} onRetry={() => {}} />
        </div>
      </ActionsProvider>,
    );
    const web = () => Array.from(document.querySelectorAll<HTMLElement>("[data-row-key]")).find((r) => r.textContent?.includes("web"))!;
    web().focus();
    fireEvent.keyDown(web(), { key: "r" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Details for web" })).toBeTruthy());
    fireEvent.keyDown(web(), { key: away });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Details for web" })).toBeNull());
    const focused = document.activeElement;
    await act(async () => answer(new Response(JSON.stringify(plan()), { status: 200, headers: { "Content-Type": "application/json" } })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(focused);
  });
});

describe("drain progress", () => {
  const job = (over: Partial<Job>): Job => ({
    id: "j1",
    action: "drain",
    state: "running",
    message: "Draining kind-worker.",
    total: 3,
    done: 0,
    blocked: [],
    started_at: "2026-11-08T10:00:00Z",
    finished_at: null,
    ...over,
  });

  it("drain progress polls the job until done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serve({
      "GET /api/actions/jobs/j1": [
        ok(job({ done: 1 })),
        ok(job({ done: 2, blocked: [{ namespace: "demo", name: "web-2", message: "Cannot evict pod as it would violate the pod's disruption budget." }] })),
        ok(job({ done: 3, state: "succeeded", message: "Drained kind-worker: 3 pods evicted.", finished_at: "2026-11-08T10:01:00Z" })),
      ],
    });
    const onClose = vi.fn();
    wrap(<DrainProgress jobId="j1" onClose={onClose} />);
    expect(await screen.findByText("1 of 3 pods evicted")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(await screen.findByText("2 of 3 pods evicted")).toBeTruthy();
    expect(screen.getByText("demo/web-2")).toBeTruthy();
    expect(screen.getByText("Cannot evict pod as it would violate the pod's disruption budget.")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(await screen.findByText("Drained kind-worker: 3 pods evicted.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel drain" })).toBeNull();
    const polls = calls.length;
    await act(async () => vi.advanceTimersByTime(4000));
    expect(calls.length).toBe(polls);
    fireEvent.click(button("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("a job the server no longer knows says so, without a live cancel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({
      "GET /api/actions/jobs/j1": [
        ok(job({ done: 2, total: 5 })),
        { status: 404, body: { detail: "This job isn't known: it ended more than an hour ago, or the console restarted." } },
      ],
    });
    wrap(<DrainProgress jobId="j1" onClose={vi.fn()} />);
    expect(await screen.findByText("2 of 5 pods evicted")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(await screen.findByText(/This job isn't known/)).toBeTruthy();
    expect(screen.getByText(/check the audit log/)).toBeTruthy();
    expect(screen.queryByText("2 of 5 pods evicted")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel drain" })).toBeNull();
    expect(screen.queryByText("The drain carries on if you close this.")).toBeNull();
  });

  it("a failed poll never shows the last numbers as live", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({
      "GET /api/actions/jobs/j1": [
        ok(job({ done: 1 })),
        { status: 502, body: { detail: "The cluster didn't answer." } },
        ok(job({ done: 2 })),
      ],
    });
    wrap(<DrainProgress jobId="j1" onClose={vi.fn()} />);
    expect(await screen.findByText("1 of 3 pods evicted")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(await screen.findByText(/Can't read the drain's progress/)).toBeTruthy();
    expect(screen.queryByText("1 of 3 pods evicted")).toBeNull();
    // It keeps asking, and shows the numbers again once the server answers.
    await act(async () => vi.advanceTimersByTime(1000));
    expect(await screen.findByText("2 of 3 pods evicted")).toBeTruthy();
    expect(screen.queryByText(/Can't read the drain's progress/)).toBeNull();
  });

  it("a drain's end reloads the audit log and the details", async () => {
    serve({ "GET /api/actions/jobs/j1": [ok(job({ done: 3, state: "succeeded", message: "Drained kind-worker." }))] });
    const out = wrap(<DrainProgress jobId="j1" onClose={vi.fn()} />);
    const invalidate = vi.spyOn(out.client, "invalidateQueries");
    await screen.findByText("Drained kind-worker.");
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([f]) => (f as { queryKey: unknown[] }).queryKey[0]);
      expect(keys).toEqual(expect.arrayContaining(["audit", "resource-describe", "describe"]));
    });
  });

  it("cancel stops the drain and shows how it ended", async () => {
    const calls = serve({
      "GET /api/actions/jobs/j1": [ok(job({ done: 1 }))],
      "POST /api/actions/jobs/j1/cancel": [
        ok(job({ done: 1, state: "cancelled", message: "Drain cancelled. kind-worker stays cordoned; uncordon it to schedule pods there again." })),
      ],
    });
    wrap(<DrainProgress jobId="j1" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel drain" }));
    expect(await screen.findByText("Drain cancelled. kind-worker stays cordoned; uncordon it to schedule pods there again.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/actions/jobs/j1/cancel")).toBe(true);
  });
});

describe("codemirror", () => {
  it("codemirror loads lazily", async () => {
    serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      [YAML]: [ok({ yaml: "kind: Deployment\n" })],
      "POST /api/actions/plan": [ok(plan())],
    });
    const out = wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    // Details, the YAML tab and a dialog without a diff: nothing loads CodeMirror.
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    await screen.findByTestId("yaml");
    fireEvent.click(button("Restart", tools()));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(loadCodeMirror).not.toHaveBeenCalled();
    fireEvent.click(button("Cancel", dialog()));
    out.unmount();

    // A diff loads it, saying so meanwhile.
    let resolve!: (k: typeof kit) => void;
    vi.mocked(loadCodeMirror).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    wrap(<ActionDialog plan={plan({ diff: { before: "a: 1\n", after: "a: 2\n" } })} onDone={vi.fn()} onReview={vi.fn()} />);
    expect(screen.getByText("Loading the diff…")).toBeTruthy();
    expect(loadCodeMirror).toHaveBeenCalledTimes(1);
    await act(async () => resolve(kit));
    expect(screen.getByTestId("diff-after").textContent).toBe("a: 2\n");
    expect(screen.queryByText("Loading the diff…")).toBeNull();
  });
});
