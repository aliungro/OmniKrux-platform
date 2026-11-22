// The trail: the project's last queries as a toolbar of chips. One tab stop (the current query, or
// the newest); ← and → move between them; Enter or a click brings one back with its source.

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TrailEntry } from "./trail";
import s from "./ExplorePage.module.css";

const SHORT = 38;
export const trailKey = (e: Pick<TrailEntry, "expr" | "sourceId">) => `${e.sourceId}\n${e.expr}`;
const short = (text: string) => (text.length > SHORT ? `${text.slice(0, SHORT)}…` : text);

interface Props {
  /** Oldest first, already cut to the ones shown. */
  entries: TrailEntry[];
  /** The entry equal to the query being shown (text and source). */
  currentKey: string;
  onPick(entry: TrailEntry): void;
  onClear(): void;
}

export function Trail({ entries, currentKey, onPick, onClear }: Props) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [cursor, setCursor] = useState<string | null>(null);
  // The chip the keyboard was on when one was picked: picking moves it to the end, so it is
  // focused again where it lands (moving a focused node can drop the keyboard to <body>).
  const keep = useRef<string | null>(null);
  const keys = entries.map(trailKey);
  const stop = (cursor !== null && keys.includes(cursor) ? cursor : null)
    ?? (keys.includes(currentKey) ? currentKey : null)
    ?? keys[keys.length - 1];

  useLayoutEffect(() => {
    const k = keep.current;
    keep.current = null;
    if (k && document.activeElement !== refs.current.get(k)) refs.current.get(k)?.focus();
  });

  if (entries.length === 0) return null;

  const move = (to: number) => {
    const k = keys[Math.max(0, Math.min(keys.length - 1, to))];
    setCursor(k);
    refs.current.get(k)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") move(i - 1);
    else if (e.key === "ArrowRight") move(i + 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(keys.length - 1);
    else return;
    e.preventDefault();
  };
  const pick = (entry: TrailEntry, fromKeyboard: boolean) => {
    const k = trailKey(entry);
    setCursor(k);
    if (fromKeyboard || document.activeElement === refs.current.get(k)) keep.current = k;
    onPick(entry);
  };

  return (
    <div className={s.trailRow}>
      <div role="toolbar" aria-label="Recent queries" aria-orientation="horizontal" className={s.trail}>
        {entries.map((entry, i) => {
          const k = keys[i];
          return (
            <button
              key={k}
              ref={(el) => { if (el) refs.current.set(k, el); else refs.current.delete(k); }}
              type="button"
              className={s.trailChip}
              tabIndex={k === stop ? 0 : -1}
              aria-current={k === currentKey ? "true" : undefined}
              aria-label={entry.expr}
              title={entry.expr}
              onFocus={() => setCursor(k)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.repeat) { e.preventDefault(); pick(entry, true); return; }
                onKey(e, i);
              }}
              onClick={(e) => pick(entry, e.detail === 0)}
            >
              {short(entry.expr)}
            </button>
          );
        })}
      </div>
      <button type="button" className={s.clear} onClick={onClear}>Clear</button>
    </div>
  );
}
