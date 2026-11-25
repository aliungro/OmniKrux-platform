// The legend under a chart: each series with its colour. A click shows only that series (again,
// all of them); Ctrl or Cmd+click toggles one. Items are buttons, pressed while the series shows.
// Pointer hover or keyboard focus on an item highlights its series; leaving clears it. A name is
// cut to fit (the full name is in its title). Past `LEGEND_FOLD` series the legend folds into one
// "{n} series" button that opens the full list; Esc in the list folds it again.

import { useId, useState, type KeyboardEvent, type MouseEvent } from "react";
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
  const [open, setOpen] = useState(false);
  const folds = items.length > LEGEND_FOLD;
  const click = (key: string) => (e: MouseEvent) => (e.ctrlKey || e.metaKey ? onToggle(key) : onSolo(key));
  const leave = (key: string) => () => {
    if (highlighted === key) onHighlight(null);
  };

  const list = (
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
  );
  if (!folds) return list;

  // Esc anywhere in the open list folds it and hands the keyboard back to the button.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    setOpen(false);
    (e.currentTarget.querySelector("[aria-expanded]") as HTMLButtonElement | null)?.focus();
  };
  return (
    <div className={styles.legendFold} onKeyDown={onListKey}>
      <button
        type="button"
        className={styles.legendToggle}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.legendChevron} aria-hidden="true" />
        {items.length} series
      </button>
      {open ? list : null}
    </div>
  );
}
