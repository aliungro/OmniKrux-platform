// What won't be copied, grouped under where it is (the dashboard, a panel, a variable), in the
// order the converter found it. Reused by setup's import step and Update from source.
import type { SkippedOut } from "./api";
import s from "./ImportReview.module.css";

const STATE_WORDS: Record<string, string> = {
  nodata: "it shows no data",
  ok: "it counts as OK",
  alerting: "it alerts",
  keeplast: "it keeps its last state",
  keepstate: "it keeps its last state",
  error: "it shows an error",
};

/** Grafana's alert state fields in plain words; every other item as the converter wrote it. */
export function plainWhat(what: string): string {
  const m = /^(No data|Error) state (.+)$/.exec(what);
  if (!m) return what;
  const state = m[2];
  const words = STATE_WORDS[state.toLowerCase().replace(/[\s_]/g, "")] ?? state;
  return `${m[1] === "No data" ? "When there's no data" : "When the query fails"}: ${words}`;
}

export function SkippedList({ items }: { items: SkippedOut[] }) {
  const groups: { where: string; items: SkippedOut[] }[] = [];
  for (const item of items) {
    const last = groups.find((g) => g.where === item.where);
    if (last) last.items.push(item);
    else groups.push({ where: item.where, items: [item] });
  }
  return (
    <div className={s.skipped}>
      {groups.map((g) => (
        <div key={g.where} className={s.skippedGroup}>
          <p className={s.skippedWhere}>{g.where}</p>
          <ul className={s.skippedItems}>
            {g.items.map((item, i) => (
              <li key={i}><b>{plainWhat(item.what)}</b> — {item.reason}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
