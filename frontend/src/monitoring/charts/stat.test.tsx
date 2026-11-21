import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChartView, { type ChartViewProps } from "./index";
import { dataOf, panelOf, RANGE, series, stubMotion } from "./panelFixtures";

const tweenMock = vi.hoisted(() => vi.fn((_ms: number, _on: (k: number) => void) => () => {}));
vi.mock("./motion", async (importOriginal) => ({ ...(await importOriginal<typeof import("./motion")>()), tween: tweenMock }));

const view = (over: Partial<ChartViewProps> & { value?: number; options?: Record<string, unknown> }) => {
  const { value = 10, options = {}, ...rest } = over;
  return (
    <ChartView
      panel={panelOf("stat", { unit: "none", sparkline: false, ...options })}
      data={dataOf([series("a", [value])])}
      range={RANGE}
      animate
      changeId={0}
      {...rest}
    />
  );
};

beforeEach(() => {
  tweenMock.mockClear();
  stubMotion(false);
});
afterEach(cleanup);

describe("stat panel", () => {
  it("counts up after an edit", () => {
    const { rerender } = render(view({ value: 10 }));
    expect(screen.getByText("10")).toBeTruthy();
    rerender(view({ value: 20, changeId: 1 }));
    expect(tweenMock).toHaveBeenCalledTimes(1);
    act(() => tweenMock.mock.calls[0][1](0.5));
    const mid = Number(document.querySelector("[data-tone]")!.textContent);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(20);
    act(() => tweenMock.mock.calls[0][1](1));
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("jumps on a refresh and without animate", () => {
    const first = render(view({ value: 10 }));
    first.rerender(view({ value: 20 })); // a refresh: same changeId and editId
    expect(screen.getByText("20")).toBeTruthy();
    first.rerender(view({ value: 30, changeId: 1, animate: false }));
    expect(screen.getByText("30")).toBeTruthy();
    expect(tweenMock).not.toHaveBeenCalled();
  });

  it("jumps under reduced motion", () => {
    stubMotion(true);
    const { rerender } = render(view({ value: 10 }));
    rerender(view({ value: 20, changeId: 1 }));
    expect(screen.getByText("20")).toBeTruthy();
    expect(tweenMock).not.toHaveBeenCalled();
  });

  it("counts after a query edit seen only in the data", () => {
    const panel = panelOf("stat", { sparkline: false });
    const { rerender } = render(<ChartView panel={panel} data={dataOf([series("a", [1])])} range={RANGE} animate changeId={0} />);
    rerender(<ChartView panel={panel} data={dataOf([series("a", [5])], { editId: 1 })} range={RANGE} animate changeId={0} />);
    expect(tweenMock).toHaveBeenCalledTimes(1);
  });

  it("colours by threshold", () => {
    render(view({ value: 2, options: { thresholds: [{ value: 1, color: "bad" }] } }));
    expect(document.querySelector('[data-tone="bad"]')).toBeTruthy();
  });

  it("names each series when there are several and stops at six", () => {
    const many = Array.from({ length: 8 }, (_, i) => series(`s${i}`, [i]));
    render(<ChartView panel={panelOf("stat", { sparkline: true })} data={dataOf(many)} range={RANGE} animate={false} changeId={0} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("s0")).toBeTruthy();
    expect(screen.getByText("Showing 6 of 8 series.")).toBeTruthy();
  });

  it("draws no old values when the panel is unreachable", () => {
    render(<ChartView panel={panelOf("stat")} data={dataOf([series("a", [7])], { state: "unreachable" })} range={RANGE} animate changeId={0} />);
    expect(screen.queryByText("7")).toBeNull();
  });
});
