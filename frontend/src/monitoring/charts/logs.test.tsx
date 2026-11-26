import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChartView from "./index";
import { dataOf, fakeBox, logLine, panelOf, RANGE } from "./panelFixtures";
import { logTime } from "./LogsChart";

beforeEach(() => fakeBox(300));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const draw = (logs: ReturnType<typeof logLine>[], options: Record<string, unknown> = {}) =>
  render(<ChartView panel={panelOf("logs", options)} data={dataOf([], { logs })} range={RANGE} animate={false} changeId={0} />);

describe("logs panel", () => {
  it("lists newest first with times, and Enter expands labels", () => {
    draw([logLine(1, "first"), logLine(2, "second", { labels: { app: "cart", pod: "p-1" } })]);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("second");
    expect(items[1].textContent).toContain("first");
    expect(items[0].querySelector("time")!.textContent).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
    expect(items[0].hasAttribute("aria-expanded")).toBe(false);
    fireEvent.keyDown(items[0], { key: "Enter" });
    expect(screen.getByText("cart")).toBeTruthy();
    const strip = document.getElementById(items[0].getAttribute("aria-describedby")!)!;
    expect(strip.textContent).toContain("cart");
    expect(strip.getAttribute("role")).toBe("status");
    fireEvent.keyDown(items[0], { key: "Enter" });
    expect(screen.queryByText("cart")).toBeNull();
  });

  it("orders oldest first when asked", () => {
    draw([logLine(1, "first"), logLine(2, "second")], { order: "oldest" });
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("first");
  });

  it("a group adds the project to each line", () => {
    draw([logLine(1, "boom", { projectName: "Shop" })]);
    expect(screen.getByRole("listitem").textContent).toContain("Shop boom");
  });

  it("formats the time in local time to the millisecond", () => {
    const ms = new Date(2024, 0, 2, 3, 4, 5, 67).getTime();
    expect(logTime(`${ms}000000`)).toBe("03:04:05.067");
  });

  it("moves focus with the arrow keys and keeps the focused line mounted", () => {
    const logs = Array.from({ length: 400 }, (_, i) => logLine(i, `line ${i}`));
    draw(logs, { wrap: false });
    expect(screen.getAllByRole("listitem").length).toBeLessThan(60);
    const first = screen.getAllByRole("listitem")[0];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getAllByRole("listitem")[1]);
    const list = screen.getByRole("list");
    list.scrollTop = 22 * 300;
    fireEvent.scroll(list);
    expect(screen.getAllByRole("listitem").some((el) => el === document.activeElement)).toBe(true);
  });

  it("draws no old lines when the panel is unreachable", () => {
    render(
      <ChartView panel={panelOf("logs")} data={dataOf([], { logs: [logLine(1, "old")], state: "unreachable" })} range={RANGE} animate={false} changeId={0} />,
    );
    expect(screen.queryByText(/old/)).toBeNull();
  });

  const panel = (options: Record<string, unknown> = {}) => panelOf("logs", options);
  const view = (logs: ReturnType<typeof logLine>[], options: Record<string, unknown> = {}, state: "ready" | "empty" | "error" = "ready") => (
    <ChartView panel={panel(options)} data={dataOf([], { logs, state })} range={RANGE} animate={false} changeId={0} />
  );
  const burst = (n: number, from = 0) => Array.from({ length: n }, (_, i) => logLine(from + i, `line ${from + i}`));

  it("draws the rows for its height after an empty answer and after an error", () => {
    const { rerender } = render(view([], {}, "empty"));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    rerender(view(burst(400)));
    const n = screen.getAllByRole("listitem").length;
    expect(n).toBeGreaterThanOrEqual(13);
    expect(n).toBeLessThan(35);
    rerender(view(burst(400), {}, "error"));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    rerender(view(burst(400)));
    expect(screen.getAllByRole("listitem").length).toBeLessThan(35);
  });

  it("virtualizes wrapped lines too", () => {
    render(view(burst(400), { wrap: true }));
    expect(screen.getAllByRole("listitem").length).toBeLessThan(40);
  });

  it("keeps focus on the same line when a refresh shifts the list", () => {
    const { rerender } = render(view(burst(5)));
    const items = screen.getAllByRole("listitem");
    items[1].focus(); // line 3 (newest first: 4, 3, 2, 1, 0)
    expect(items[1].textContent).toContain("line 3");
    rerender(view(burst(8)));
    expect(document.activeElement?.textContent).toContain("line 3");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("moves focus to a neighbour when the focused line rolls off", () => {
    const { rerender } = render(view(burst(5)));
    const oldest = screen.getAllByRole("listitem")[4];
    oldest.focus();
    expect(oldest.textContent).toContain("line 0");
    rerender(view(burst(5, 3))); // lines 3..7: line 0 is gone
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getAllByRole("listitem")).toContain(document.activeElement);
  });

  it("a click opens a line", () => {
    draw([logLine(1, "first"), logLine(2, "second", { labels: { app: "cart" } })]);
    const items = screen.getAllByRole("listitem");
    fireEvent.click(items[0]);
    expect(items[0].getAttribute("data-open")).toBe("true");
    expect(within(screen.getByRole("status")).getByText("cart")).toBeTruthy();
    fireEvent.click(items[0]);
    expect(within(screen.getByRole("status")).queryByText("cart")).toBeNull();
  });

  it("a click that ended a text selection does not open the line", () => {
    draw([logLine(1, "select me please")]);
    const item = screen.getByRole("listitem");
    const range = document.createRange();
    range.selectNodeContents(item.querySelector("span")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(item);
    expect(item.getAttribute("data-open")).toBeNull();
    window.getSelection()!.removeAllRanges();
  });

  it("an opened line shows its full text before its labels", () => {
    const long = "x".repeat(300);
    draw([logLine(1, long, { labels: { app: "cart" } })], { wrap: false });
    fireEvent.click(screen.getByRole("listitem"));
    const strip = screen.getByRole("status");
    const full = within(strip).getByText(long);
    const label = within(strip).getByText("cart");
    expect(full.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(strip).getByRole("button", { name: "Copy line" })).toBeTruthy();
  });

  it("Copy line copies the text, and says when it can't", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    draw([logLine(1, "copy this line")]);
    fireEvent.click(screen.getByRole("listitem"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy line" })); });
    expect(writeText).toHaveBeenCalledWith("copy this line");
    expect(screen.getByText("Copied")).toBeTruthy();
    writeText.mockRejectedValue(new Error("no"));
    cleanup();
    draw([logLine(1, "copy this line")]);
    fireEvent.click(screen.getByRole("listitem"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy line" })); });
    expect(screen.getByText("Couldn't copy")).toBeTruthy();
  });

  it("Esc on an opened line closes it and puts focus back on the line", () => {
    draw([logLine(1, "first")]);
    const item = screen.getByRole("listitem");
    fireEvent.click(item);
    screen.getByRole("button", { name: "Copy line" }).focus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Copy line" }), { key: "Escape" });
    expect(item.getAttribute("data-open")).toBeNull();
    expect(document.activeElement).toBe(item);
  });

  it("lines from several Pods carry a Pod tag", () => {
    draw([
      logLine(1, "a", { labels: { k8s_pod_name: "api-7d9f", pod: "ignored" } }),
      logLine(2, "b", { labels: { k8s_pod_name: "a-very-long-pod-name-that-is-cut" } }),
    ]);
    const tags = document.querySelectorAll("[title]");
    const titles = [...tags].map((t) => t.getAttribute("title"));
    expect(titles).toContain("k8s_pod_name=api-7d9f");
    expect(screen.getByText("api-7d9f")).toBeTruthy();
    const long = screen.getByText(/^a-very-long-pod-/);
    expect(long.textContent!.length).toBeLessThanOrEqual(18);
    expect(long.getAttribute("title")).toBe("k8s_pod_name=a-very-long-pod-name-that-is-cut");
  });

  it("one stream shows no tags", () => {
    draw([logLine(1, "a", { labels: { k8s_pod_name: "api-7d9f" } }), logLine(2, "b", { labels: { k8s_pod_name: "api-7d9f" } })]);
    expect(screen.queryByText("api-7d9f")).toBeNull();
  });
});
