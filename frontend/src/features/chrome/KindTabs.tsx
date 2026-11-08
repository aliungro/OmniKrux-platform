import { useRef, type KeyboardEvent } from "react";
import type { KindInfo } from "../../api/types";
import { kindTitle } from "../territories/model";
import k from "./key.module.css";
import s from "./KindTabs.module.css";

/** The everyday kinds, in this order, each shown when at least one cluster serves it. */
export const TAB_KINDS = [
  "pods",
  "deployments.apps",
  "statefulsets.apps",
  "daemonsets.apps",
  "jobs.batch",
  "services",
  "ingresses.networking.k8s.io",
  "nodes",
  "events",
  "helm-releases",
] as const;

interface Tab {
  key: string;
  title: string;
}

function tabsFor(kinds: KindInfo[] | undefined, active: string): Tab[] {
  const byKey = new Map((kinds ?? []).map((x) => [x.key, x]));
  // Before the kinds have loaded, only the one you're looking at: no tab that might not exist.
  const tabs: Tab[] = TAB_KINDS.filter((key) => (kinds ? byKey.has(key) : key === active)).map((key) => ({
    key,
    title: kindTitle(byKey.get(key) ?? { key, plural_label: key }),
  }));
  // A kind outside the everyday ones (a CRD from the palette or a link) gets its own tab while open.
  if (!tabs.some((t) => t.key === active)) {
    tabs.push({ key: active, title: kindTitle(byKey.get(active) ?? { key: active, plural_label: active.split(".")[0] }) });
  }
  return tabs;
}

export function KindTabs({
  kinds,
  active,
  count,
  onSelect,
}: {
  /** Every kind some cluster serves; undefined until GET /api/kinds has answered. */
  kinds: KindInfo[] | undefined;
  active: string;
  /** The active kind's rows across ready clusters; null until one has reported (never a made-up 0). */
  count: number | null;
  onSelect: (key: string) => void;
}) {
  const tabs = tabsFor(kinds, active);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  // Left and right move between tabs (and show that kind), as a tablist should.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const at = tabs.findIndex((t) => t.key === active);
    if (at < 0) return;
    e.preventDefault();
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    onSelect(next.key);
    refs.current.get(next.key)?.focus();
  };

  return (
    <nav className={s.kinds} aria-label="Resource kinds">
      <div role="tablist" aria-label="Kinds" className={s.list} onKeyDown={onKey}>
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              ref={(el) => {
                if (el) refs.current.set(t.key, el);
                else refs.current.delete(t.key);
              }}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className={`${s.tab}${on ? ` ${s.on}` : ""}`}
              title={(TAB_KINDS as readonly string[]).includes(t.key) ? undefined : t.key}
              onClick={() => onSelect(t.key)}
            >
              {t.title}
              {on && count !== null && <em className={s.n}>{count}</em>}
            </button>
          );
        })}
      </div>
      {kinds && (
        // The palette (Task 15) opens from here and from ":".
        <span className={s.more} data-testid="all-kinds">
          All {kinds.length} kinds
          <span className={k.k} aria-hidden="true">:</span>
        </span>
      )}
    </nav>
  );
}
