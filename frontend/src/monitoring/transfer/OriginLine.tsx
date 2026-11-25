// Under an imported dashboard's Updated line: where it came from and when, and when it was last
// updated from there. Nothing for a dashboard that wasn't imported, nor while that isn't known.
import { useOrigin, type OriginOut } from "./api";
import x from "./UpdateFromSourceDialog.module.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Mar 2026", in the reader's own time zone; the text as given when it isn't a time. */
export function dayWords(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function originWords(o: Pick<OriginOut, "label" | "imported_at" | "updated_at">): string {
  const imported = `Imported from ${o.label} on ${dayWords(o.imported_at)}`;
  return o.updated_at ? `${imported} · updated from it on ${dayWords(o.updated_at)}` : imported;
}

export function OriginLine({ dashboardId }: { dashboardId: string }) {
  const origin = useOrigin(dashboardId);
  if (!origin.data) return null;
  return <p className={x.originLine}>{originWords(origin.data)}</p>;
}
