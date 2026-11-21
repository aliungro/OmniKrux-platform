// "+ Add panel": a dashed tile in the grid's first free spot for a new time series panel.
import type { CSSProperties } from "react";
import s from "./EditableGrid.module.css";

/** A grid area as the grid's custom properties (`--col`, `--row`, `--rows`). */
export const cellStyle = (l: { x: number; y: number; w: number; h: number }) =>
  ({ "--col": `${l.x + 1} / span ${l.w}`, "--row": `${l.y + 1} / span ${l.h}`, "--rows": l.h }) as CSSProperties;

export function AddPanelTile({ at, size, onAdd }: { at: { x: number; y: number }; size: { w: number; h: number }; onAdd(): void }) {
  return (
    <button type="button" data-add-tile="" className={s.add} style={cellStyle({ ...at, ...size })}
      aria-label="Add panel" aria-keyshortcuts="a" onClick={onAdd}>
      <span className={s.addMark} aria-hidden="true">+</span>
      <span className={s.addText} aria-hidden="true">Add panel</span>
    </button>
  );
}
