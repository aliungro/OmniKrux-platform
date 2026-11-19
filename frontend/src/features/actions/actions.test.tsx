import { FILE_CLUSTER_METADATA } from "../../test/clusters";
// frontend/src/features/actions/actions.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { Job, Plan, ResourceRow } from "../../api/types";
import { resourceDescribe } from "../../test/describe";
import { DEPLOYMENTS } from "../../test/kinds";
import { AllShortcuts } from "../chrome/ShortcutBar";
import { Table } from "../../test/table";
import type { RowRequest } from "../territories/TerritoryTable";
import { Inspector } from "../inspector/Inspector";
import { ActionDialog, ActionsProvider, reviewFocus } from "./ActionDialog";
import { DrainProgress } from "./DrainProgress";
import { loadCodeMirror, type EditorKeys } from "./lazyCodeMirror";

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
  editor: (parent: HTMLElement, doc: string, onChange: (text: string) => void, label: string, keys: EditorKeys) => {
    const area = document.createElement("textarea");
    area.value = doc;
    area.setAttribute("aria-label", label);
    area.addEventListener("input", () => onChange(area.value));
    // Mirrors `editorKeymap`: CodeMirror runs it on the content before the page sees the key.
    area.addEventListener("keydown", (e) => {
      if (e.repeat && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        keys.onSubmit();
      } else if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        keys.onLeave();
      }
    });
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

  it("the action button takes first focus, applying says so and locks the dialog", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { answer = r; })));
    const onDone = vi.fn();
    wrap(<ActionDialog plan={plan()} onDone={onDone} onReview={vi.fn()} />);
    expect(document.activeElement).toBe(button("Restart", dialog()));
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
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(document.activeElement).toBe(input); // Restart is off until the name is typed
  });

  const applied = { outcome: "succeeded", message: "Done.", job_id: null, audit_id: 1 };
  const applies = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/apply"));

  it.each([
    ["restart", "Restart"],
    ["scale", "Scale"],
    ["rollback", "Roll back"],
    ["cordon", "Cordon"],
    ["uncordon", "Uncordon"],
    ["edit", "Save"],
  ] as const)("a review opens on its action button and enter applies (%s)", async (action, label) => {
    const calls = serve({ "POST /api/actions/p1/apply": [ok(applied)] });
    const onDone = vi.fn();
    const diff = action === "edit" ? { before: "a: 1\n", after: "a: 2\n" } : null;
    wrap(<ActionDialog plan={plan({ action, apply_label: label, diff })} onDone={onDone} onReview={vi.fn()} />);
    const go = button(label, dialog());
    expect(document.activeElement).toBe(go);
    expect(go.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(applies(calls)).toEqual([{ url: "/api/actions/p1/apply", method: "POST", body: {} }]);
  });

  it("delete, drain and evict reviews keep focus on cancel", () => {
    for (const [action, label] of [["delete", "Delete"], ["drain", "Drain"], ["evict", "Evict"]] as const) {
      wrap(<ActionDialog plan={plan({ action, apply_label: label })} onDone={vi.fn()} onReview={vi.fn()} />);
      expect(document.activeElement).toBe(button("Cancel", dialog()));
      expect(button(label, dialog()).disabled).toBe(false);
      cleanup();
    }
    expect(reviewFocus({ action: "delete", blocked: [], confirm_text: "web" })).toBe("cancel");
  });

  it("a blocked review opens on cancel and a typed one on its name field", () => {
    const blocked = plan({ action: "scale", apply_label: "Scale", blocked: ["Nothing changes: web already runs 3 replicas."] });
    wrap(<ActionDialog plan={blocked} onDone={vi.fn()} onReview={vi.fn()} />);
    expect(document.activeElement).toBe(button("Cancel", dialog()));
    cleanup();
    wrap(<ActionDialog plan={plan({ confirm_text: "web" })} onDone={vi.fn()} onReview={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Type web to confirm"));
    expect(reviewFocus({ action: "restart", blocked: [], confirm_text: null })).toBe("apply");
  });

  it("ctrl+enter confirms any review", async () => {
    let calls = serve({ "POST /api/actions/p1/apply": [ok(applied)] });
    let onDone = vi.fn();
    wrap(<ActionDialog plan={plan()} onDone={onDone} onReview={vi.fn()} />);
    expect(fireEvent.keyDown(dialog(), { key: "Enter", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(applies(calls)).toHaveLength(1);

    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      cleanup();
      calls = serve({ "POST /api/actions/p1/apply": [ok(applied)] });
      onDone = vi.fn();
      wrap(<ActionDialog plan={plan({ action: "delete", apply_label: "Delete" })} onDone={onDone} onReview={vi.fn()} />);
      const cancel = button("Cancel", dialog());
      expect(document.activeElement).toBe(cancel);
      // On Cancel, Ctrl+Enter confirms; it never presses Cancel.
      expect(fireEvent.keyDown(cancel, { key: "Enter", ...mod })).toBe(false);
      await waitFor(() => expect(onDone).toHaveBeenCalledWith({ message: "Done.", tone: "ok" }));
      expect(applies(calls)).toEqual([{ url: "/api/actions/p1/apply", method: "POST", body: {} }]);
    }
  });

  it("ctrl+enter does nothing until the name is typed", async () => {
    const calls = serve({ "POST /api/actions/p1/apply": [ok(applied)] });
    const onDone = vi.fn();
    wrap(<ActionDialog plan={plan({ confirm_text: "web" })} onDone={onDone} onReview={vi.fn()} />);
    const input = screen.getByLabelText("Type web to confirm");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(applies(calls)).toHaveLength(0);
    await userEvent.type(input, "web");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // The field acts on plain Enter only, so Ctrl+Enter in it applies exactly once.
    expect(applies(calls)).toEqual([{ url: "/api/actions/p1/apply", method: "POST", body: { confirm_text: "web" } }]);
  });

  it("a held enter never applies", () => {
    const calls = serve({ "POST /api/actions/p1/apply": [ok(applied)] });
    wrap(<ActionDialog plan={plan()} onDone={vi.fn()} onReview={vi.fn()} />);
    const go = button("Restart", dialog());
    expect(document.activeElement).toBe(go);
    // The prevented keydown is what stops a held Enter from pressing the button (R31).
    expect(fireEvent.keyDown(go, { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(go, { key: "Enter", ctrlKey: true, repeat: true })).toBe(false);
    expect(applies(calls)).toHaveLength(0);
    expect(go.textContent).toBe("Restart");
  });

  it("ctrl+enter while applying does nothing more", async () => {
    let answer!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    vi.stubGlobal("fetch", fetch);
    const onDone = vi.fn();
    wrap(<ActionDialog plan={plan()} onDone={onDone} onReview={vi.fn()} />);
    fireEvent.keyDown(dialog(), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(dialog(), { key: "Enter", ctrlKey: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => answer(new Response(JSON.stringify(applied), { status: 200 })));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("ctrl+enter never applies past its review", () => {
  it("two ctrl+enters in one act send one apply", () => {
    // In one act nothing re-renders between the presses, so only the `applying` guard can stop the second.
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    wrap(<ActionDialog plan={plan()} onDone={vi.fn()} onReview={vi.fn()} />);
    act(() => {
      fireEvent.keyDown(dialog(), { key: "Enter", ctrlKey: true });
      fireEvent.keyDown(dialog(), { key: "Enter", ctrlKey: true });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ctrl+enter on a blocked review sends nothing", async () => {
    const fetch = vi.fn(() => json({}));
    vi.stubGlobal("fetch", fetch);
    const onDone = vi.fn();
    wrap(<ActionDialog plan={plan({ blocked: ["Nothing changes: web already runs 3 replicas."] })} onDone={onDone} onReview={vi.fn()} />);
    const cancel = button("Cancel", dialog());
    expect(document.activeElement).toBe(cancel);
    // Prevented (Cancel is never pressed by it) and refused.
    expect(fireEvent.keyDown(cancel, { key: "Enter", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(dialog(), { key: "Enter", metaKey: true })).toBe(false);
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
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

  it("an enter held from the scale form never applies the review", async () => {
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      "POST /api/actions/plan": [ok(plan({ action: "scale", title: "Scale Deployment web", apply_label: "Scale" }))],
      "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Scaled.", job_id: null, audit_id: 1 })],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Scale", tools()));
    const replicas = screen.getByLabelText("Replicas");
    await userEvent.clear(replicas);
    await userEvent.type(replicas, "2{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(button("Scale", dialog())));
    // The same Enter, still held, repeats on the button that just took focus.
    expect(fireEvent.keyDown(document.activeElement!, { key: "Enter", repeat: true })).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/apply"))).toHaveLength(0);
    expect(calls.find((c) => c.url === "/api/actions/plan")?.body).toMatchObject({ params: { replicas: 2 } });
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

describe("detail tab shortcuts", () => {
  it.each([
    {
      kindKey: "pods",
      row: deployment({ uid: "p-1", kind: "Pod" }),
      describeRoute: "GET /api/clusters/c1/pods/demo/web/describe",
      metrics: true,
    },
    { kindKey: "nodes", row: node(), describeRoute: NODE_DESCRIBE, metrics: true },
    { kindKey: "deployments.apps", row: deployment(), describeRoute: DESCRIBE, metrics: false },
  ])("detail tabs show their existing shortcut numbers without changing tab names ($kindKey)", ({
    kindKey, row, describeRoute, metrics,
  }) => {
    serve({ [describeRoute]: [ok(resourceDescribe())] });
    wrap(<ActionsProvider><Inspector row={row} provider="aks" kindKey={kindKey} /></ActionsProvider>);

    const tablist = within(screen.getByRole("tablist", { name: "Details" }));
    const names = metrics ? ["Describe", "YAML", "Events", "Metrics"] : ["Describe", "YAML", "Events"];
    const tabs = tablist.getAllByRole("tab");
    const panel = screen.getByRole("tabpanel", { name: "Describe" });
    expect(tabs).toEqual(names.map((name) => tablist.getByRole("tab", { name })));
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(names.length);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    tabs.forEach((tab, index) => {
      const number = String(index + 1);
      const hint = within(tab).getByText(number);
      expect(hint.getAttribute("aria-hidden")).toBe("true");
      expect(hint.closest("[hidden]")).toBeNull();
      expect(hint.tabIndex).toBe(-1);
      expect(tab.lastElementChild).toBe(hint);
      expect(tab.getAttribute("aria-keyshortcuts")).toBe(number);
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
      expect(tab.tabIndex).toBe(index === 0 ? 0 : -1);
    });

    fireEvent.click(tablist.getByRole("tab", { name: "Events" }));
    expect(screen.getByRole("tabpanel", { name: "Events" })).toBe(panel);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[2].id);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual(names.map((_, index) => index === 2 ? 0 : -1));
  });

  it("tab hints preserve existing editing and tab-navigation guards", async () => {
    serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: "kind: Deployment\n" })] });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    const user = userEvent.setup();
    const activeTab = (name: string) => screen.getByRole("tab", { name, selected: true });
    activeTab("Describe").focus();
    for (const [key, name] of [
      ["{ArrowRight}", "YAML"], ["{ArrowLeft}", "Describe"], ["{End}", "Events"],
      ["{Home}", "Describe"], ["2", "YAML"], ["3", "Events"], ["1", "Describe"], ["4", "Describe"],
    ]) {
      await user.keyboard(key);
      expect(document.activeElement).toBe(activeTab(name));
    }

    await user.click(button("Scale", tools()));
    const replicas = screen.getByLabelText<HTMLInputElement>("Replicas");
    await user.clear(replicas);
    await user.type(replicas, "2");
    expect(replicas.value).toBe("2");
    expect(document.activeElement).toBe(replicas);
    expect(activeTab("Describe")).toBeTruthy();
    await user.click(button("Cancel"));

    await user.click(button("Edit", tools()));
    const editor = await screen.findByLabelText<HTMLTextAreaElement>("Edit Deployment YAML");
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const before = editor.value;
    editor.setSelectionRange(before.length, before.length);
    await user.keyboard("13");
    expect(editor.value).toBe(before + "13");
    expect(document.activeElement).toBe(editor);
    expect(activeTab("YAML")).toBeTruthy();
  });
});

describe("yaml editor keys", () => {
  const BEFORE = "kind: Deployment\nspec:\n  replicas: 3\n";
  const EDITED = BEFORE.replace("replicas: 3", "replicas: 4");
  const editPlan = () =>
    ok(plan({ action: "edit", title: "Edit Deployment web", apply_label: "Save", diff: { before: "replicas: 3\n", after: "replicas: 4\n" } }));
  const plans = (calls: Call[]) => calls.filter((c) => c.url === "/api/actions/plan");

  /** The details on the YAML tab, editing; `edit` types a change. Keys that reach past the details are recorded. */
  async function openEditor({ edit = true } = {}) {
    const calls = serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: BEFORE })], "POST /api/actions/plan": [editPlan()] });
    const outside = vi.fn();
    const onClose = vi.fn();
    wrap(
      <div onKeyDown={(e) => outside(e.key)}>
        <ActionsProvider>
          <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} onClose={onClose} />
        </ActionsProvider>
      </div>,
    );
    const start = button("Edit", tools());
    start.focus();
    fireEvent.click(start);
    const area = (await screen.findByLabelText("Edit Deployment YAML")) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(area));
    if (edit) fireEvent.input(area, { target: { value: EDITED } });
    return { calls, area, outside, onClose };
  }

  async function reviewsWith(mod: { ctrlKey: true } | { metaKey: true }) {
    const { calls, area } = await openEditor();
    expect(fireEvent.keyDown(area, { key: "Enter", ...mod })).toBe(false);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(plans(calls).map((c) => c.body)).toEqual([
      { action: "edit", target: { cluster_id: "c1", kind_key: "deployments.apps", namespace: "demo", name: "web" }, params: { yaml: EDITED } },
    ]);
    // The normal review, opened on its action button: nothing is applied from the editor.
    await waitFor(() => expect(document.activeElement).toBe(button("Save", dialog())));
    expect(calls.filter((c) => c.url.endsWith("/apply"))).toEqual([]);
  }

  it("ctrl+enter in the editor reviews the changes", async () => {
    await reviewsWith({ ctrlKey: true });
  });

  it("cmd+enter works too", async () => {
    await reviewsWith({ metaKey: true });
  });

  it("review changes names its key, and the bar says how to leave", async () => {
    await openEditor();
    expect(button("Review changes").getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    expect(screen.getByText((_, el) => el?.textContent ==="Ctrl Enter reviews · Esc leaves the editor")).toBeTruthy();
  });

  it("a held ctrl+enter after a refused plan plans only once", async () => {
    const refused = "An edit can't change the kind, name or namespace. Create a new object with kubectl instead.";
    const calls = serve({
      [DESCRIBE]: [ok(resourceDescribe())],
      [YAML]: [ok({ yaml: BEFORE })],
      "POST /api/actions/plan": [{ status: 422, body: { detail: refused } }],
    });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Edit", tools()));
    const area = (await screen.findByLabelText("Edit Deployment YAML")) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: EDITED } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    expect(await screen.findByText(refused)).toBeTruthy();
    // Still held: the repeats are swallowed, though Review changes could be pressed again.
    for (let i = 0; i < 5; i++) expect(fireEvent.keyDown(area, { key: "Enter", ctrlKey: true, repeat: true })).toBe(false);
    await act(async () => {});
    expect(plans(calls)).toHaveLength(1);
    expect(button("Review changes").disabled).toBe(false);
  });

  it("ctrl+enter with nothing changed does nothing", async () => {
    const { calls, area } = await openEditor({ edit: false });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(area, { key: "Enter", metaKey: true });
    await act(async () => {});
    expect(plans(calls)).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(area);
  });

  it("escape leaves the editor onto review changes", async () => {
    const { area, outside, onClose } = await openEditor();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).toBe(button("Review changes"));
    // Esc stops at the editor: the details stay open with the edit in them.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(outside).not.toHaveBeenCalledWith("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(area.isConnected).toBe(true);
    expect(area.value).toBe(EDITED);
  });

  it("digits do not leave the YAML tab while the editor is open", async () => {
    const { area } = await openEditor();
    const yamlTab = () => screen.getByRole("tab", { name: "YAML" });
    // Ruling R36: after Esc focus sits on the (non-editable) button bar; a digit there keeps the edit.
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).toBe(button("Review changes"));
    expect(fireEvent.keyDown(document.activeElement!, { key: "1" })).toBe(true);
    expect(yamlTab().getAttribute("aria-selected")).toBe("true");
    expect(area.isConnected).toBe(true);
    expect(area.value).toBe(EDITED);
  });

  it("digits never act in an input, the editor or a terminal", async () => {
    const section = () => screen.getByRole("region", { name: /^Details for/ });
    const tabSelected = (name: string) => screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";
    const press = (el: Element) => {
      const ev = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
      act(() => { el.dispatchEvent(ev); });
      return ev.defaultPrevented;
    };
    // The scale form's number input.
    serve({ [DESCRIBE]: [ok(resourceDescribe())] });
    const first = wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    fireEvent.click(button("Scale", tools()));
    expect(press(screen.getByLabelText("Replicas"))).toBe(false);
    expect(tabSelected("Describe")).toBe(true);
    // A terminal inside the details.
    const term = document.createElement("div");
    term.className = "xterm";
    const input = document.createElement("textarea");
    term.append(input);
    section().append(term);
    expect(press(input)).toBe(false);
    expect(tabSelected("Describe")).toBe(true);
    first.unmount();
    // The YAML editor's own field.
    const { area } = await openEditor();
    expect(press(area)).toBe(false);
    expect(tabSelected("YAML")).toBe(true);
  });

  it("with nothing changed escape lands on discard", async () => {
    const { area, outside } = await openEditor({ edit: false });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).toBe(button("Discard"));
    expect(outside).not.toHaveBeenCalledWith("Escape");
  });

  it("left and right move between review changes and discard", async () => {
    const { area } = await openEditor();
    fireEvent.keyDown(area, { key: "Escape" });
    const review = button("Review changes");
    const discard = button("Discard");
    expect(fireEvent.keyDown(review, { key: "ArrowLeft" })).toBe(false);
    expect(document.activeElement).toBe(discard);
    expect(fireEvent.keyDown(discard, { key: "ArrowRight" })).toBe(false);
    expect(document.activeElement).toBe(review);
    // Alt+arrows stay history: not prevented, focus stays.
    expect(fireEvent.keyDown(review, { key: "ArrowLeft", altKey: true })).toBe(true);
    expect(document.activeElement).toBe(review);
  });

  it("escape and arrows never discard", async () => {
    const { area } = await openEditor();
    fireEvent.keyDown(area, { key: "Escape" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(button("Discard"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe(EDITED);
    // Only a press discards.
    expect(document.activeElement).toBe(button("Discard"));
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByLabelText("Edit Deployment YAML")).toBeNull();
    expect(await screen.findByTestId("yaml")).toBeTruthy();
  });

  it("ctrl+enter on discard never discards", async () => {
    const { calls, area } = await openEditor();
    fireEvent.keyDown(area, { key: "Escape" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    const discard = button("Discard");
    expect(document.activeElement).toBe(discard);
    // Held: prevented (so the button is never pressed) and nothing reviewed.
    expect(fireEvent.keyDown(discard, { key: "Enter", ctrlKey: true, repeat: true })).toBe(false);
    expect(fireEvent.keyDown(discard, { key: "Enter", metaKey: true, repeat: true })).toBe(false);
    await act(async () => {});
    expect(plans(calls)).toEqual([]);
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    // Pressed once: it reviews the changes, from anywhere in the editor.
    expect(fireEvent.keyDown(discard, { key: "Enter", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(plans(calls)).toHaveLength(1);
  });

  it("a digit after leaving the editor keeps the edit", async () => {
    const { area } = await openEditor();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).toBe(button("Review changes"));
    await userEvent.keyboard("1");
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe(EDITED);
    expect(screen.getByRole("tab", { name: "YAML" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("focus after a tool closes", () => {
  const REVISIONS = "GET /api/clusters/c1/deployments/demo/web/revisions";
  const notLost = () => {
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.isConnected).toBe(true);
  };
  function details(routes: Record<string, unknown[]> = {}) {
    const calls = serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: "kind: Deployment\n" })], ...routes });
    wrap(
      <ActionsProvider>
        <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} />
      </ActionsProvider>,
    );
    return calls;
  }

  it("discard from the keyboard goes back to the edit button", async () => {
    details();
    const edit = button("Edit", tools());
    edit.focus();
    fireEvent.click(edit);
    const area = await screen.findByLabelText("Edit Deployment YAML");
    await waitFor(() => expect(document.activeElement).toBe(area));
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).toBe(button("Discard"));
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByLabelText("Edit Deployment YAML")).toBeNull();
    notLost();
    expect(document.activeElement).toBe(button("Edit", tools()));
  });

  it("discard after the YAML view's own edit button lands on the YAML tab", async () => {
    details();
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    const panel = screen.getByRole("tabpanel");
    const edit = await within(panel).findByRole("button", { name: "Edit" });
    edit.focus();
    fireEvent.click(edit);
    const area = await screen.findByLabelText("Edit Deployment YAML");
    await waitFor(() => expect(document.activeElement).toBe(area));
    fireEvent.keyDown(area, { key: "Escape" });
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByLabelText("Edit Deployment YAML")).toBeNull();
    notLost();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "YAML" }));
  });

  it("escape in the scale form goes back to the scale button", async () => {
    details();
    const scale = button("Scale", tools());
    scale.focus();
    fireEvent.click(scale);
    const replicas = screen.getByLabelText("Replicas");
    await waitFor(() => expect(document.activeElement).toBe(replicas));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Replicas")).toBeNull();
    notLost();
    expect(document.activeElement).toBe(button("Scale", tools()));
  });

  it("cancel in the scale form goes back to the scale button", async () => {
    details();
    const scale = button("Scale", tools());
    scale.focus();
    fireEvent.click(scale);
    button("Cancel").focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByLabelText("Replicas")).toBeNull();
    notLost();
    expect(document.activeElement).toBe(button("Scale", tools()));
  });

  it("cancel in the rollback form goes back to the roll back button", async () => {
    details({ [REVISIONS]: [ok([{ revision: 2, created_at: null, images: ["web:2"], current: true }, { revision: 1, created_at: null, images: ["web:1"], current: false }])] });
    const rollback = button("Roll back", tools());
    rollback.focus();
    fireEvent.click(rollback);
    await screen.findByRole("radio", { name: /Revision 1/ });
    button("Cancel").focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("form", { name: "Roll back web" })).toBeNull();
    notLost();
    expect(document.activeElement).toBe(button("Roll back", tools()));
  });

  it("an applied edit still focuses what it did", async () => {
    details({
      "POST /api/actions/plan": [ok(plan({ action: "edit", title: "Edit Deployment web", apply_label: "Save", diff: { before: "a\n", after: "b\n" } }))],
      "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Saved Deployment demo/web.", job_id: null, audit_id: 3 })],
    });
    const edit = button("Edit", tools());
    edit.focus();
    fireEvent.click(edit);
    const area = await screen.findByLabelText("Edit Deployment YAML");
    await waitFor(() => expect(document.activeElement).toBe(area));
    fireEvent.input(area, { target: { value: "kind: Deployment\nspec: {}\n" } });
    fireEvent.keyDown(area, { key: "Escape" });
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(button("Save", dialog())));
    await userEvent.keyboard("{Enter}");
    const said = await screen.findByText("Saved Deployment demo/web.");
    await waitFor(() => expect(document.activeElement).toBe(said));
  });
});

