import { onTestFinished, vi } from "vitest";

/**
 * A browser's widths for fit-to-content tests (jsdom lays nothing out). `box` is the width an
 * element is drawn at (a header's or a cell's is its column's); `content` the natural width of what
 * it holds. As in Chrome:
 * - `offsetWidth` is the box;
 * - `scrollWidth` is the larger of the two, except that `width: max-content` shrinks a grid item to
 *   its content, while a fixed-layout table cell keeps its column's width;
 * - a Range over an element's contents measures the contents (an ellipsis is paint-only).
 * Both default to 0 for elements a test does not name.
 */
export function fakeColumnLayout(widths: { box?: (el: Element) => number | undefined; content?: (el: Element) => number | undefined }) {
  const box = (el: Element) => widths.box?.(el) ?? 0;
  const content = (el: Element) => widths.content?.(el) ?? 0;
  const offset = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return box(this);
  });
  const scroll = vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
    const shrinks = this instanceof HTMLElement && this.style.width === "max-content" && !["TD", "TH"].includes(this.tagName);
    return shrinks ? content(this) : Math.max(box(this), content(this));
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      const node = this.startContainer;
      const width = node instanceof Element ? content(node) : 0;
      return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: width, width, height: 0, toJSON() {} } as DOMRect;
    },
  });
  onTestFinished(() => {
    offset.mockRestore();
    scroll.mockRestore();
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });
}
