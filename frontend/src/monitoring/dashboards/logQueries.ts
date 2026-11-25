// Log queries in panels that draw charts: a Loki selector lists lines, and only a logs panel shows them.
import { isLogQuery } from "../alerts/limits";
import type { PanelSpec, QuerySpec } from "./schema";

export const LOG_QUERY_IN_CHART = "This is a log query: it lists lines, and a chart can't draw lines.";
export const SWITCH_TO_LOGS = "Switch to a logs panel";

/** A Loki query that is a log selector (a LogQL metric query like `count_over_time(...)` is not). */
export const isLokiLogQuery = (q: QuerySpec): boolean => q.source.type === "loki" && isLogQuery(q.expr);

/** A chart panel (any type but logs) with a visible Loki log query. */
export const logQueryInChart = (panel: PanelSpec): boolean =>
  panel.type !== "logs" && panel.queries.some((q) => !q.hidden && isLokiLogQuery(q));

/** The panel with its first visible log query in front (a logs panel keeps only the first query). */
export function logQueryFirst(panel: PanelSpec): PanelSpec {
  const at = panel.queries.findIndex((q) => !q.hidden && isLokiLogQuery(q));
  if (at <= 0) return panel;
  return { ...panel, queries: [panel.queries[at], ...panel.queries.filter((_, i) => i !== at)] };
}