describe("an unsaved edit in the details", () => {
  const EDITED = "kind: Deployment\nspec: {}\n";
  async function editing() {
    serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: "kind: Deployment\n" })] });
    const outside = vi.fn();
    const onClose = vi.fn();
    wrap(
      <div onKeyDown={(e) => outside(e.key)}>
        <ActionsProvider>
          <Inspector row={deployment()} provider="aks" kindKey="deployments.apps" verbs={VERBS} onClose={onClose} />
        </ActionsProvider>
      </div>,
    );
    const edit = button("Edit", tools());
    edit.focus();
    fireEvent.click(edit);
    const area = (await screen.findByLabelText("Edit Deployment YAML")) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: EDITED } });
    return { area, outside, onClose };
  }
  const yamlTab = () => screen.getByRole("tab", { name: "YAML" });

  it.each([["End"], ["Home"], ["ArrowRight"], ["ArrowLeft"]])("%s on the YAML tab keeps the edit", async (key) => {
    const { area } = await editing();
    yamlTab().focus();
    expect(fireEvent.keyDown(yamlTab(), { key })).toBe(true);
    expect(yamlTab().getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(yamlTab());
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe(EDITED);
  });

  it("escape on a tool button keeps the details open with the edit", async () => {
    const { area, outside, onClose } = await editing();
    const edit = button("Edit", tools());
    edit.focus();
    fireEvent.keyDown(edit, { key: "Escape" });
    expect(outside).not.toHaveBeenCalledWith("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe(EDITED);
    expect(screen.getByText("Unsaved YAML edit: review or discard it first.")).toBeTruthy();
    expect(document.activeElement).toBe(edit);
  });

  it("escape on the YAML tab keeps the details open with the edit", async () => {
    const { area, outside } = await editing();
    yamlTab().focus();
    fireEvent.keyDown(yamlTab(), { key: "Escape" });
    expect(outside).not.toHaveBeenCalledWith("Escape");
    expect(area.value).toBe(EDITED);
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

  async function deletedReview() {
    const calls = serve({ [DESCRIBE]: [ok(resourceDescribe())], "POST /api/actions/plan": [ok(plan({ action: "delete" }))] });
    const worker = deployment({ name: "worker", uid: "worker" });
    function view(rows: ResourceRow[], active = true, mounted = true, help = false) {
      return <ActionsProvider><button>Elsewhere</button>{mounted && <Table territories={[{ ...territory, rows }]}
        kind={{ ...DEPLOYMENTS, verbs: VERBS }} paneActive={active} onRetry={() => {}} />}{help && <AllShortcuts groups={[]} onClose={() => {}} />}</ActionsProvider>;
    }
    const app = wrap(view([deployment(), worker]));
    const opener = document.querySelector<HTMLElement>("[data-row-key]")!;
    act(() => opener.focus());
    fireEvent.keyDown(opener, { key: "Delete", ctrlKey: true });
    await screen.findByRole("dialog");
    const intervals = vi.spyOn(window, "setInterval");
    const update = (active = true, mounted = true, help = false) => app.rerender(view([worker], active, mounted, help));
    update();
    expect(opener.isConnected).toBe(false);
    return { calls, update, intervals };
  }

  it("deleted opener restores focus after the last review closes", async () => {
    const { calls, intervals } = await deletedReview();
    expect(button("Cancel")).toBe(document.activeElement);
    fireEvent.click(button("Cancel"));
    await act(async () => {});
    expect(document.activeElement?.textContent).toContain("worker");
    expect(document.activeElement?.hasAttribute("data-row-key")).toBe(true);
    expect(intervals.mock.calls.some(([, delay]) => delay === 100)).toBe(false);
    expect(calls.filter(c => c.url.endsWith("/apply"))).toHaveLength(0);
  });

  it("waits for shortcut help when it outlives the deleted opener's review", async () => {
    const { update, calls } = await deletedReview();
    update(true, true, true);
    fireEvent.click(button("Cancel"));
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "All shortcuts" }).contains(document.activeElement)).toBe(true);
    update();
    await act(async () => {});
    expect(document.activeElement?.hasAttribute("data-row-key")).toBe(true);
    expect(calls.some(c => c.url.endsWith("/apply"))).toBe(false);
  });

  it.each(["pane", "focus", "blur", "unmount"])("closing a review never rescues an inactive pane or overrides deliberate focus (%s)", async (loss) => {
    const { update } = await deletedReview();
    if (loss === "pane") { update(false); update(true); }
    if (loss === "unmount") update(true, false);
    fireEvent.click(button("Cancel"));
    if (loss === "focus" || loss === "blur") button("Elsewhere").focus();
    if (loss === "blur") button("Elsewhere").blur();
    await act(async () => {});
    expect(document.activeElement).toBe(loss === "focus" ? button("Elsewhere") : document.body);
  });

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

  /** The table with web's row focused; `routes` add to the describe and YAML. */
  function table(routes: Record<string, unknown[]> = {}) {
    const calls = serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: "kind: Deployment\n" })], ...routes });
    wrap(
      <ActionsProvider>
        <div style={{ height: 600 }}>
          <Table territories={[territory]} kind={{ ...DEPLOYMENTS, verbs: VERBS }} onRetry={() => {}} />
        </div>
      </ActionsProvider>,
    );
    const row = () => document.querySelector<HTMLElement>("[data-row-key]")!;
    act(() => row().focus());
    return { calls, row };
  }
  const detailsShown = () => screen.queryByRole("region", { name: "Details for web" }) !== null;
  const UNSAVED = "Unsaved YAML edit: review or discard it first.";

  it("discard after e on the row goes back to the row", async () => {
    const { row } = table();
    fireEvent.keyDown(row(), { key: "e" });
    const area = await screen.findByLabelText("Edit Deployment YAML");
    await waitFor(() => expect(document.activeElement).toBe(area));
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).toBe(button("Discard"));
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByLabelText("Edit Deployment YAML")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(row());
  });

  it("escape in the scale form after s on the row goes back to the row", async () => {
    const { row } = table();
    fireEvent.keyDown(row(), { key: "s" });
    const replicas = await screen.findByLabelText("Replicas");
    await waitFor(() => expect(document.activeElement).toBe(replicas));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Replicas")).toBeNull();
    expect(detailsShown()).toBe(true);
    expect(document.activeElement).toBe(row());
  });

  it("escape on the row keeps the details and an unsaved edit, and says why", async () => {
    const { row } = table();
    fireEvent.keyDown(row(), { key: "e" });
    const area = (await screen.findByLabelText("Edit Deployment YAML")) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: "kind: Deployment\nspec: {}\n" } });
    act(() => row().focus());
    expect(fireEvent.keyDown(row(), { key: "Escape" })).toBe(false);
    expect(detailsShown()).toBe(true);
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe("kind: Deployment\nspec: {}\n");
    expect(screen.getByText(UNSAVED)).toBeTruthy();
    expect(document.activeElement).toBe(row());
    // From the page too (focus on <main>'s stand-in: nothing focused).
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(detailsShown()).toBe(true);
    expect(area.value).toBe("kind: Deployment\nspec: {}\n");
  });

  it("the unsaved note goes once the edit is discarded", async () => {
    const { row } = table();
    fireEvent.keyDown(row(), { key: "e" });
    const area = await screen.findByLabelText("Edit Deployment YAML");
    fireEvent.input(area, { target: { value: "kind: Deployment\nspec: {}\n" } });
    act(() => row().focus());
    fireEvent.keyDown(row(), { key: "Escape" });
    expect(screen.getByText(UNSAVED)).toBeTruthy();
    fireEvent.click(button("Discard"));
    expect(screen.queryByText(UNSAVED)).toBeNull();
    expect(detailsShown()).toBe(true);
    // Nothing unsaved now: Esc closes the details as before.
    act(() => row().focus());
    fireEvent.keyDown(row(), { key: "Escape" });
    expect(detailsShown()).toBe(false);
  });

  it("the unsaved note goes once the edit is reviewed", async () => {
    const { calls, row } = table({
      "POST /api/actions/plan": [ok(plan({ action: "edit", title: "Edit Deployment web", apply_label: "Save", diff: { before: "a\n", after: "b\n" } }))],
    });
    fireEvent.keyDown(row(), { key: "e" });
    const area = await screen.findByLabelText("Edit Deployment YAML");
    fireEvent.input(area, { target: { value: "kind: Deployment\nspec: {}\n" } });
    act(() => row().focus());
    fireEvent.keyDown(row(), { key: "Escape" });
    expect(screen.getByText(UNSAVED)).toBeTruthy();
    fireEvent.click(button("Review changes"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.queryByText(UNSAVED)).toBeNull();
    expect(calls.filter((c) => c.url.endsWith("/apply"))).toEqual([]);
  });

  it("escape on the row with the editor open but unchanged closes the details", async () => {
    const { row } = table();
    fireEvent.keyDown(row(), { key: "e" });
    await screen.findByLabelText("Edit Deployment YAML");
    act(() => row().focus());
    fireEvent.keyDown(row(), { key: "Escape" });
    expect(detailsShown()).toBe(false);
    expect(screen.queryByText(UNSAVED)).toBeNull();
  });

  it("a held enter on a row neither opens nor closes the details", () => {
    const { row } = table();
    fireEvent.keyDown(row(), { key: "Enter", repeat: true });
    expect(detailsShown()).toBe(false);
    fireEvent.keyDown(row(), { key: "Enter" });
    expect(detailsShown()).toBe(true);
    fireEvent.keyDown(row(), { key: "Enter", repeat: true });
    fireEvent.keyDown(row(), { key: "Enter", repeat: true });
    expect(detailsShown()).toBe(true);
  });
});

