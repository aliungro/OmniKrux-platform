import type { Cluster, KindInfo, ResourceRow } from "../../api/types";
import { kindSearchAliases, matchTier } from "../palette/commands";
import { kindTitle, type Territory } from "../territories/model";

export type HomeResult =
  | { group: "Clusters"; cluster: Cluster }
  | { group: "Kinds"; kind: KindInfo }
  | { group: "Pods"; row: ResourceRow; cluster: Cluster }
  | { group: "Find"; kind: KindInfo; text: string };

function ranked<T>(q: string, items: T[], words: (item: T) => readonly string[], aliases?: (item: T) => readonly string[]): T[] {
  return items.map(item => ({ item, tier: matchTier(q, words(item), aliases?.(item)) }))
    .filter((hit): hit is { item: T; tier: number } => hit.tier !== null)
    .sort((a, b) => a.tier - b.tier).slice(0, 8).map(hit => hit.item);
}

/** Uses only the pods already watched for the cards; searching never opens another watch. */
export function searchHome(query: string, ctx: { clusters: Cluster[]; kinds: KindInfo[]; pods: Territory[]; pinned: readonly string[] }): HomeResult[] {
  const q = query.trim();
  if (!q) return [];
  const clusters: HomeResult[] = ranked(q, ctx.clusters, c => [c.name]).map(cluster => ({ group: "Clusters", cluster }));
  const kinds: HomeResult[] = ranked(q, ctx.kinds, k => [kindTitle(k), k.plural_label, k.plural, k.kind, k.label, k.key, ...k.short_names], kindSearchAliases)
    .map(kind => ({ group: "Kinds", kind }));
  const rows = ctx.pods.filter(t => t.state === "ready").flatMap(t => t.rows.map(row => ({ row, cluster: t.cluster })));
  const pods: HomeResult[] = ranked(q, rows, p => [p.row.name]).map(p => ({ group: "Pods", ...p }));
  const served = new Map(ctx.kinds.filter(k => k.clusters.length > 0).map(k => [k.key, k]));
  const find: HomeResult[] = ctx.pinned.filter(key => key !== "pods" && served.has(key)).slice(0, 8)
    .map(key => ({ group: "Find", kind: served.get(key)!, text: q }));
  return [...clusters, ...kinds, ...pods, ...find];
}
