// The rule list (A2, left): a listbox of rules under their headings, firing ones pinned on top.
// One row holds the keyboard (roving focus); ↑ ↓ move and show each rule at once, Home and End
// jump, Enter goes to the details. The page owns the selection and writes it into the view.

import type { KeyboardEvent } from "react";
import type { ListRow } from "./listModel";
import s from "./AlertsPage.module.css";

export interface RuleListProps {
  rows: ListRow[];
  /** The row that is selected and holds the keyboard; null: nothing selected. */
  activeKey: string | null;
  /** Shows the rule of the row `key` (a click or a key). */
  onPick(key: string, how: "click" | "key"): void;
  /** Enter on a row: the details take the keyboard. */
  onEnter(): void;
  rowRef(key: string, el: HTMLElement | null): void;
  /** The details region's id: the selected row controls it. */
  detailsId: string;
}

export function RuleList({ rows, activeKey, onPick, onEnter, rowRef, detailsId }: RuleListProps) {
  const ruleRows = rows.filter((r) => r.kind === "rule");
  // Tab lands on the selected row, or on the first rule when none is selected.
  const tabKey = activeKey !== null && ruleRows.some((r) => r.key === activeKey) ? activeKey : (ruleRows[0]?.key ?? null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = ruleRows.findIndex((r) => r.key === tabKey);
    const last = ruleRows.length - 1;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(last, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Enter") {
      if (at < 0) return;
      e.preventDefault();
      if (activeKey !== tabKey && tabKey !== null) onPick(tabKey, "key");
      onEnter();
      return;
    } else return;
    e.preventDefault();
    if (next < 0 || last < 0) return;
    onPick(ruleRows[next].key, "key");
  };

  return (
    <div role="listbox" aria-label="Alert rules" className={s.list} onKeyDown={onKeyDown}>
      {rows.map((row) => {
        if (row.kind === "heading") {
          return (
            <div key={row.key} role="presentation" className={s.groupLabel} data-firing={row.key === "heading:firing" || undefined}>
              {row.label}
            </div>
          );
        }
        const selected = row.key === activeKey;
        return (
          <div
            key={row.key}
            ref={(el) => rowRef(row.key, el)}
            role="option"
            aria-selected={selected}
            aria-controls={selected ? detailsId : undefined}
            tabIndex={row.key === tabKey ? 0 : -1}
            className={s.row}
            aria-label={row.right ? `${row.label}, ${row.right}` : row.label}
            data-rule-row={row.ruleId}
            onClick={() => onPick(row.key, "click")}
          >
            {row.dot && <span className={s.dot} data-tone={row.tone} aria-hidden="true" />}
            <span className={s.rowName}>{row.label}</span>
            <span className={s.rowRight} data-tone={row.tone}>{row.right}</span>
          </div>
        );
      })}
    </div>
  );
}
