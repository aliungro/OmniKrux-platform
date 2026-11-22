// The dashboard's panels on its 24-column grid (row unit 30 px, gap 10 px). In reading order
// (top to bottom, then left to right), which is also how they stack on a narrow window. In edit
// mode (`editor`) the same grid holds tiles, so panels keep their runs and data across the switch.
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useEditableGrid, type GridEditing, type GridEditor } from "../editor/EditableGrid";
import type { ResolvedVars } from "../interpolate";
import type { DashboardOwner } from "../runPanel";
import type { PanelSpec } from "../schema";
import type { PanelStatusStore } from "../page/useDashboardContext";
import { PanelFrame } from "./PanelFrame";
import s from "./DashboardGrid.module.css";

interface Props {
  dashboardId: string;
  panels: PanelSpec[];
  owner: DashboardOwner | null;
  ownerName: string;
  vars: ResolvedVars;
  range: { start: number; end: number };
  waiting(panel: PanelSpec): boolean;
  /** Why a panel can't run (a variable it uses has no values), else null. */
  blocked(panel: PanelSpec): string | null;
  refreshSeq: number;
  status: PanelStatusStore;
  /** Edit mode: the draft's panels are `panels`. */
  editor?: GridEditor;
  /** Edit mode: "+ Add panel" and `a` open the page's search instead of adding an empty panel. */
  onAddPanel?(opener: HTMLElement | null): void;
  /** Edit mode: what the page may ask of the grid (Empty panel, the live region, a tile's focus); null otherwise. */
  controls?: RefObject<GridControls | null>;
  /** Edit mode on a new dashboard with the suggestions open: the dashed "Your new dashboard" board. */
  board?: boolean;
}

export type GridControls = Pick<GridEditing, "addEmpty" | "announce" | "focusPanel">;

export function DashboardGrid({ dashboardId, panels, owner, ownerName, vars, range, waiting, blocked, refreshSeq, status, editor, onAddPanel, controls, board }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const edit = useEditableGrid(editor ?? null, gridRef, owner, { onAddPanel });
  const addEmpty = edit?.addEmpty;
  const announce = edit?.announce;
  const focusPanel = edit?.focusPanel;
  useLayoutEffect(() => {
    if (!controls) return;
    const ref = controls as { current: GridControls | null };
    ref.current = addEmpty && announce && focusPanel ? { addEmpty, announce, focusPanel } : null;
    return () => { ref.current = null; };
  }, [controls, addEmpty, announce, focusPanel]);
  const ordered = useMemo(
    () => [...panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x),
    [panels],
  );
  if (ordered.length === 0 && !edit) return <p className={s.empty}>This dashboard has no panels yet.</p>;
  return (
    <div className={s.frame}>
      <div ref={gridRef} className={s.grid} data-editing={edit ? "" : undefined}
        role={edit ? "group" : undefined} aria-label={edit ? "Panels" : undefined}>
        {ordered.map((panel) => (
          <PanelFrame key={panel.id} dashboardId={dashboardId} panel={panel} owner={owner} ownerName={ownerName}
            vars={vars} range={range} waiting={waiting(panel)} blocked={blocked(panel)} refreshSeq={refreshSeq} status={status}
            changeId={editor?.state.changes[panel.id] ?? 0} layout={edit?.layoutOf(panel)} tile={edit?.tile(panel)} />
        ))}
        {edit && board && (
          <div className={s.board} data-board="">
            <p className={s.boardText}>
              <strong className={s.boardTitle}>Your new dashboard</strong>
              <span>Click a suggestion on the left; it flies into place.</span>
            </p>
          </div>
        )}
        {edit?.layer}
      </div>
      {edit?.aside}
      {edit?.live}
    </div>
  );
}
