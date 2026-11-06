import s from "./KindTabs.module.css";

/** Plan 1 knows one kind; more tabs arrive with Plan 3. */
export type Kind = "pods";

const LABEL: Record<Kind, string> = { pods: "Pods" };
const KINDS: Kind[] = ["pods"];

export function KindTabs({ active, counts }: { active: Kind; counts: Record<Kind, number | null> }) {
  return (
    <nav className={s.kinds} aria-label="Resource kinds">
      <div role="tablist" className={s.list}>
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={kind === active}
            className={`${s.tab}${kind === active ? ` ${s.on}` : ""}`}
          >
            {LABEL[kind]}
            {counts[kind] !== null && <em className={s.n}>{counts[kind]}</em>}
          </button>
        ))}
      </div>
    </nav>
  );
}