describe("an unsaved edit and the row (Ruling R41, extended)", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  const UNSAVED = "Unsaved YAML edit: review or discard it first.";
  const EDITED = "kind: Deployment\nspec: {}\n";
  const editPlan = () => ok(plan({ action: "edit", title: "Edit Deployment web", apply_label: "Save", diff: { before: "a\n", after: "b\n" } }));
  const territory = {
    cluster: { id: "c1", name: "aks-prod-east", context_name: "x", server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null, provider: "aks" as const,
      region: null, environment: "development" as const, state: "ready" as const, message: null },
    state: "ready" as const, message: null, rows: [deployment(), deployment({ uid: "d-2", name: "worker" })], total: 2, failing: 0, pending: 0,
  };
  const rowNamed = (name: string) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-row-key]")).find((r) => r.textContent?.includes(name))!;
  const web = () => rowNamed("web");
  const selected = (el: HTMLElement) => el.getAttribute("aria-selected") === "true";
  const detailsFor = (name: string) => screen.queryByRole("region", { name: "Details for " + name }) !== null;
  let offDocument = () => {};
  afterEach(() => offDocument());

  /** The table (rows opted in to the kind arrows, as in the console) with web's YAML being edited. */
  async function editingOnTheRow({ edit = true, routes = {} as Record<string, unknown[]> } = {}) {
    const calls = serve({ [DESCRIBE]: [ok(resourceDescribe())], [YAML]: [ok({ yaml: "kind: Deployment\n" })], ...routes });
    // What a document listener (the kind strip's) sees: the key, and whether it was prevented.
    const documentKeys = vi.fn();
    const onDocument = (e: KeyboardEvent) => documentKeys(e.key, e.defaultPrevented);
    document.addEventListener("keydown", onDocument);
    offDocument = () => document.removeEventListener("keydown", onDocument);
    const ui = (request: RowRequest | null) => (
      <ActionsProvider>
        <div style={{ height: 600 }} data-kind-row-keys="">
          <Table territories={[territory]} kind={{ ...DEPLOYMENTS, verbs: VERBS }} onRetry={() => {}} request={request} />
        </div>
      </ActionsProvider>
    );
    const view = wrap(ui(null));
    let seq = 0;
    /** The palette asks for `action` on the row with `uid`. */
    const ask = (action: RowRequest["action"], uid: string) => view.rerender(ui({ key: "c1/" + uid, action, seq: ++seq }));
    act(() => web().focus());
    fireEvent.keyDown(web(), { key: "e" });
    const area = (await screen.findByLabelText("Edit Deployment YAML")) as HTMLTextAreaElement;
    if (edit) fireEvent.input(area, { target: { value: EDITED } });
    act(() => web().focus());
    return { calls, area, documentKeys, ask };
  }

  it("enter on the row keeps the details and the edit, and says why", async () => {
    const { area } = await editingOnTheRow();
    expect(fireEvent.keyDown(web(), { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(web(), { key: "d" })).toBe(false);
    expect(detailsFor("web")).toBe(true);
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe(EDITED);
    expect(screen.getByText(UNSAVED)).toBeTruthy();
  });

  it("down on the row keeps the selection and the edit, and says why", async () => {
    const { area } = await editingOnTheRow();
    expect(fireEvent.keyDown(web(), { key: "ArrowDown" })).toBe(false);
    fireEvent.keyDown(web(), { key: "ArrowDown", repeat: true });
    fireEvent.keyDown(web(), { key: "ArrowUp" });
    expect(selected(web())).toBe(true);
    expect(selected(rowNamed("worker"))).toBe(false);
    expect(detailsFor("web")).toBe(true);
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe(EDITED);
    expect(screen.getByText(UNSAVED)).toBeTruthy();
    expect(document.activeElement).toBe(web());
  });

  it("page, home and end keys on the row never move the selection", async () => {
    const { area } = await editingOnTheRow();
    for (const key of ["PageDown", "PageUp", "End", "Home"]) fireEvent.keyDown(web(), { key });
    expect(selected(web())).toBe(true);
    expect(area.value).toBe(EDITED);
  });

  it("a tool key on the row keeps the edit, and says why", async () => {
    const { calls, area } = await editingOnTheRow();
    fireEvent.keyDown(web(), { key: "s" });
    fireEvent.keyDown(web(), { key: "r" });
    fireEvent.keyDown(web(), { key: "d", ctrlKey: true });
    await act(async () => {});
    expect(screen.queryByLabelText("Replicas")).toBeNull();
    expect(calls.filter((c) => c.url === "/api/actions/plan")).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Edit Deployment YAML")).toBe(area);
    expect(area.value).toBe(EDITED);
    expect(screen.getByText(UNSAVED)).toBeTruthy();
  });

  it("the palette asking for another row keeps the selection and the edit, and says why", async () => {
    const { area, ask } = await editingOnTheRow();
    ask("details", "d-2");
    expect(selected(web())).toBe(true);
    expect(detailsFor("worker")).toBe(false);
    expect(area.value).toBe(EDITED);
    expect(screen.getByText(UNSAVED)).toBeTruthy();
    // On the edited row itself it is not a move: the YAML tab stays, and so does the edit.
    ask("yaml", "d-1");
    expect(area.value).toBe(EDITED);
  });

  it("the kind arrows on the row never switch kinds away from the edit", async () => {
    const { documentKeys } = await editingOnTheRow();
    fireEvent.keyDown(web(), { key: "ArrowRight" });
    // The kind strip listens on the document and ignores a prevented key (`pageKey`).
    expect(documentKeys).toHaveBeenCalledWith("ArrowRight", true);
    expect(screen.getByText(UNSAVED)).toBeTruthy();
  });

  it("after discard, the arrows, down and enter work as before", async () => {
    const { area, documentKeys } = await editingOnTheRow();
    fireEvent.keyDown(area, { key: "Escape" });
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(button("Discard"));
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByLabelText("Edit Deployment YAML")).toBeNull();
    act(() => web().focus());
    fireEvent.keyDown(web(), { key: "ArrowRight" });
    expect(documentKeys).toHaveBeenCalledWith("ArrowRight", false);
    fireEvent.keyDown(web(), { key: "ArrowDown" });
    await waitFor(() => expect(selected(rowNamed("worker"))).toBe(true));
    expect(detailsFor("worker")).toBe(true);
    expect(screen.queryByText(UNSAVED)).toBeNull();
    act(() => rowNamed("worker").focus());
    fireEvent.keyDown(rowNamed("worker"), { key: "Enter" });
    expect(detailsFor("worker")).toBe(false);
  });

  it("with the editor unchanged, enter closes the details", async () => {
    await editingOnTheRow({ edit: false });
    fireEvent.keyDown(web(), { key: "Enter" });
    expect(detailsFor("web")).toBe(false);
    expect(screen.queryByText(UNSAVED)).toBeNull();
  });

  it("with the editor unchanged, down moves the selection", async () => {
    await editingOnTheRow({ edit: false });
    fireEvent.keyDown(web(), { key: "ArrowDown" });
    await waitFor(() => expect(selected(rowNamed("worker"))).toBe(true));
    expect(screen.queryByText(UNSAVED)).toBeNull();
  });

  it("after an applied review, down moves the selection", async () => {
    const { area } = await editingOnTheRow({
      routes: {
        "POST /api/actions/plan": [editPlan()],
        "POST /api/actions/p1/apply": [ok({ outcome: "succeeded", message: "Saved Deployment demo/web.", job_id: null, audit_id: 3 })],
      },
    });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Save", dialog()));
    await screen.findByText("Saved Deployment demo/web.");
    act(() => web().focus());
    fireEvent.keyDown(web(), { key: "ArrowDown" });
    await waitFor(() => expect(selected(rowNamed("worker"))).toBe(true));
  });

  it("a cancelled review leaves the edit unsaved, so down still keeps it", async () => {
    const { area } = await editingOnTheRow({ routes: { "POST /api/actions/plan": [editPlan()] } });
    fireEvent.keyDown(area, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(button("Cancel", dialog()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => web().focus());
    fireEvent.keyDown(web(), { key: "ArrowDown" });
    expect(selected(web())).toBe(true);
    expect(area.value).toBe(EDITED);
    expect(screen.getByText(UNSAVED)).toBeTruthy();
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
