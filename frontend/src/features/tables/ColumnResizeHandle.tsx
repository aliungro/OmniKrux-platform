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
  /** Moves the guide and tooltip; they only ever get `transform` and text writes. */
  paint: () => void;
}

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** The guide line and its width tooltip: plain body children, so a drag never renders a row. */
function createOverlay(label: string, header: DOMRect | undefined, area: DOMRect | null, guideClass: string, tipClass: string) {
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
  return {
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
    },
  };
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

  useLayoutEffect(() => () => drag.current?.cancel(), [view, minWidth, maxWidth]);

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
    element.focus({ preventScroll: true });

    const overlay = createOverlay(label, element.parentElement?.getBoundingClientRect(), guide?.() ?? null, s.guide, s.tip);

    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }

    function cancel() {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      document.removeEventListener("keydown", escape, true);
      if (current.frame !== null) cancelAnimationFrame(current.frame);
      overlay.remove();
      if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
      setResizing(false);
      onPreview(null);
    }

    const paint = () => overlay.move(current.width - startWidth, current.width);
    const current: Drag = { pointerId, startX, startWidth, upper, width: startWidth, frame: null, cancel, paint };
    drag.current = current;
    paint();
    document.addEventListener("keydown", escape, true);
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
    const next = clamp(current.startWidth + (event.clientX - current.startX), current.upper);
    current.cancel();
    if (next !== current.startWidth) {
      setWidth(next);
      onCommit(next);
    }
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
