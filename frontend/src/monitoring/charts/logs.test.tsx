import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChartView from "./index";
import { dataOf, logLine, panelOf, RANGE } from "./panelFixtures";
import { logTime } from "./LogsChart";

afterEach(cleanup);
const draw = (logs: ReturnType<typeof logLine>[], options: Record<string, unknown> = {}) =>
  render(<ChartView panel={panelOf("logs", options)} data={dataOf([], { logs })} range={RANGE} animate={false} changeId={0} />);

describe("logs panel", () => {
  it("lists newest first with times, and Enter expands labels", () => {
    draw([logLine(1, "first"), logLine(2, "second", { labels: { app: "cart", pod: "p-1" } })]);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("second");
    expect(items[1].textContent).toContain("first");
    expect(items[0].querySelector("time")!.textContent).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
    expect(items[0].getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(items[0], { key: "Enter" });
    expect(items[0].getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("cart")).toBeTruthy();
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
});
