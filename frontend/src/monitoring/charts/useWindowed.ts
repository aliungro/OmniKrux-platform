// A small fixed-row window over a long list: which rows to mount for the scroll position. A row
// that must stay mounted (the focused one) is kept by the caller.

import { useCallback, useLayoutEffect, useRef, useState, type UIEvent } from "react";

const FALLBACK_HEIGHT = 320;
const OVERSCAN = 6;

export function useWindowed(count: number, rowHeight: number, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setHeight(el.clientHeight || FALLBACK_HEIGHT);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => setTop(e.currentTarget.scrollTop), []);

  const first = enabled ? Math.max(0, Math.floor(top / rowHeight) - OVERSCAN) : 0;
  const last = enabled ? Math.min(count, Math.ceil((top + height) / rowHeight) + OVERSCAN) : count;

  /** Scrolls so that row `i` is fully visible. */
  const reveal = (i: number) => {
    const el = ref.current;
    if (!el || !enabled) return;
    const y = i * rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowHeight > el.scrollTop + height) el.scrollTop = y + rowHeight - height;
    setTop(el.scrollTop);
  };

  return { ref, onScroll, first, last, reveal, pageRows: Math.max(1, Math.floor(height / rowHeight) - 1) };
}
