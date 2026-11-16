export interface ColumnMeasure {
  header: number;
  cells: readonly number[];
}

/** The width that shows the widest header or rendered cell in full, within `min` and `max`. */
export function fitColumnWidth(m: ColumnMeasure, min: number, max: number): number {
  const widest = Math.max(m.header, ...m.cells);
  return Math.max(min, Math.min(max, Math.ceil(Number.isFinite(widest) ? widest : min)));
}

const px = (value: string) => parseFloat(value) || 0;

/** Padding and borders across the inline axis. */
function inlineBox(style: CSSStyleDeclaration): number {
  return px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth);
}

/**
 * The width an element's contents need, plus its padding and borders. A Range measures the contents
 * themselves, not the box they sit in: a stretched grid cell or a fixed-layout table cell is as wide
 * as its column, and an ellipsis is paint-only, so the clipped text still counts in full.
 */
function natural(el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return Math.ceil(range.getBoundingClientRect().width) + inlineBox(getComputedStyle(el));
}

/** Laid out beside the label: not the absolutely placed resize handle, nor anything hidden. */
function inFlow(el: Element): boolean {
  if (el.getAttribute("role") === "separator") return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed";
}

/**
 * The header's natural width: its label in full, the in-flow parts beside it (the filter icon),
 * the gaps between them and the header's padding. Never its free space, so fit can shrink a column.
 */
function headerWidth(header: HTMLElement): number {
  const label = header.querySelector<HTMLElement>("[data-column-label]");
  if (!label || label.parentElement !== header) return natural(header);
  const style = getComputedStyle(header);
  const parts = Array.from(header.children).filter((child) => child !== label && inFlow(child));
  const beside = parts.reduce((sum, part) => {
    const margins = getComputedStyle(part);
    const width = part instanceof HTMLElement ? part.offsetWidth : part.getBoundingClientRect().width;
    return sum + width + px(margins.marginLeft) + px(margins.marginRight);
  }, 0);
  return natural(label) + beside + px(style.columnGap) * parts.length + inlineBox(style);
}

/**
 * Reads one column's natural content widths: the header (label, icon and padding), and the cell
 * at the same index of every rendered body row. Virtualized rows that are not rendered, and
 * band or detail rows with a different child count, are not measured.
 */
export function measureColumn(header: HTMLElement): { header: number; cells: number[] } {
  const headerNatural = headerWidth(header);
  const row = header.parentElement;
  const container = header.closest('[role="grid"], table');
  if (!row || !container) return { header: headerNatural, cells: [] };
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
  // Each cell's contents on one line, read in one layout pass and restored before anything paints.
  const saved = targets.map(cell => cell.style.whiteSpace);
  let cells: number[];
  try {
    for (const cell of targets) cell.style.whiteSpace = "nowrap";
    cells = targets.map(natural);
  } finally {
    targets.forEach((cell, i) => {
      cell.style.whiteSpace = saved[i];
    });
  }
  return { header: headerNatural, cells };
}
