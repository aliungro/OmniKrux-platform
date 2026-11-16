import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import s from "./ColumnResizeHandle.module.css";

export interface ColumnResizeHandleProps {
  label: string;
  minWidth: number;
  maxWidth: number;
  readWidth: () => number;
  onPreview: (width: number | null) => void;
  onCommit: (width: number | null) => void;
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
}

export function ColumnResizeHandle({ label, minWidth, maxWidth, readWidth, onPreview, onCommit, view }: ColumnResizeHandleProps) {
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
      if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
      setResizing(false);
      onPreview(null);
    }

    drag.current = { pointerId, startX, startWidth, upper, width: startWidth, frame: null, cancel };
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
      onCommit(null);
    }}
    onContextMenu={event => {
      event.preventDefault();
      event.stopPropagation();
    }}
  />;
}
