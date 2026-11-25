// A panel the finder or the suggestions offer, and the panel it becomes when added.
import type { NewPanel } from "../dashboards/layout";
import { DEFAULT_SIZES, newPanel } from "../dashboards/schema";
import type { OwnerKind, PanelType, Unit } from "../dashboards/schema";

export type Candidate = {
  key: string;
  title: string;
  subtitle: string;
  panelType: PanelType;
  expr: string;
  sourceType: "prometheus" | "loki";
  sourceId: string | null;
  unit: Unit;
  legend: string;
  options?: Record<string, unknown>;
};

/** A new panel from a candidate. A group's panels never pin a source (the same name can come from a different one in each project). */
export function candidatePanel(c: Candidate, id: string, ownerKind: OwnerKind): NewPanel {
  const base = newPanel(c.panelType, id, { x: 0, y: 0, ...DEFAULT_SIZES[c.panelType] });
  const options: Record<string, unknown> = { ...base.options };
  if ("unit" in options) options.unit = c.unit; // logs options have no unit (the schema refuses it)
  Object.assign(options, c.options);
  const { layout: _layout, ...rest } = base;
  void _layout;
  return {
    ...rest,
    title: c.title,
    queries: [
      {
        ref: "A",
        source: { type: c.sourceType, id: ownerKind === "group" ? null : c.sourceId },
        expr: c.expr,
        legend: c.legend,
        hidden: false,
      },
    ],
    options,
  } as unknown as NewPanel;
}
