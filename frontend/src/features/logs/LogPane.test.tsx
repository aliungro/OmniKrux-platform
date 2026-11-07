import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LogLine, LogSession } from "../../api/types";
import { FakeWebSocket } from "./fakeWebSocket";
import { LogPane } from "./LogPane";

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // jsdom has no layout; give everything a size so the virtualizer renders rows.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const session = (over: Partial<LogSession> = {}): LogSession => ({
  clusterId: "c1",
  clusterName: "aks-prod-weu",
  provider: "aks",
  namespace: "payments",
  pod: "payments-api-xk2pq",
  container: "payments-api",
  containers: ["payments-api", "istio-proxy"],
  ...over,
});

const line = (i: number, text = `line ${i}`): LogLine => ({
  pod: "payments-api-xk2pq",
  container: "payments-api",
  ts: `2026-11-07T14:04:${String(i % 60).padStart(2, "0")}.000Z`,
  text,
});

function send(lines: LogLine[], ws = FakeWebSocket.last) {
  act(() => {
    for (let at = 0; at < lines.length; at += 500) ws.emit({ type: "lines", lines: lines.slice(at, at + 500) });
  });
}

const rows = () => document.querySelectorAll("[data-seq]");
const logArea = () => screen.getByRole("log");

/** jsdom scrolls nothing: give the log area a scroll position and height the test controls. */
function fakeScroll(el: HTMLElement, scrollHeight: number) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; },
  });
  return {
    get top() { return top; },
    scrollTo(v: number) {
      top = v;
      fireEvent.scroll(el);
    },
  };
}

