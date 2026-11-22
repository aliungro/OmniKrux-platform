import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MiniChart } from "./index";
import { dataOf, logLine, series, START } from "./panelFixtures";

afterEach(cleanup);

const long = (name: string) =>
  series(name, [], { points: Array.from({ length: 1000 }, (_, i) => [START + i * 6, Math.sin(i / 7) * 10] as [number, number | null]) });
const pointCount = (d: string) => d.split(/[ML]/).filter(Boolean).length;

describe("mini chart", () => {
  it("draws at most 120 columns and three series", () => {
    const { container } = render(
      <MiniChart data={dataOf(["a", "b", "c", "d"].map(long))} panelType="timeseries" unit="none" animate={false} />,
    );
    const lines = container.querySelectorAll("path[data-line]");
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(pointCount(l.getAttribute("d") as string)).toBeLessThanOrEqual(480);
      expect(l.getAttribute("stroke")).toMatch(/^var\(--/);
    }
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the last value for a stat", () => {
    const { container } = render(<MiniChart data={dataOf([series("a", [1, 42])])} panelType="stat" unit="none" animate />);
    expect(container.textContent).toBe("42");
  });

  it("shows three log lines at most", () => {
    const logs = [1, 2, 3, 4, 5].map((n) => logLine(n, `line ${n}`));
    const { container } = render(<MiniChart data={dataOf([], { logs })} panelType="logs" unit="none" animate />);
    expect(container.querySelectorAll("[data-log]")).toHaveLength(3);
  });

  it("draws one bar per series for a bar panel", () => {
    const { container } = render(
      <MiniChart data={dataOf([series("a", [4]), series("b", [2])])} panelType="bar" unit="none" animate={false} />,
    );
    expect(container.querySelectorAll("[data-bar]")).toHaveLength(2);
  });
});
