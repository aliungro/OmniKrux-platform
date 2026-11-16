export interface ColumnMeasure {
  header: number;
  cells: readonly number[];
}

/** The width that shows the widest header or rendered cell in full, within `min` and `max`. */
export function fitColumnWidth(m: ColumnMeasure, min: number, max: number): number {
  const widest = Math.max(m.header, ...m.cells);
  return Math.max(min, Math.min(max, Math.ceil(Number.isFinite(widest) ? widest : min)));
}

/**
 * Reads one column's natural content widths: the header label plus its padding, and the cell
 * at the same index of every rendered body row. Virtualized rows that are not rendered, and
 * band or detail rows with a different child count, are not measured.
 */
export function measureColumn(header: HTMLElement): { header: number; cells: number[] } {
  const label = header.querySelector<HTMLElement>("[data-column-label]");
  const headerWidth = label ? label.scrollWidth + Math.max(0, header.offsetWidth - label.offsetWidth) : header.scrollWidth;
  const row = header.parentElement;
  const container = header.closest('[role="grid"], table');
  if (!row || !container) return { header: headerWidth, cells: [] };
  const index = Array.prototype.indexOf.call(row.children, header);
  const rows = container.matches("table")
    ? Array.from(container.querySelectorAll<HTMLElement>("tbody tr"))
    : Array.from(container.querySelectorAll<HTMLElement>('[role="row"]')).filter(candidate => candidate !== row);
  const targets: HTMLElement[] = [];
  for (const candidate of rows) {
    if (candidate.children.length !== row.children.length) continue;
    const cell = candidate.children[index] as HTMLElement | undefined;
    if (cell) targets.push(cell);
  }
  // A cell is never narrower than its own box, so read each at its natural width: no stretch
  // and no wrapping. All are set, read in one layout pass, and restored before anything paints.
  const saved = targets.map(cell => [cell.style.width, cell.style.whiteSpace]);
  let cells: number[];
  try {
    for (const cell of targets) {
      cell.style.width = "max-content";
      cell.style.whiteSpace = "nowrap";
    }
    cells = targets.map(cell => cell.scrollWidth);
  } finally {
    targets.forEach((cell, i) => {
      [cell.style.width, cell.style.whiteSpace] = saved[i];
    });
  }
  return { header: headerWidth, cells };
}
