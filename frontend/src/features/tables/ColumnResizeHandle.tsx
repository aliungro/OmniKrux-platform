import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import s from "./ColumnResizeHandle.module.css";

export interface ColumnResizeHandleProps {
  label: string;
  minWidth: number;
  maxWidth: number;
  readWidth: () => number;
  onPreview: (width: number | null) => void;
  onCommit: (width: number | null) => void;
  /** The width that fits the column's content, or null to reset instead. Double-click calls it. */
  onFit?: () => number | null;
  /** The visible table area, which a drag's guide runs down. */
  guide?: () => DOMRect | null;
  /** Cancel an in-progress drag if its owner changes views without unmounting. */
  view?: unknown;
}

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  /** A column already wider than `maxWidth` can narrow from its real width, but not grow. */
  upper: number;
  width: number;
  frame: number | null;
  cancel: () => void;
  commit: (clientX: number) => void;
  /** Moves the guide and tooltip; they only ever get `transform` and text writes. */
  paint: () => void;
}

/** The one drag and overlay alive anywhere: a new drag ends an older one that never got its end event. */
let liveDrag: { cancel(): void } | null = null;
let liveOverlay: { remove(): void } | null = null;

/** Where the keyboard goes when the pointer leaves it nowhere: the selected row, else the page's main. */
function fallbackFocus(handle: HTMLElement): HTMLElement | null {
  return handle.closest('[role="grid"]')?.querySelector<HTMLElement>('[data-row-key][tabindex="0"], [role="row"][tabindex="0"]')
    ?? handle.closest<HTMLElement>("main");
}

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** The guide line and its width tooltip: plain body children, so a drag never renders a row. */
function createOverlay(label: string, header: DOMRect | undefined, area: DOMRect | null, guideClass: string, tipClass: string) {
  liveOverlay?.remove();
  document.querySelectorAll("[data-resize-guide],[data-resize-tip]").forEach(node => node.remove());
  const top = finite(header?.top);
  const right = finite(header?.right);
  const line = document.createElement("div");
  line.className = guideClass;
  line.setAttribute("data-resize-guide", "");
  line.setAttribute("aria-hidden", "true");
  line.style.top = `${top}px`;
  line.style.height = `${Math.max(finite(header?.height), finite(area?.bottom ?? header?.bottom) - top)}px`;
  const tip = document.createElement("div");
  tip.className = tipClass;
  tip.setAttribute("data-resize-tip", "");
  tip.setAttribute("aria-hidden", "true");
  tip.style.top = `${finite(header?.bottom) + 4}px`;
  document.body.append(line, tip);
  const overlay = {
    move(delta: number, width: number) {
      const x = right + delta;
      line.style.transform = `translateX(${x - 1}px)`;
      tip.textContent = `${label} · ${width} px`;
      const room = window.innerWidth - tip.offsetWidth - 4;
      tip.style.transform = `translateX(${Math.max(4, Math.min(x + 6, room))}px)`;
    },
    remove() {
      line.remove();
      tip.remove();
      if (liveOverlay === overlay) liveOverlay = null;
    },
  };
  liveOverlay = overlay;
  return overlay;
}

