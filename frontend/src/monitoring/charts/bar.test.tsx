import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChartView from "./index";
import { dataOf, panelOf, RANGE, series } from "./panelFixtures";

afterEach(cleanup);

describe("bar panel", () => {
  const s = [series("web", [2, 4]), series("db", [1, 8])];
  it("labels bars with their names and values", () => {
    render(<ChartView panel={panelOf("bar", { unit: "bytes" })} data={dataOf(s)} range={RANGE} animate={false} changeId={0} />);
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("4 B")).toBeTruthy();
    expect(screen.getByText("db")).toBeTruthy();
    expect(screen.getByText("8 B")).toBeTruthy();
    expect(document.querySelectorAll("svg")).toHaveLength(2);
  });

  it("draws vertical bars and threshold colours", () => {
    render(
      <ChartView
        panel={panelOf("bar", { orientation: "vertical", thresholds: [{ value: 5, color: "bad" }] })}
        data={dataOf(s)}
        range={RANGE}
        animate={false}
        changeId={0}
      />,
    );
    expect(document.querySelectorAll('[data-tone="bad"]')).toHaveLength(1);
  });
});
