import type { EventInfo } from "../../api/types";
import { formatAge } from "../territories/model";
import s from "./EventsTable.module.css";

/**
 * Events as the backend grouped them: Warnings first, then newest first.
 * When listing failed, `error` says why; an empty list would claim there were none.
 */
export function EventsTable({ events, error }: { events: EventInfo[]; error: string | null }) {
  if (error !== null) {
    return <p className={s.error} role="note">{error}</p>;
  }
  if (events.length === 0) return <p className={s.none}>No events</p>;
  const now = new Date();
  return (
    <table className={s.ev}>
      <tbody>
        {events.map((e, i) => {
          const warning = e.type === "Warning";
          return (
            <tr key={`${e.type}\u0000${e.reason}\u0000${e.message}\u0000${i}`} className={warning ? s.wa : s.no}>
              <td className={s.ty}>
                <i aria-label={warning ? "Warning" : e.type} title={e.type} />
              </td>
              <td>
                <div className={s.rs}>
                  {e.reason || "No reason given"}
                  {e.count > 1 && <> <span className={s.x}>×{e.count}</span></>}
                </div>
                {e.message && <div className={s.ms}>{e.message}</div>}
              </td>
              <td className={s.ag} title={e.last_seen ?? "Time not reported"}>
                {formatAge(e.last_seen, now)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
