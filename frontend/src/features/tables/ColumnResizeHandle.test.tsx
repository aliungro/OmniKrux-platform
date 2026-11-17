// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ColumnResizeHandle } from "./ColumnResizeHandle";

const overlays = () => document.querySelectorAll("[data-resize-guide],[data-resize-tip]");
const pointer = (target: Element, type: string, clientX = 0, pointerId = 1) =>
  fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId }));

let frames: FrameRequestCallback[] = [];
const flush = () => act(() => { const run = frames; frames = []; run.forEach(cb => cb(0)); });

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Handle({ label = "Namespace", onCommit, view = "a" }: { label?: string; onCommit: (w: number | null) => void; view?: string }) {
  return <span role="columnheader">
    <ColumnResizeHandle label={label} minWidth={64} maxWidth={800} readWidth={() => 100}
      onPreview={() => {}} onCommit={onCommit} view={view} />
  </span>;
}

describe("ColumnResizeHandle drag ends", () => {
  it("a release outside the handle still ends the drag and removes the guide", () => {
    const onCommit = vi.fn();
    render(<Handle onCommit={onCommit} />);
    const handle = screen.getByRole("separator");
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 140);
    flush();
    expect(overlays()).toHaveLength(2);
    window.dispatchEvent(Object.assign(new MouseEvent("pointerup", { clientX: 140 }), { pointerId: 1 }));
    expect(overlays()).toHaveLength(0);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(140);
  });

  it.each([
    ["lost capture", (handle: HTMLElement) => pointer(handle, "lostpointercapture")],
    ["pointercancel", (handle: HTMLElement) => pointer(handle, "pointercancel")],
    ["window pointercancel", () => window.dispatchEvent(Object.assign(new MouseEvent("pointercancel"), { pointerId: 1 }))],
    ["blur", () => window.dispatchEvent(new Event("blur"))],
    ["escape", (handle: HTMLElement) => fireEvent.keyDown(handle, { key: "Escape" })],
  ])("%s removes the guide without committing", (_name, end) => {
    const onCommit = vi.fn();
    render(<Handle onCommit={onCommit} />);
    const handle = screen.getByRole("separator");
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 140);
    flush();
    expect(overlays()).toHaveLength(2);
    end(handle);
    expect(overlays()).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("an element losing focus when the drag starts does not cancel it", () => {
    const onCommit = vi.fn();
    render(<><button>row</button><Handle onCommit={onCommit} /></>);
    const row = screen.getByRole("button");
    const handle = screen.getByRole("separator");
    act(() => row.focus());
    pointer(handle, "pointerdown", 100);
    // The press moves focus: the row blurs after the drag began (blur does not bubble, but captures).
    act(() => handle.focus());
    row.dispatchEvent(new FocusEvent("blur"));
    expect(overlays()).toHaveLength(2);
    window.dispatchEvent(Object.assign(new MouseEvent("pointerup", { clientX: 140 }), { pointerId: 1 }));
    expect(overlays()).toHaveLength(0);
    expect(onCommit).toHaveBeenCalledWith(140);
  });

  it("a drag started from the focused divider keeps focus there", () => {
    render(<><button>row</button><Handle onCommit={() => {}} /></>);
    const handle = screen.getByRole("separator");
    act(() => handle.focus());
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointerup", 140);
    expect(document.activeElement).toBe(handle);
  });

  it("focus goes back only within the pane the drag was in", () => {
    render(<>
      <main tabIndex={-1}>
        <section data-active-pane="false"><button data-testid="other" tabIndex={0}>other</button></section>
        <section data-active-pane="true"><Handle onCommit={() => {}} /></section>
      </main>
    </>);
    const handle = screen.getByRole("separator");
    act(() => screen.getByTestId("other").focus());
    pointer(handle, "pointerdown", 100);
    act(() => handle.focus());
    pointer(handle, "pointerup", 140);
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("an element focused before the drag is restored on release", () => {
    render(<><button>row</button><Handle onCommit={() => {}} /></>);
    const row = screen.getByRole("button");
    act(() => row.focus());
    pointer(screen.getByRole("separator"), "pointerdown", 100);
    pointer(screen.getByRole("separator"), "pointerup", 140);
    expect(document.activeElement).toBe(row);
  });

  it("unmounting mid-drag removes the guide", () => {
    const onCommit = vi.fn();
    const { unmount } = render(<Handle onCommit={onCommit} />);
    pointer(screen.getByRole("separator"), "pointerdown", 100);
    expect(overlays()).toHaveLength(2);
    unmount();
    expect(overlays()).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a changed view ends the drag", () => {
    const { rerender } = render(<Handle onCommit={() => {}} view="a" />);
    pointer(screen.getByRole("separator"), "pointerdown", 100);
    rerender(<Handle onCommit={() => {}} view="b" />);
    expect(overlays()).toHaveLength(0);
  });

  it("a new drag never leaves an older guide behind", () => {
    const commitA = vi.fn();
    const commitB = vi.fn();
    render(<><Handle label="A" onCommit={commitA} /><Handle label="B" onCommit={commitB} /></>);
    const [a, b] = screen.getAllByRole("separator");
    pointer(a, "pointerdown", 100);
    pointer(b, "pointerdown", 100);
    expect(document.querySelectorAll("[data-resize-guide]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-resize-tip]")).toHaveLength(1);
    window.dispatchEvent(Object.assign(new MouseEvent("pointerup", { clientX: 150 }), { pointerId: 1 }));
    expect(commitA).not.toHaveBeenCalled();
    expect(commitB).toHaveBeenCalledTimes(1);
    expect(overlays()).toHaveLength(0);
  });
});
