// The legend under a chart: each series with its colour. A click shows only that series (again,
// all of them); Ctrl or Cmd+click toggles one. Items are buttons, pressed while the series shows.
// Pointer hover or keyboard focus on an item highlights its series; leaving clears it. A name is
// cut to fit (the full name is in its title). Past `LEGEND_FOLD` series the legend folds into one
// "{n} series" button that opens the full list; Esc in the list folds it again. Folding clears the
// highlight; a refresh that takes away the focused control hands the keyboard to the first one.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import styles from "./Charts.module.css";

/** More series than this and the legend folds into one button. */
export const LEGEND_FOLD = 12;

export interface LegendItem {
  key: string;
  name: string;
  /** A Territories token name such as `--kind`. */
  color: string;
}

interface Props {
  items: LegendItem[];
  hidden: ReadonlySet<string>;
  onSolo(key: string): void;
  onToggle(key: string): void;
  /** The series highlighted on the chart, or null. */
  highlighted: string | null;
  onHighlight(key: string | null): void;
}

const HOW = "Click to show only this series; Ctrl+click to show or hide it.";

export default function Legend({ items, hidden, onSolo, onToggle, highlighted, onHighlight }: Props) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const folds = items.length > LEGEND_FOLD;
  const showList = !folds || open;
  const click = (key: string) => (e: MouseEvent) => (e.ctrlKey || e.metaKey ? onToggle(key) : onSolo(key));
  const leave = (key: string) => () => {
    if (highlighted === key) onHighlight(null);
  };

  // A refresh can take away the control that has the keyboard (the legend folds or unfolds, or a
  // series goes): noted while the old buttons are still on the page, then the keyboard moves to
  // the legend's first control (the "{n} series" button, or the first series), never <body>.
  const [seen, setSeen] = useState(items);
  const [refocus, setRefocus] = useState(false);
  if (seen !== items) {
    setSeen(items);
    if (rootRef.current?.contains(document.activeElement)) setRefocus(true);
  }
  useLayoutEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    const root = rootRef.current;
    if (!root || root.contains(document.activeElement)) return;
    root.querySelector<HTMLButtonElement>("button")?.focus();
  }, [refocus]);

  // A series can't stay highlighted from a list that is no longer on the page (its item went away
  // under the pointer or the keyboard without a leave).
  useEffect(() => {
    if (!showList && highlighted !== null) onHighlight(null);
  }, [showList, highlighted, onHighlight]);

  const fold = () => {
    setOpen(false);
    onHighlight(null);
  };
  // Esc anywhere in the open list folds it and hands the keyboard back to the button.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !folds || !open) return;
    e.stopPropagation();
    fold();
    (e.currentTarget.querySelector("[aria-expanded]") as HTMLButtonElement | null)?.focus();
  };

  // One root in both shapes, with the list in the same place, so a fold never remounts it.
  return (
    <div ref={rootRef} className={folds ? styles.legendFold : styles.legendBox} onKeyDown={onKey}>
      {folds ? (
        <button
          type="button"
          className={styles.legendToggle}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => (open ? fold() : setOpen(true))}
        >
          <span className={styles.legendChevron} aria-hidden="true" />
          {items.length} series
        </button>
      ) : null}
      {showList ? (
        <ul id={listId} className={styles.legend} aria-label="Series">
          {items.map((item) => {
            const shown = !hidden.has(item.key);
            const cls = [styles.legendItem, shown ? "" : styles.legendOff, highlighted === item.key ? styles.legendLit : ""].filter(Boolean).join(" ");
            return (
              <li key={item.key} className={styles.legendEntry}>
                <button
                  type="button"
                  className={cls}
                  aria-pressed={shown}
                  onClick={click(item.key)}
                  onMouseEnter={() => onHighlight(item.key)}
                  onMouseLeave={leave(item.key)}
                  onFocus={() => onHighlight(item.key)}
                  onBlur={leave(item.key)}
                  title={item.name}
                  aria-description={HOW}
                >
                  <span className={styles.swatch} style={{ background: `var(${item.color})` }} aria-hidden="true" />
                  <span className={styles.legendName}>{item.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