export function ColumnResizeHandle({ label, minWidth, maxWidth, readWidth, onPreview, onCommit, onFit, guide, view }: ColumnResizeHandleProps) {
  const handle = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const [resizing, setResizing] = useState(false);
  const [width, setWidth] = useState(minWidth);
  const clamp = useCallback((value: number, upper: number) =>
    Number.isFinite(value) ? Math.max(minWidth, Math.min(upper, Math.round(value))) : minWidth, [minWidth]);
  /** The column's real width, which a responsive column may take past `maxWidth`. */
  const realWidth = useCallback(() => clamp(readWidth(), Infinity), [clamp, readWidth]);
  const measure = useCallback(() => setWidth(realWidth()), [realWidth]);

  useLayoutEffect(() => {
    measure();
    const target = handle.current?.parentElement;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [measure]);

  useLayoutEffect(() => () => {
    drag.current?.cancel();
  }, [view, minWidth, maxWidth]);

  /** Unmounting while the divider holds focus must not drop it on the body. */
  useLayoutEffect(() => () => {
    const element = handle.current;
    if (element && document.activeElement === element) fallbackFocus(element)?.focus({ preventScroll: true });
  }, []);

  function start(event: PointerEvent<HTMLSpanElement>) {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    const { currentTarget: element, pointerId, clientX: startX } = event;
    const startWidth = realWidth();
    const upper = Math.max(maxWidth, startWidth);
    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      return;
    }
    const startedOnHandle = document.activeElement === element;
    const pane = element.closest("[data-active-pane]") ?? element.closest("main");
    const before = document.activeElement;
    /** Only a place in the same pane (or the same main) gets the keyboard back; never the other pane. */
    const returnTo = !startedOnHandle && before instanceof HTMLElement && before !== document.body
      && before.isConnected && (!pane || pane.contains(before)) ? before : null;

    liveDrag?.cancel();
    const overlay = createOverlay(label, element.parentElement?.getBoundingClientRect(), guide?.() ?? null, s.guide, s.tip);

    const self = { cancel: () => cancel() };

    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }

    function windowUp(event: globalThis.PointerEvent) {
      if (event.pointerId === pointerId) commit(event.clientX);
    }
    function windowCancel() {
      cancel();
    }
    /** Capture sees every element's blur; only the window's own means the pointer left the page. */
    function windowBlur(event: Event) {
      if (!(event.target instanceof Node)) cancel();
    }

    function cancel() {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      if (liveDrag === self) liveDrag = null;
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("pointerup", windowUp, true);
      window.removeEventListener("pointercancel", windowCancel, true);
      window.removeEventListener("blur", windowBlur, true);
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      overlay.remove();
      if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
      setResizing(false);
      onPreview(null);
      giveFocusBack();
    }

    /** The press never focuses the divider, so the keyboard goes back to where it was. */
    function giveFocusBack() {
      if (startedOnHandle) return;
      const active = document.activeElement;
      /** The prevented mousedown leaves focus where it was; in another pane that is the wrong place to stay. */
      const elsewhere = !!pane && active instanceof Node && active !== element && active !== document.body && !pane.contains(active);
      if (active && active !== element && active !== document.body && !elsewhere) return;
      const target = returnTo?.isConnected ? returnTo : fallbackFocus(element);
      target?.focus({ preventScroll: true });
    }

    /** The one commit: the handle's pointerup and the window fallback both come here. */
    function commit(clientX: number) {
      const current = drag.current;
      if (!current) return;
      const next = clamp(current.startWidth + (clientX - current.startX), current.upper);
      cancel();
      if (next !== current.startWidth) {
        setWidth(next);
        onCommit(next);
      }
    }
    const paint = () => overlay.move(current.width - startWidth, current.width);
    const current: Drag = { pointerId, startX, startWidth, upper, width: startWidth, frame: null, cancel, commit, paint };
    drag.current = current;
    liveDrag = self;
    paint();
    document.addEventListener("keydown", escape, true);
    window.addEventListener("pointerup", windowUp, true);
    window.addEventListener("pointercancel", windowCancel, true);
    window.addEventListener("blur", windowBlur, true);
    setResizing(true);
  }

  function move(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    current.width = clamp(current.startWidth + (event.clientX - current.startX), current.upper);
    if (current.frame !== null) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = null;
      current.paint();
      setWidth(current.width);
      onPreview(current.width === current.startWidth ? null : current.width);
    });
  }

  function release(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    current.commit(event.clientX);
  }

  function cancelPointer(event: PointerEvent<HTMLSpanElement>) {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    current.cancel();
  }

  function keyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", " ", "Enter"].includes(event.key)) return;
    event.stopPropagation();
    event.preventDefault();
    if (drag.current) return;
    if (event.key === "Enter") {
      onCommit(null);
      return;
    }
    const startWidth = realWidth();
    const upper = Math.max(maxWidth, startWidth);
    const next = event.key === "Home" ? minWidth
      : event.key === "End" ? upper
      : event.key === "ArrowLeft" ? clamp(startWidth - 8, upper)
      : event.key === "ArrowRight" ? clamp(startWidth + 8, upper)
      : startWidth;
    if (startWidth !== next) {
      setWidth(next);
      onCommit(next);
    }
  }

  return <span
    ref={handle}
    className={s.handle}
    role="separator"
    aria-label={`Resize ${label}`}
    aria-orientation="vertical"
    aria-keyshortcuts="ArrowLeft ArrowRight Home End Enter"
    aria-valuemin={minWidth}
    aria-valuemax={Math.max(maxWidth, width)}
    aria-valuenow={width}
    aria-valuetext={`${width} pixels`}
    tabIndex={0}
    data-resizing={resizing || undefined}
    onFocus={measure}
    onKeyDown={keyDown}
    onMouseDown={event => event.preventDefault()}
    onPointerDown={start}
    onPointerMove={move}
    onPointerUp={release}
    onPointerCancel={cancelPointer}
    onLostPointerCapture={cancelPointer}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => {
      event.preventDefault();
      event.stopPropagation();
      const fitted = onFit?.() ?? null;
      onCommit(fitted === null ? null : clamp(fitted, Math.max(maxWidth, realWidth())));
    }}
    onContextMenu={event => {
      event.preventDefault();
      event.stopPropagation();
    }}
  />;
}