describe("LogPane", () => {
  it("names the cluster, namespace, pod and container", () => {
    render(<LogPane session={session()} />);
    const header = screen.getByRole("region", { name: "Logs for payments-api-xk2pq" }).querySelector("header") as HTMLElement;
    expect(within(header).getByText("AKS")).toBeTruthy();
    expect(header.textContent).toContain("aks-prod-weu / payments / payments-api-xk2pq");
    expect((within(header).getByRole("combobox", { name: "Container" }) as HTMLSelectElement).value).toBe("payments-api");
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(
      "/api/clusters/c1/pods/payments/payments-api-xk2pq/logs/download?container=payments-api&previous=false");
  });

  it("scrolling up pauses follow; jump to live resumes", async () => {
    render(<LogPane session={session()} />);
    send(Array.from({ length: 1000 }, (_, i) => line(i)));
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const follow = screen.getByRole("button", { name: "Follow" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /Jump to live/ })).toBeNull();

    const scroll = fakeScroll(logArea(), 20_000);
    scroll.scrollTo(19_400); // at the bottom: still following
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    scroll.scrollTo(12_000); // the reader scrolls up
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Jump to live/ })).toBeTruthy();

    // New lines don't drag a paused reader back down.
    send([line(1000)]);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(scroll.top).toBe(12_000);

    fireEvent.keyDown(logArea(), { key: "G" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    expect(scroll.top).toBe(20_000);
    expect(screen.queryByRole("button", { name: /Jump to live/ })).toBeNull();

    // The Follow toggle pauses, and the jump button resumes, too.
    fireEvent.click(follow);
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /Jump to live/ }));
    expect(follow.getAttribute("aria-pressed")).toBe("true");
  });

  it("previous toggle reopens with previous=true", () => {
    render(<LogPane session={session()} />);
    const first = FakeWebSocket.last;
    expect(first.params.get("previous")).toBe("false");
    expect(first.params.get("follow")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(first.closedByClient).toBe(true);
    const reopened = FakeWebSocket.last;
    expect(reopened).not.toBe(first);
    expect(reopened.params.get("previous")).toBe("true");
    expect(reopened.params.get("follow")).toBe("false");
    expect(reopened.params.get("container")).toBe("payments-api");
    expect(screen.getByRole("button", { name: "Previous" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toContain("previous=true");

    fireEvent.change(screen.getByRole("combobox", { name: "Container" }), { target: { value: "istio-proxy" } });
    expect(FakeWebSocket.last.params.get("container")).toBe("istio-proxy");
    expect(FakeWebSocket.last.params.get("previous")).toBe("true");
  });

  it("renders 100000 pushed lines with under 200 DOM rows", async () => {
    render(<LogPane session={session()} />);
    send(Array.from({ length: 100_000 }, (_, i) => line(i)));
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(rows().length).toBeLessThan(200);
    expect(screen.getByText("Showing the last 50,000 lines (50,000 older lines not kept)")).toBeTruthy();
  });

  it("search counts matches, highlights them and moves with Enter", async () => {
    render(<LogPane session={session()} />);
    send([
      line(0, "Starting payments-api"),
      line(1, "java.lang.OutOfMemoryError: Java heap space"),
      line(2, "Loading merchant cache"),
      line(3, "java.lang.OutOfMemoryError: Java heap space"),
    ]);
    await waitFor(() => expect(rows().length).toBe(4));
    const search = screen.getByRole("searchbox", { name: "Search logs" });
    fireEvent.change(search, { target: { value: "outofmemory" } });
    expect(screen.getByText("0 of 2")).toBeTruthy();
    expect(document.querySelectorAll("mark")).toHaveLength(2);

    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByText("2 of 2")).toBeTruthy();
    const current = document.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain("OutOfMemoryError");
    expect(current?.getAttribute("data-seq")).toBe("3");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("1 of 2")).toBeTruthy();
    // Moving to a match stops following, so the view stays on it.
    expect(screen.getByRole("button", { name: "Follow" }).getAttribute("aria-pressed")).toBe("false");

    // Ctrl F focuses the search box.
    search.blur();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(search);
  });

  it("styles markers as separators and shows the server's error", async () => {
    render(<LogPane session={session()} />);
    act(() => {
      FakeWebSocket.last.emit({ type: "status", state: "streaming", message: null });
      FakeWebSocket.last.emit({ type: "lines", lines: [line(0), { marker: "Container restarted at 2026-11-07T14:08:24Z, restart 14" }, line(1)] });
    });
    const marker = await screen.findByText("Container restarted at 2026-11-07T14:08:24Z, restart 14");
    expect(marker.closest("[data-seq]")?.getAttribute("data-kind")).toBe("marker");

    const message = "Pod payments/payments-api-xk2pq not found. It may have been deleted; pick it again from the list.";
    act(() => {
      FakeWebSocket.last.emit({ type: "status", state: "error", message });
      FakeWebSocket.last.drop(1011);
    });
    expect(screen.getByRole("alert").textContent).toBe(`${message}Try again`);
  });

  it("an error offers Try again, which reopens the stream", async () => {
    render(<LogPane session={session()} />);
    const message = "Lost the log stream after 5 attempts: Can't reach the cluster.";
    act(() => {
      FakeWebSocket.last.emit({ type: "status", state: "error", message });
      FakeWebSocket.last.drop(1011);
    });
    expect(screen.getByRole("alert").textContent).toContain(message);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a match in the last screenful stays in view on a live log", async () => {
    render(<LogPane session={session()} />);
    send(Array.from({ length: 1000 }, (_, i) => line(i, i === 995 ? "panic: just now" : `line ${i}`)));
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const scroll = fakeScroll(logArea(), 20_000);
    const follow = screen.getByRole("button", { name: "Follow" });
    const search = screen.getByRole("searchbox", { name: "Search logs" });
    fireEvent.change(search, { target: { value: "panic" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(follow.getAttribute("aria-pressed")).toBe("false");

    // Centering a match near the end clamps the scroll to the bottom: that's not the reader.
    scroll.scrollTo(19_400);
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    send([line(1000)]);
    expect(scroll.top).toBe(19_400);

    // The reader scrolling down to the bottom themselves does turn follow back on.
    fireEvent.wheel(logArea(), { deltaY: 100 });
    scroll.scrollTo(19_400);
    expect(follow.getAttribute("aria-pressed")).toBe("true");
  });

  it("Ctrl F inside a shell stays with the shell", () => {
    render(<LogPane session={session()} />);
    const term = document.createElement("div");
    term.className = "xterm";
    const input = document.createElement("textarea");
    term.appendChild(input);
    document.body.appendChild(term);
    try {
      input.focus();
      const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(input);
    } finally {
      term.remove();
    }
  });
});
