// frontend/src/features/palette/palette.test.tsx — the palette inside the real console.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KindsResponse, Plan } from "../../api/types";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { Console } from "../../App";
import { describeBody } from "../../test/describe";
import { KINDS, PODS } from "../../test/kinds";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const cluster = { id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://127.0.0.1:6443", original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null };
const pod = { uid: "p1", cluster_id: "c1", kind: "Pod", namespace: "demo", name: "crasher-1", created_at: null, labels: {}, columns: { status: "CrashLoopBackOff", status_class: "bad", node: "n1", resource_version: "7" } };
const VERBS = ["get", "list", "watch", "update", "patch", "delete"];
const SERVED: KindsResponse = { ...KINDS, kinds: KINDS.kinds.map((k) => (k.key === "pods" ? { ...PODS, verbs: VERBS, short_names: ["po"] } : k)) };

const plan: Plan = {
  plan_id: "p1", action: "delete", target: { cluster_id: "c1", kind_key: "pods", namespace: "demo", name: "crasher-1" }, kind: "Pod",
  cluster: { id: "c1", name: "kind-omnikrux-dev", provider: "kind", environment: "development" },
  title: "Delete Pod crasher-1", summary: ["Delete Pod demo/crasher-1."], warnings: [], blocked: [], diff: null,
  confirm_text: null, apply_label: "Delete", expires_at: "2026-11-08T10:05:00Z",
};

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

let calls: { url: string; method: string }[] = [];

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  FakeWebSocket.instances = [];
  calls = [];
  kindsAnswer = () => json(SERVED);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith("/api/kinds")) return kindsAnswer();
    if (url === "/api/port-forwards") return json([]);
    if (url === "/api/actions/plan") return json(plan);
    if (url.startsWith("/api/clusters/c1/pods/")) return json(describeBody());
    return json([cluster]);
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let kindsAnswer: () => Promise<Response> = () => json(SERVED);

async function renderConsole({ waitForKinds = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Console />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(FakeWebSocket.instances.some((w) => w.params.get("kind") === "pods")).toBe(true));
  const pods = FakeWebSocket.instances.find((w) => w.params.get("kind") === "pods")!;
  act(() => {
    pods.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    pods.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod] });
  });
  await screen.findByText("crasher-1");
  // The kinds have loaded once the everyday tabs show.
  if (waitForKinds) await screen.findByRole("tab", { name: "Deployments" });
}

const palette = () => screen.queryByRole("dialog", { name: /^Commands|^Jump to a kind/ });
const input = () => within(palette()!).getByRole("combobox");
const label = (o: Element) => o.querySelector("[data-part=label]")?.textContent ?? null;
const options = () => within(palette()!).queryAllByRole("option").map(label);
const ctrlK = (target: Element = document.body) => fireEvent.keyDown(target, { key: "k", ctrlKey: true });

