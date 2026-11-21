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

  it("colours the value by threshold", () => {
    draw({ unit: "percentunit", thresholds: [{ value: 0.4, color: "warn" }] });
    expect(document.querySelector('[data-tone="warn"]')).toBeTruthy();
  });
});
