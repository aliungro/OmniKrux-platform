import { describe, expect, it } from "vitest";
import {
  appendPanel,
  compact,
  freeSpot,
  grow,
  MIN_HEIGHTS,
  neighbour,
  nudge,
  overlaps,
  placePanel,
} from "./layout";
import type { DashboardSpec, PanelSpec } from "./schema";

function P(id: string, x: number, y: number, w: number, h: number): PanelSpec {
  return {
    id,
    title: id,
    description: "",
    type: "stat",
    layout: { x, y, w, h },
    queries: [],
    alert: null,
    options: {
      unit: "none",
      decimals: null,
      thresholds: [],
      calc: "last",
      sparkline: false,
    },
  };
}
const at = (ps: PanelSpec[], id: string) => ps.find((p) => p.id === id)!.layout;
const box = (ps: PanelSpec[], id: string) => {
  const l = at(ps, id);
  return [l.x, l.y, l.w, l.h];
};

describe("layout", () => {
  it("overlaps is strict on edges", () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 3, y: 3, w: 4, h: 4 })).toBe(true);
  });

  it("placing a panel pushes what it covers down and compacts", () => {
    const out = placePanel([P("a", 0, 0, 12, 8), P("b", 12, 0, 12, 8)], "b", {
      x: 0,
      y: 0,
      w: 12,
      h: 8,
    });
    expect(box(out, "b")).toEqual([0, 0, 12, 8]);
    expect(box(out, "a")).toEqual([0, 8, 12, 8]);
  });

  it("pushes recursively", () => {
    const out = placePanel([P("a", 0, 0, 12, 4), P("b", 0, 4, 12, 4), P("c", 12, 0, 12, 4)], "c", {
      x: 0,
      y: 0,
      w: 12,
      h: 6,
    });
    expect(box(out, "c")).toEqual([0, 0, 12, 6]);
    expect(box(out, "a")).toEqual([0, 6, 12, 4]);
    expect(box(out, "b")).toEqual([0, 10, 12, 4]);
  });

  it("clamps to the grid and the minimum size", () => {
    const out = placePanel([P("a", 0, 0, 6, 4)], "a", {
      x: 30,
      y: -3,
      w: 1,
      h: 1,
    });
    expect(box(out, "a")).toEqual([22, 0, 2, 2]);
    const wide = placePanel([P("a", 0, 0, 6, 4)], "a", {
      x: 5,
      y: 0,
      w: 40,
      h: 99,
    });
    expect(box(wide, "a")).toEqual([0, 0, 24, 40]);
  });

  it("compaction floats panels up into a gap", () => {
    const out = compact([P("a", 0, 0, 24, 4), P("b", 0, 10, 12, 4)]);
    expect(box(out, "b")).toEqual([0, 4, 12, 4]);
  });

  it("compaction sorts by y then x", () => {
    const out = compact([P("b", 12, 0, 12, 4), P("a", 0, 0, 12, 4)]);
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("free spot finds the hole beside a panel", () => {
    expect(freeSpot([P("a", 0, 0, 12, 8)], 12, 8)).toEqual({ x: 12, y: 0 });
    expect(freeSpot([P("a", 0, 0, 12, 8), P("b", 12, 0, 12, 8)], 12, 8)).toEqual({ x: 0, y: 8 });
    expect(freeSpot([], 12, 8)).toEqual({ x: 0, y: 0 });
  });

  it("nudge and grow respect the grid and the minimum", () => {
    const ps = [P("a", 12, 0, 12, 4), P("b", 0, 0, 2, 2)];
    expect(nudge(ps, "a", "right")).toBe(ps);
    expect(nudge(ps, "b", "left")).toBe(ps);
    expect(nudge(ps, "b", "up")).toBe(ps);
    expect(grow(ps, "b", "left")).toBe(ps);
    expect(grow(ps, "b", "up")).toBe(ps);
    expect(grow(ps, "a", "right")).toBe(ps);
    expect(box(nudge(ps, "b", "right"), "b")).toEqual([1, 0, 2, 2]);
    expect(box(grow(ps, "b", "right"), "b")).toEqual([0, 0, 3, 2]);
    expect(box(grow(ps, "a", "down"), "a")).toEqual([12, 0, 12, 5]);
    expect(box(grow(ps, "a", "left"), "a")).toEqual([12, 0, 11, 4]);
    expect(box(grow(ps, "a", "up"), "a")).toEqual([12, 0, 12, 3]);
  });

  it("a free-space nudge down hands back the same list", () => {
    const ps = [P("a", 0, 0, 12, 8), P("b", 12, 0, 12, 4)];
    expect(nudge(ps, "a", "down")).toBe(ps);
    expect(nudge(ps, "b", "down")).toBe(ps);
    expect(nudge(ps, "zzz", "down")).toBe(ps);
  });

  it("grow stops at the maximum height", () => {
    const ps = [P("a", 0, 0, 12, 40)];
    expect(grow(ps, "a", "down")).toBe(ps);
  });

  it("nudging up or down past a panel swaps over it", () => {
    const ps = [P("a", 0, 0, 12, 8), P("b", 0, 8, 12, 8)];
    const up = nudge(ps, "b", "up");
    expect(box(up, "b")).toEqual([0, 0, 12, 8]);
    expect(box(up, "a")).toEqual([0, 8, 12, 8]);
    const down = nudge(ps, "a", "down");
    expect(box(down, "b")).toEqual([0, 0, 12, 8]);
    expect(box(down, "a")).toEqual([0, 8, 12, 8]);
  });

  it("neighbour follows the direction", () => {
    const ps = [
      P("tl", 0, 0, 12, 8),
      P("tr", 12, 0, 12, 8),
      P("bl", 0, 8, 12, 8),
      P("br", 12, 8, 12, 8),
    ];
    expect(neighbour(ps, "tl", "right")).toBe("tr");
    expect(neighbour(ps, "tl", "down")).toBe("bl");
    expect(neighbour(ps, "tl", "left")).toBeNull();
    expect(neighbour(ps, "tl", "up")).toBeNull();
    expect(neighbour(ps, "br", "up")).toBe("tr");
    expect(neighbour(ps, "br", "left")).toBe("bl");
    expect(neighbour(ps, "nope", "left")).toBeNull();
  });

  it("unchanged panels keep their identity", () => {
    const a = P("a", 0, 0, 12, 8);
    const b = P("b", 12, 0, 12, 8);
    const c = P("c", 0, 8, 24, 4);
    const out = placePanel([a, b, c], "b", { x: 12, y: 0, w: 12, h: 6 });
    expect(out.find((p) => p.id === "a")).toBe(a);
    expect(out.find((p) => p.id === "c")).toBe(c);
    expect(out.find((p) => p.id === "b")).not.toBe(b);
    const again = compact([a, b, c]);
    expect(again[0]).toBe(a);
    expect(again[1]).toBe(b);
    expect(again[2]).toBe(c);
  });

  it("appendPanel sizes from the defaults and places at the free spot", () => {
    const spec = { panels: [P("a", 0, 0, 12, 8)] } as unknown as DashboardSpec;
    const { layout: _layout, ...rest } = P("n", 0, 0, 1, 1);
    const out = appendPanel(spec, { ...rest, type: "timeseries" } as never);
    expect(out.panels).toHaveLength(2);
    expect(out.panels[0]).toBe(spec.panels[0]);
    expect(out.panels[1].layout).toEqual({ x: 12, y: 0, w: 12, h: 8 });
    const sized = appendPanel(spec, {
      ...rest,
      layout: { w: 6, h: 3 },
    } as never);
    expect(sized.panels[1].layout).toEqual({ x: 12, y: 0, w: 6, h: 3 });
    const wild = appendPanel(spec, {
      ...rest,
      layout: { w: 99, h: 0 },
    } as never);
    expect(wild.panels[1].layout).toMatchObject({ w: 24, h: 2 });
    const edge = appendPanel(spec, { ...rest, layout: { x: 20, y: -4, w: 12, h: 3 } } as never);
    expect(edge.panels[1].layout).toEqual({ x: 12, y: 0, w: 12, h: 3 });
  });

  it("a panel can't be made shorter than its type's minimum", () => {
    expect(MIN_HEIGHTS).toEqual({ timeseries: 4, bar: 4, logs: 4, table: 3, gauge: 3, stat: 2 });
    const typed = (id: string, type: PanelSpec["type"], h: number, y = 0) => ({ ...P(id, 0, y, 12, h), type }) as PanelSpec;
    // Placing (a move or the corner resize) and the keyboard's shrink stop at the minimum.
    for (const [type, min] of Object.entries(MIN_HEIGHTS) as [PanelSpec["type"], number][]) {
      const ps = [typed("a", type, min)];
      expect(at(placePanel(ps, "a", { x: 0, y: 0, w: 12, h: 1 }), "a").h).toBe(min);
      expect(grow(ps, "a", "up")).toBe(ps);
      expect(at(grow([typed("a", type, min + 1)], "a", "up"), "a").h).toBe(min);
    }
    // A new panel too.
    const spec = { panels: [] } as unknown as DashboardSpec;
    const { layout: _layout, ...rest } = typed("n", "timeseries", 1);
    expect(appendPanel(spec, { ...rest, layout: { w: 6, h: 1 } } as never).panels[0].layout.h).toBe(4);
    expect(appendPanel(spec, { ...rest, type: "table", layout: { w: 6, h: 2 } } as never).panels[0].layout.h).toBe(3);
    // A stored short panel keeps its height until it is moved or resized itself.
    const stored = [typed("short", "timeseries", 2), typed("b", "stat", 4, 2)];
    const other = placePanel(stored, "b", { x: 12, y: 0, w: 12, h: 4 });
    expect(at(other, "short").h).toBe(2);
    expect(grow(stored, "short", "up")).toBe(stored);
    expect(at(nudge(stored, "short", "right"), "short").h).toBe(4);
  });
});
