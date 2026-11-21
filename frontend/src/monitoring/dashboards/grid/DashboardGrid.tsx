// The dashboard's panels on its 24-column grid (row unit 30 px, gap 10 px). In reading order
// (top to bottom, then left to right), which is also how they stack on a narrow window.
import { useMemo } from "react";
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
}

export function DashboardGrid({ dashboardId, panels, owner, ownerName, vars, range, waiting, refreshSeq, status }: Props) {
  const ordered = useMemo(
    () => [...panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x),
    [panels],
  );
  if (ordered.length === 0) return <p className={s.empty}>This dashboard has no panels yet.</p>;
  return (
    <div className={s.grid}>
      {ordered.map((panel) => (
        <PanelFrame key={panel.id} dashboardId={dashboardId} panel={panel} owner={owner} ownerName={ownerName}
          vars={vars} range={range} waiting={waiting(panel)} refreshSeq={refreshSeq} status={status} />
      ))}
    </div>
  );
}
