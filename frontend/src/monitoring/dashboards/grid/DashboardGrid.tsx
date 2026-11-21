// The dashboard's panels on its 24-column grid (row unit 30 px, gap 10 px). In reading order
// (top to bottom, then left to right), which is also how they stack on a narrow window. In edit
// mode (`editor`) the same grid holds tiles, so panels keep their runs and data across the switch.
import { useMemo, useRef } from "react";
import { useEditableGrid, type GridEditor } from "../editor/EditableGrid";
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
  refreshSeq: number;
  status: PanelStatusStore;
  /** Edit mode: the draft's panels are `panels`. */
  editor?: GridEditor;
}

export function DashboardGrid({ dashboardId, panels, owner, ownerName, vars, range, waiting, refreshSeq, status, editor }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const edit = useEditableGrid(editor ?? null, gridRef);
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
            vars={vars} range={range} waiting={waiting(panel)} refreshSeq={refreshSeq} status={status}
            changeId={editor?.state.changes[panel.id] ?? 0} layout={edit?.layoutOf(panel)} tile={edit?.tile(panel)} />
        ))}
        {edit?.layer}
      </div>
      {edit?.aside}
      {edit?.live}
    </div>
  );
}
