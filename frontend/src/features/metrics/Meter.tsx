import type { CSSProperties } from "react";
import s from "./Meter.module.css";

/** The mockup's meter: a 60 px bar and its text. `frac` is null when there is nothing to measure against. */
export function Meter({
  text,
  frac,
  hot = false,
  stale = false,
  title,
}: {
  text: string;
  frac: number | null;
  /** Near the limit (or what the node can allocate), not merely above a request. */
  hot?: boolean;
  stale?: boolean;
  title?: string;
}) {
  const style = frac === null ? undefined : ({ "--v": `${Math.min(100, Math.round(frac * 100))}%` } as CSSProperties);
  return (
    <span className={`${s.meter}${hot ? ` ${s.hot}` : ""}${stale ? ` ${s.stale}` : ""}`} title={title}>
      {frac !== null && (
        hot ? <i style={style} role="img" aria-label="near its limit" /> : <i style={style} aria-hidden="true" />
      )}
      <span>{text}</span>
    </span>
  );
}