describe("command palette", () => {
  it("ctrl k opens the palette and esc restores focus", async () => {
    await renderConsole();
    const row = screen.getByText("crasher-1").closest('[role="row"]') as HTMLElement;
    row.focus();
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true); // the browser's own Ctrl K doesn't fire
    expect(palette()!.getAttribute("aria-label")).toBe("Commands");
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(palette()).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("the top bar's box and the all-kinds button open it too", async () => {
    await renderConsole();
    fireEvent.click(screen.getByRole("button", { name: /Commands/ }));
    expect(palette()!.getAttribute("aria-label")).toBe("Commands");
    fireEvent.keyDown(input(), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /^All 8 kinds/ }));
    expect(palette()!.getAttribute("aria-label")).toBe("Jump to a kind");
  });

  it("colon opens kind mode and deploy enter jumps to deployments", async () => {
    await renderConsole();
    fireEvent.keyDown(document.body, { key: ":" });
    expect(palette()!.getAttribute("aria-label")).toBe("Jump to a kind");
    expect(palette()!.querySelector("[class*=prompt]")!.textContent).toBe(":");
    // Kind mode lists kinds only.
    expect(options()).toContain("Deployments");
    expect(options()).not.toContain("Audit log");
    fireEvent.change(input(), { target: { value: "deploy" } });
    expect(options()[0]).toBe("Deployments");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(palette()).toBeNull();
    expect(window.location.hash).toBe("#kind=deployments.apps");
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Deployments"));
    // The row that had focus went with the pods; focus lands on the kind you jumped to.
    expect(document.activeElement).toBe(screen.getByRole("tab", { selected: true }));
  });

  it("says when the kinds are still loading, and when they can't be loaded", async () => {
    kindsAnswer = () => new Promise<Response>(() => {});
    await renderConsole({ waitForKinds: false });
    fireEvent.keyDown(document.body, { key: ":" });
    expect(within(palette()!).getByRole("status").textContent).toBe("Loading the list of kinds…");
    fireEvent.keyDown(input(), { key: "Escape" });
    ctrlK();
    fireEvent.change(input(), { target: { value: "deploy" } });
    // Not "try a kind's short name, like deploy": kinds can't match yet.
    expect(within(palette()!).getByRole("status").textContent).toBe("Nothing matches “deploy” yet: the list of kinds is still loading.");
    cleanup();
    FakeWebSocket.instances = [];

    kindsAnswer = () => Promise.resolve(new Response(JSON.stringify({ detail: "Discovery failed on every cluster." }), { status: 500, headers: { "content-type": "application/json" } }));
    await renderConsole({ waitForKinds: false });
    await screen.findByText(/Can't load the list of kinds/);
    fireEvent.keyDown(document.body, { key: ":" });
    expect(within(palette()!).getByRole("alert").textContent).toBe("Can't load the list of kinds: Discovery failed on every cluster.");
    fireEvent.keyDown(input(), { key: "Escape" });
    ctrlK();
    fireEvent.change(input(), { target: { value: "deploy" } });
    expect(within(palette()!).getByRole("alert").textContent).toBe(
      "Nothing matches “deploy”. Kinds aren't listed: can't load the list of kinds: Discovery failed on every cluster.",
    );
  });

  it("a click on the palette's frame keeps focus in its field, so Esc still closes it", async () => {
    await renderConsole();
    ctrlK();
    const box = palette()!;
    for (const part of [box.querySelector("[class*=foot]")!, box.querySelector("[class*=groupTitle]")!, box]) {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      part.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
    }
    // The field itself still takes clicks (to place the caret).
    const onField = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    input().dispatchEvent(onField);
    expect(onField.defaultPrevented).toBe(false);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(palette()).toBeNull();
  });

  it("arrows move the choice and enter runs it; a leading colon narrows to kinds", async () => {
    await renderConsole();
    ctrlK();
    fireEvent.change(input(), { target: { value: ":s" } });
    expect(options().every((o) => !/Audit/.test(o ?? ""))).toBe(true);
    // The typed colon is in the field already: the prompt doesn't show a second one.
    const prompt = () => palette()!.querySelector("[class*=prompt]")!.textContent;
    expect(prompt()).toBe("›");
    fireEvent.change(input(), { target: { value: "audit" } });
    expect(options()[0]).toBe("Audit log");
    fireEvent.change(input(), { target: { value: "e" } });
    const first = options()[0];
    const second = options()[1];
    const active = () => within(palette()!).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
    expect(label(active()!)).toBe(first);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(label(active()!)).toBe(second);
    expect(input().getAttribute("aria-activedescendant")).toBe(active()!.id);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" }); // wraps to the last
    expect(active()).toBe(within(palette()!).getAllByRole("option").at(-1));
  });

  it("row actions appear for the selected row and open the same review, never applying", async () => {
    await renderConsole();
    fireEvent.click(screen.getByText("crasher-1"));
    ctrlK();
    expect(options()).toEqual(expect.arrayContaining(["Shell in crasher-1", "Logs of crasher-1", "Delete crasher-1…"]));
    // The actions say which cluster and namespace they act on.
    expect(within(palette()!).getByRole("group", { name: /Actions/ }).textContent).toContain("kind-omnikrux-dev");
    fireEvent.change(input(), { target: { value: "delete" } });
    expect(options()[0]).toBe("Delete crasher-1…");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(palette()).toBeNull();
    const review = await screen.findByRole("dialog", { name: /Delete Pod crasher-1/ });
    expect(review).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/actions/plan")).toBe(true);
    expect(calls.some((c) => c.url.includes("/apply"))).toBe(false);
  });

  it("keys typed in inputs, the editor and the terminal are ignored", async () => {
    await renderConsole();
    const filter = screen.getByPlaceholderText(/Filter by name/);
    filter.focus();
    fireEvent.keyDown(filter, { key: ":" });
    ctrlK(filter);
    expect(palette()).toBeNull();

    // The YAML editor (CodeMirror's contenteditable) and a terminal (xterm's textarea).
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const term = document.createElement("div");
    term.className = "xterm";
    const helper = document.createElement("textarea");
    term.append(helper);
    document.body.append(editor, term);
    for (const el of [editor, helper]) {
      el.focus();
      fireEvent.keyDown(el, { key: ":" });
      const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false); // the terminal keeps its Ctrl K (kill line)
      expect(palette()).toBeNull();
    }
    editor.remove();
    term.remove();
  });
});
