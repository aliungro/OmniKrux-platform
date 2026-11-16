import { describe, expect, it } from "vitest";
import { fakeColumnLayout } from "../../test/layout";
import { fitColumnWidth, measureColumn } from "./fitColumn";

describe("fitColumn", () => {
  it("fit measures the header and rendered rows within bounds", () => {
    expect(fitColumnWidth({ header: 80, cells: [60, 140.2] }, 64, 800)).toBe(141);
    expect(fitColumnWidth({ header: 30, cells: [] }, 64, 800)).toBe(64);
    expect(fitColumnWidth({ header: 80, cells: [2000] }, 64, 800)).toBe(800);
  });

  it("measureColumn reads the header's contents, not its free space, and each rendered row's cell", () => {
    document.body.innerHTML = `<div role="grid">
      <div role="rowgroup"><div role="row">
        <span role="columnheader" id="h0"><span data-column-label>A</span></span>
        <span role="columnheader" id="h1" style="padding: 0 10px 0 4px; column-gap: 3px"><span data-column-label id="label">B</span><button id="filter"></button><span role="separator" id="handle"></span></span>
      </div></div>
      <div role="rowgroup">
        <div role="row"><span>a</span><span id="c0" style="padding: 0 6px">b</span></div>
        <div role="row"><span>a</span><span id="c1" style="width: 50%">b</span></div>
        <div role="row"><span id="band">band</span></div>
      </div></div>`;
    const id = (el: Element) => el.id;
    // A 100px column whose label needs 40px: the header's 46px of free space is not content.
    fakeColumnLayout({
      box: (el) => ({ h1: 100, label: 40, filter: 12, handle: 10, c0: 100, c1: 100 } as Record<string, number>)[id(el)],
      content: (el) => ({ label: 40, c0: 90, c1: 120, band: 999 } as Record<string, number>)[id(el)],
    });
    const header = document.getElementById("h1")!;
    // Label 40 + filter 12 + one 3px gap + 14px padding; the absolute handle is not laid out beside them.
    expect(measureColumn(header)).toEqual({ header: 69, cells: [102, 120] });
    const [c0, c1] = [document.getElementById("c0")!, document.getElementById("c1")!];
    expect(c0.style.whiteSpace).toBe("");
    expect(c1.style.width).toBe("50%");
    document.body.innerHTML = "";
  });

  it("fit shrinks a wide column to its contents and keeps an ellipsized cell in full", () => {
    document.body.innerHTML = `<div role="grid">
      <div role="rowgroup"><div role="row"><span role="columnheader" id="h"><span data-column-label id="label">Namespace</span></span></div></div>
      <div role="rowgroup"><div role="row"><span id="c0">kube-system</span></div><div role="row"><span id="c1">default</span></div></div></div>`;
    fakeColumnLayout({
      box: (el) => ({ h: 227, label: 67, c0: 227, c1: 227 } as Record<string, number>)[el.id],
      content: (el) => ({ label: 67, c0: 79, c1: 35 } as Record<string, number>)[el.id],
    });
    expect(fitColumnWidth(measureColumn(document.getElementById("h")!), 64, 800)).toBe(79);
    document.body.innerHTML = "";

    // A 60px cell clipped with an ellipsis still asks for all 224px.
    document.body.innerHTML = `<div role="grid">
      <div role="rowgroup"><div role="row"><span role="columnheader" id="h"><span data-column-label id="label">Name</span></span></div></div>
      <div role="rowgroup"><div role="row"><span id="c0">a-long-pod-name</span></div></div></div>`;
    fakeColumnLayout({
      box: (el) => ({ h: 60, label: 40, c0: 60 } as Record<string, number>)[el.id],
      content: (el) => ({ label: 40, c0: 224 } as Record<string, number>)[el.id],
    });
    expect(fitColumnWidth(measureColumn(document.getElementById("h")!), 40, 800)).toBe(224);
    document.body.innerHTML = "";
  });

  it("measureColumn restores the cells even when a read throws", () => {
    document.body.innerHTML = `<table><thead><tr><th id="h"><span data-column-label>A</span></th></tr></thead>
      <tbody><tr><td style="width: 7px">a</td></tr></tbody></table>`;
    const cell = document.querySelector("td")!;
    fakeColumnLayout({});
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        if (this.startContainer === cell) throw new Error("no layout");
        return { width: 0 } as DOMRect;
      },
    });
    expect(() => measureColumn(document.getElementById("h")!)).toThrow("no layout");
    expect(cell.style.width).toBe("7px");
    expect(cell.style.whiteSpace).toBe("");
    document.body.innerHTML = "";
  });
});
