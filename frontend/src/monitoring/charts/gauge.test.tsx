import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChartView from "./index";
import { dataOf, panelOf, RANGE, series } from "./panelFixtures";

afterEach(cleanup);
const draw = (options: Record<string, unknown>, value = 0.5) =>
  render(<ChartView panel={panelOf("gauge", options)} data={dataOf([series("cpu", [value])])} range={RANGE} animate={false} changeId={0} />);

describe("gauge panel", () => {
  it("says what to set when there is no maximum", () => {
    draw({ unit: "none", max: null });
    expect(screen.getByText("Set a maximum in Options to draw this gauge.")).toBeTruthy();
  });

  it("defaults percentunit to 1 and percent to 100, with a text equivalent", () => {
    draw({ unit: "percentunit", max: null });
    const meter = screen.getByRole("meter", { name: "cpu" });
    expect(meter.getAttribute("aria-valuemax")).toBe("1");
    expect(meter.getAttribute("aria-valuetext")).toBe("50% of 0% to 100%");
    cleanup();
    draw({ unit: "percent", max: null }, 40);
    expect(screen.getByRole("meter").getAttribute("aria-valuemax")).toBe("100");
  });

  it("asks for a maximum above the minimum when they meet or cross", () => {
    draw({ unit: "none", min: 5, max: 5 });
    expect(screen.getByText("Set a maximum above the minimum in Options to draw this gauge.")).toBeTruthy();
    cleanup();
    draw({ unit: "none", min: 10, max: 2 });
    expect(screen.getByText("Set a maximum above the minimum in Options to draw this gauge.")).toBeTruthy();
  });

  it("clamps a value outside the range and keeps the reading", () => {
    draw({ unit: "none", min: 0, max: 10 }, 25);
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe("25 of 0 to 10");
    expect(document.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("draws two thresholds with the same value without a key clash", () => {
    draw({ unit: "none", max: 10, thresholds: [{ value: 5, color: "warn" }, { value: 5, color: "bad" }] }, 7);
    expect(screen.getByRole("meter")).toBeTruthy();
  });

  it("keeps the list out of the meter role", () => {
    draw({ unit: "percentunit" });
    expect(screen.getByRole("meter").tagName).toBe("DIV");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("colours the value by threshold", () => {
    draw({ unit: "percentunit", thresholds: [{ value: 0.4, color: "warn" }] });
    expect(document.querySelector('[data-tone="warn"]')).toBeTruthy();
  });
});
