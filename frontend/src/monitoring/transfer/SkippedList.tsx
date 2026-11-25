// What won't be copied, grouped under where it is (the dashboard, a panel, a variable), in the
// order the converter found it. Reused by setup's import step and Update from source.
import type { SkippedOut } from "./api";
import s from "./ImportReview.module.css";

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
              <li key={i}><b>{item.what}</b> — {item.reason}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
