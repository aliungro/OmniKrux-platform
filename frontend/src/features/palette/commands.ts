import type { KindInfo, ResourceRow } from "../../api/types";
import type { RowAction } from "../actions/tools";
import { capsOf } from "../chrome/shortcuts";
import { DEFAULT_PINNED } from "../settings/pinnedKinds";
import { kindTitle, rowTitle } from "../territories/model";

export type CommandGroup = "Kinds" | "Actions" | "Views" | "Flux" | "Custom resources";

export interface Command {
  id: string;
  label: string;
  /** Said after the label, quieter: a kind's full key. */
  hint?: string;
  group: CommandGroup;
  /** What else it answers to: plural, kind, key and short names for a kind. */
  keywords: string[];
  /** Its keycaps, for an action that also has a key on the row. */
  keys?: readonly string[];
  run: () => void;
}

/** The selected row, as the palette offers actions on it. */
export interface SelectedRow {
  row: ResourceRow;
  kind: KindInfo;
  /** The cluster's name, so the palette says where an action lands. */
  clusterName: string;
  /** What the row offers (`rowActions`). */
  actions: readonly RowAction[];
}

export interface CommandContext {
  /** Every kind some cluster serves. */
  kinds: readonly KindInfo[];
  pinned?: readonly string[];
  onKind: (key: string) => void;
  selected: SelectedRow | null;
  /** Runs an action on the selected row the way its key would: the same forms and reviews. */
  onRowAction: (action: RowAction) => void;
  onAudit: () => void;
  onSettings?: () => void;
  onNewTab?: () => void;
  onCloseTab?: () => void;
  /** Opens the port-forwards menu; absent while there are none. */
  onForwards?: () => void;
}

/** Groups in the order an empty palette lists them. */
export const GROUP_ORDER: readonly CommandGroup[] = ["Actions", "Views", "Kinds", "Flux", "Custom resources"];
/** The groups kind mode (`:`) shows. */
export const KIND_GROUPS: ReadonlySet<CommandGroup> = new Set<CommandGroup>(["Kinds", "Flux", "Custom resources"]);

const FLUX = ".toolkit.fluxcd.io";

function kindGroup(k: KindInfo): CommandGroup {
  if (k.key.endsWith(FLUX)) return "Flux";
  return k.builtin ? "Kinds" : "Custom resources";
}

/** The everyday kinds in tab order, then the rest by title. */
function kindOrder(a: KindInfo, b: KindInfo, tabs: readonly string[]): number {
  const ia = tabs.indexOf(a.key);
  const ib = tabs.indexOf(b.key);
  if (ia >= 0 || ib >= 0) return (ia < 0 ? tabs.length : ia) - (ib < 0 ? tabs.length : ib);
  return kindTitle(a).localeCompare(kindTitle(b));
}

/** "Scale web…": an ellipsis where a form or a review comes first. */
const ACTION_LABEL: Record<RowAction, (name: string) => string> = {
  details: (n) => `Details of ${n}`,
  yaml: (n) => `YAML of ${n}`,
  logs: (n) => `Logs of ${n}`,
  previousLogs: (n) => `Previous logs of ${n}`,
  shell: (n) => `Shell in ${n}`,
  workloadLogs: (n) => `Logs of ${n}'s pods`,
  reveal: (n) => `Keys of ${n}`,
  edit: (n) => `Edit ${n}…`,
  scale: (n) => `Scale ${n}…`,
  restart: (n) => `Restart ${n}…`,
  rollback: (n) => `Roll back ${n}…`,
  cordon: (n) => `Cordon ${n}…`,
  uncordon: (n) => `Uncordon ${n}…`,
  drain: (n) => `Drain ${n}…`,
  nodeShell: (n) => `Shell on node ${n}…`,
  portForward: (n) => `Port-forward ${n}…`,
  delete: (n) => `Delete ${n}…`,
};

export function buildCommands(ctx: CommandContext): Command[] {
  const out: Command[] = [];
  const sel = ctx.selected;
  if (sel) {
    const title = rowTitle(sel.row);
    for (const action of sel.actions) {
      out.push({
        id: `action:${action}`,
        label: ACTION_LABEL[action](title),
        group: "Actions",
        keywords: [action, title, sel.row.name, sel.kind.label, sel.row.kind],
        keys: action === "rollback" ? undefined : capsOf(action),
        run: () => ctx.onRowAction(action),
      });
    }
  }
  out.push({ id: "view:audit", label: "Audit log", group: "Views", keywords: ["audit", "history", "changes"], run: ctx.onAudit });
  if (ctx.onSettings) out.push({id:"view:settings",label:"Settings",group:"Views",keywords:["settings","preferences","pinned kinds"],run:ctx.onSettings});
  if (ctx.onNewTab) out.push({id:"view:new-tab",label:"New tab",group:"Views",keywords:["new tab"],run:ctx.onNewTab});
  if (ctx.onCloseTab) out.push({id:"view:close-tab",label:"Close tab",group:"Views",keywords:["close tab"],run:ctx.onCloseTab});
  if (ctx.onForwards) {
    out.push({ id: "view:forwards", label: "Port-forwards", group: "Views", keywords: ["forwards", "ports"], run: ctx.onForwards });
  }
  const kinds = [...ctx.kinds].sort((a, b) => kindOrder(a, b, ctx.pinned ?? DEFAULT_PINNED));
  for (const group of ["Kinds", "Flux", "Custom resources"] as const) {
    for (const k of kinds.filter((x) => kindGroup(x) === group)) {
      out.push({
        id: `kind:${k.key}`,
        label: kindTitle(k),
        hint: k.key,
        group,
        keywords: [k.plural_label, k.plural, k.kind, k.label, k.key, ...k.short_names],
        run: () => ctx.onKind(k.key),
      });
    }
  }
  return out;
}

export const MAX_RESULTS = 50;

/** Whether `q`'s letters appear in `text` in order. */
function subsequence(q: string, text: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
  return q.length === 0;
}

/** 0: a keyword is the query (a short name, a plural); 1: something starts with it; 2: its letters in order. */
function tier(q: string, c: Command): number | null {
  const words = [c.label, ...c.keywords].map((w) => w.toLowerCase());
  if (words.some((w) => w === q)) return 0;
  const parts = words.flatMap((w) => [w, ...w.split(/[^a-z0-9]+/)]);
  if (parts.some((w) => w.startsWith(q))) return 1;
  if (words.some((w) => subsequence(q, w))) return 2;
  return null;
}

/**
 * The commands that match, best first: an exact short name (or name), then a prefix, then the
 * query's letters in order; ties keep their order. At most 50; an empty query keeps them all in order.
 */
export function rankCommands(query: string, cmds: readonly Command[]): Command[] {
  const q = query.trim().toLowerCase();
  if (q === "") return cmds.slice(0, MAX_RESULTS);
  const scored: [number, Command][] = [];
  for (const c of cmds) {
    const t = tier(q, c);
    if (t !== null) scored.push([t, c]);
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_RESULTS)
    .map(([, c]) => c);
}
