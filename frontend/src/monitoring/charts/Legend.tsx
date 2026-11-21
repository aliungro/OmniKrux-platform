// The legend under a chart: each series with its colour. A click shows only that series (again,
// all of them); Ctrl or Cmd+click toggles one. Items are buttons, pressed while the series shows.

import type { MouseEvent } from "react";
import styles from "./Charts.module.css";

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
}

export default function Legend({ items, hidden, onSolo, onToggle }: Props) {
  const click = (key: string) => (e: MouseEvent) => (e.ctrlKey || e.metaKey ? onToggle(key) : onSolo(key));
  return (
    <ul className={styles.legend} aria-label="Series">
      {items.map((item) => {
        const shown = !hidden.has(item.key);
        return (
          <li key={item.key}>
            <button
              type="button"
              className={shown ? styles.legendItem : `${styles.legendItem} ${styles.legendOff}`}
              aria-pressed={shown}
              onClick={click(item.key)}
              title={`${item.name}. Click to show only this series; Ctrl+click to show or hide it.`}
            >
              <span className={styles.swatch} style={{ background: `var(${item.color})` }} aria-hidden="true" />
              <span className={styles.legendName}>{item.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
