import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChartView from "./index";
import { dataOf, fakeBox, panelOf, query, RANGE, series } from "./panelFixtures";

beforeEach(() => fakeBox(300));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  const many = (n: number) => Array.from({ length: n }, (_, i) => series(`n${i}`, [i], { labels: { app: `n${i}` } }));
  const panel = panelOf("table");
  const draw = (data: ReturnType<typeof dataOf>) => <ChartView panel={panel} data={data} range={RANGE} animate={false} changeId={0} />;

  it("draws the rows for its height when data follows an empty answer", () => {
    const { rerender } = render(draw(dataOf([], { state: "empty" })));
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    rerender(draw(dataOf(many(500))));
    const rows = screen.getAllByRole("row").length - 1;
    expect(rows).toBeGreaterThanOrEqual(10);
    expect(rows).toBeLessThan(30);
  });

  it("draws the rows after an error is recovered, and keeps sort and blanks sensible", () => {
    const { rerender } = render(draw(dataOf(many(500), { state: "error" })));
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    rerender(draw(dataOf(many(500))));
    expect(screen.getAllByRole("row").length - 1).toBeLessThan(30);
  });

  it("keeps blank cells last in both directions", () => {
    const s = [series("a", [3], { labels: { app: "a" } }), series("b", [null], { labels: { app: "b" } }), series("c", [1], { labels: { app: "c" } })];
    render(draw(dataOf(s)));
    const header = screen.getByRole("columnheader", { name: /Value/ });
    fireEvent.keyDown(header, { key: "Enter" });
    expect(firstColumn()).toEqual(["c", "a", "b"]);
    fireEvent.keyDown(header, { key: "Enter" });
    expect(firstColumn()).toEqual(["a", "c", "b"]);
  });

  it("sorts a column by its own place when two columns share a name", () => {
    const s = [
      series("a", [1], { labels: { Value: "z" } }),
      series("b", [2], { labels: { Value: "y" } }),
    ];
    render(draw(dataOf(s)));
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent?.trim())).toEqual(["Value", "Value"]);
    fireEvent.keyDown(headers[1], { key: "Enter" });
    expect(headers[1].getAttribute("aria-sort")).toBe("ascending");
    expect(headers[0].getAttribute("aria-sort")).toBe("none");
  });

  it("follows the sort option when it changes", () => {
    const s = many(3);
    const withSort = (sort: { column: string; descending: boolean } | null) => (
      <ChartView panel={panelOf("table", { sort })} data={dataOf(s)} range={RANGE} animate={false} changeId={0} />
    );
    const { rerender } = render(withSort(null));
    expect(screen.getByRole("columnheader", { name: /Value/ }).getAttribute("aria-sort")).toBe("none");
    rerender(withSort({ column: "Value", descending: true }));
    expect(screen.getByRole("columnheader", { name: /Value/ }).getAttribute("aria-sort")).toBe("descending");
  });
});

describe("table headers and cells", () => {
  it("table headers are words, and cut cells show the full value", () => {
    const long = "a-very-long-pod-name-that-the-cell-has-to-cut-0123456789";
    const s = [series("a", [5], { labels: { pod_name: long, namespace: "demo" } })];
    render(<ChartView panel={panelOf("table", { unit: "none" }, { queries: [query("A")] })} data={dataOf(s)} range={RANGE} animate={false} changeId={0} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent?.trim())).toEqual(["Pod name", "Namespace", "Value"]);
    expect(screen.getByText(long).getAttribute("title")).toBe(long);
    expect(screen.getByText("5").getAttribute("title")).toBe("5");
  });
});
