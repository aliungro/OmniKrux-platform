import { describe, expect, it } from "vitest";
import { fitColumnWidth, measureColumn } from "./fitColumn";

describe("fitColumn", () => {
  it("fit measures the header and rendered rows within bounds", () => {
    expect(fitColumnWidth({ header: 80, cells: [60, 140.2] }, 64, 800)).toBe(141);
    expect(fitColumnWidth({ header: 30, cells: [] }, 64, 800)).toBe(64);
    expect(fitColumnWidth({ header: 80, cells: [2000] }, 64, 800)).toBe(800);
  });

  it("measureColumn reads the matching cell of each rendered row and skips band rows", () => {
    document.body.innerHTML = `<div role="grid">
      <div role="rowgroup"><div role="row"><span role="columnheader" id="h0"><span data-column-label>A</span></span><span role="columnheader" id="h1"><span data-column-label>B</span></span></div></div>
      <div role="rowgroup">
        <div role="row"><span>a</span><span>b</span></div>
        <div role="row"><span>a</span><span>b</span></div>
        <div role="row"><span>band</span></div>
      </div></div>`;
    const stub = (el: Element, props: Record<string, number>) =>
      Object.entries(props).forEach(([k, v]) => Object.defineProperty(el, k, { configurable: true, value: v }));
    const header = document.getElementById("h1")!;
    stub(header, { offsetWidth: 100 });
    stub(header.firstElementChild!, { scrollWidth: 40, offsetWidth: 40 });
    const rows = document.querySelectorAll('[role="rowgroup"]:last-child [role="row"]');
    stub(rows[0].children[1], { scrollWidth: 90 });
    stub(rows[1].children[1], { scrollWidth: 120 });
    stub(rows[2].children[0], { scrollWidth: 999 });
    (rows[1].children[1] as HTMLElement).style.width = "50%";
    expect(measureColumn(header)).toEqual({ header: 100, cells: [90, 120] });
    expect((rows[0].children[1] as HTMLElement).style.width).toBe("");
    expect((rows[0].children[1] as HTMLElement).style.whiteSpace).toBe("");
    expect((rows[1].children[1] as HTMLElement).style.width).toBe("50%");
    document.body.innerHTML = "";
  });

  it("measureColumn restores the cells even when a read throws", () => {
    document.body.innerHTML = `<table><thead><tr><th id="h"><span data-column-label>A</span></th></tr></thead>
      <tbody><tr><td style="width: 7px">a</td></tr></tbody></table>`;
    const cell = document.querySelector("td")!;
    Object.defineProperty(cell, "scrollWidth", { configurable: true, get() { throw new Error("no layout"); } });
    expect(() => measureColumn(document.getElementById("h")!)).toThrow("no layout");
    expect(cell.style.width).toBe("7px");
    expect(cell.style.whiteSpace).toBe("");
    document.body.innerHTML = "";
  });
});
