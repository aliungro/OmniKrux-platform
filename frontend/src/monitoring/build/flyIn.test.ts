import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flyIn, FLY_MS, LAND_MS } from "./flyIn";

const rect = (x: number, y: number, w: number, h: number) =>
  ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} }) as DOMRect;
let calls: { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions }[];
const original = Element.prototype.animate;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    calls.push({ el: this, keyframes, options });
    return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
  } as typeof Element.prototype.animate;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  Element.prototype.animate = original;
  document.body.innerHTML = "";
});

function tile() {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => rect(400, 300, 200, 100);
  document.body.appendChild(el);
  return el;
}

describe("flyIn", () => {
  it("does nothing under reduced motion", async () => {
    const to = tile();
    await flyIn(rect(0, 0, 100, 50), to, true);
    expect(calls).toHaveLength(0);
    expect(document.body.children).toHaveLength(1);
    expect(to.hasAttribute("data-landing")).toBe(false);
  });

  it("does nothing when animate is missing", async () => {
    // @ts-expect-error simulate an engine without the Web Animations API
    delete Element.prototype.animate;
    const to = tile();
    await flyIn(rect(0, 0, 100, 50), to, false);
    expect(document.body.children).toHaveLength(1);
  });

  it("moves a ghost from the card to the tile and lands it", async () => {
    const to = tile();
    const done = flyIn(rect(0, 0, 100, 50), to, false);
    expect(document.body.children).toHaveLength(2);
    await done;
    expect(document.body.children).toHaveLength(1);
    const [ghost, land] = calls;
    expect(ghost.options.duration).toBe(FLY_MS);
    expect(JSON.stringify(ghost.keyframes)).toContain("translate");
    expect(land.el).toBe(to);
    expect(land.options.duration).toBe(LAND_MS);
    expect(JSON.stringify(land.keyframes)).toContain("scale(0.85)");
    expect(to.hasAttribute("data-landing")).toBe(true);
    vi.advanceTimersByTime(LAND_MS);
    expect(to.hasAttribute("data-landing")).toBe(false);
  });
});
