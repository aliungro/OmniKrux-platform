// A number that counts from the value it showed to the new one, but only after an edit (a newer
// `changeId` or `editId` than the last frame). A refresh, reduced motion or `animate` off jumps.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { COUNT_MS, easeOutCubic, tween, usePrefersReducedMotion } from "./motion";

export interface CountUpProps {
  value: number | null;
  format(value: number | null): string;
  animate: boolean;
  changeId: number;
  editId: number;
  className?: string;
}

export default function CountUp({ value, format, animate, changeId, editId, className }: CountUpProps) {
  const reduced = usePrefersReducedMotion();
  const last = useRef({ changeId, editId, shown: value });
  const cancel = useRef<(() => void) | null>(null);
  const [counting, setCounting] = useState<number | null>(null);

  useLayoutEffect(() => {
    cancel.current?.();
    cancel.current = null;
    const prev = last.current;
    const edited = changeId > prev.changeId || editId > prev.editId;
    const from = prev.shown;
    last.current = { changeId, editId, shown: value };
    if (animate && !reduced && edited && from !== null && value !== null && from !== value) {
      cancel.current = tween(COUNT_MS, (k) => {
        const now = k >= 1 ? value : from + (value - from) * easeOutCubic(k);
        last.current.shown = now;
        setCounting(k >= 1 ? null : now);
      });
    } else {
      setCounting(null);
    }
  }, [value, changeId, editId, animate, reduced]);

  useEffect(() => () => cancel.current?.(), []);

  return <span className={className}>{format(counting ?? value)}</span>;
}
