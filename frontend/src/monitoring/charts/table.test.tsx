import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChartView from "./index";
import { dataOf, panelOf, query, RANGE, series } from "./panelFixtures";

afterEach(cleanup);

function setup() {
  const rows = [["web", 5], ["api", 9], ["db", 1]] as const;
  const s = rows.map(([name, v]) => series(name, [v], { labels: { app: name } }));
  return render(
    <ChartView panel={panelOf("table", { unit: "none" }, { queries: [query("A")] })} data={dataOf(s)} range={RANGE} animate={false} changeId={0} />,
  );
}
const firstColumn = () => screen.getAllByRole("row").slice(1).map((r) => r.firstElementChild!.textContent);

describe("table panel", () => {
  it("sorts by keyboard and says so with aria-sort", () => {
    setup();
    const value = screen.getByRole("columnheader", { name: /Value/ });
    expect(value.getAttribute("aria-sort")).toBe("none");
    fireEvent.keyDown(value, { key: "Enter" });
    expect(value.getAttribute("aria-sort")).toBe("ascending");
    expect(firstColumn()).toEqual(["db", "web", "api"]);
    fireEvent.keyDown(value, { key: " " });
    expect(value.getAttribute("aria-sort")).toBe("descending");
    expect(firstColumn()).toEqual(["api", "web", "db"]);
  });

  it("makes headers focusable and formats values", () => {
    setup();
    for (const h of screen.getAllByRole("columnheader")) expect(h.tabIndex).toBe(0);
    expect(screen.getByText("9")).toBeTruthy();
  });

  it("mounts only the rows near the viewport", () => {
    const many = Array.from({ length: 500 }, (_, i) => series(`n${i}`, [i], { labels: { app: `n${i}` } }));
    render(<ChartView panel={panelOf("table")} data={dataOf(many)} range={RANGE} animate={false} changeId={0} />);
    expect(screen.getAllByRole("row").length).toBeLessThan(60);
  });
});
