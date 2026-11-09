import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { KindInfo } from "../../api/types";
import { kindTitle } from "../territories/model";
import { capsOf } from "./shortcuts";
import k from "./key.module.css";
import s from "./KindTabs.module.css";

/** Arrow keys show a kind once they rest this long, so moving across tabs opens one watch, not one per tab. */
export const ARROW_SETTLE_MS = 250;

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

function tabsFor(kinds: KindInfo[] | undefined, active: string, extra: string | null): Tab[] {
  const byKey = new Map((kinds ?? []).map((x) => [x.key, x]));
  // Before the kinds have loaded, only the one you're looking at: no tab that might not exist.
  const tabs: Tab[] = TAB_KINDS.filter((key) => (kinds ? byKey.has(key) : key === active)).map((key) => ({
    key,
    title: kindTitle(byKey.get(key) ?? { key, plural_label: key }),
  }));
  // A kind outside the everyday ones (a CRD from the palette or a link) gets its own tab while open.
  for (const key of [active, extra]) {
    if (key === null || tabs.some((t) => t.key === key)) continue;
    tabs.push({ key, title: kindTitle(byKey.get(key) ?? { key, plural_label: key.split(".")[0] }) });
  }
  return tabs;
}

export function KindTabs({
  kinds,
  active,
  count,
  onSelect,
  error = null,
  onRetry,
  onAllKinds,
}: {
  /** Every kind some cluster serves; undefined until GET /api/kinds has answered. */
  kinds: KindInfo[] | undefined;
  active: string;
  /** The active kind's rows across ready clusters; null until one has reported (never a made-up 0). */
  count: number | null;
  /** `replace`: the move shouldn't add a history entry (arrowing across tabs). */
  onSelect: (key: string, opts?: { replace: boolean }) => void;
  /** Why the kinds couldn't be loaded, in plain words; null when they could (or are loading). */
  error?: string | null;
  onRetry?: () => void;
  /** Opens the palette on every kind (its `:` mode). */
  onAllKinds?: () => void;
}) {
  /** Where the arrow keys have moved to, before that kind is shown. */
  const [moving, setMoving] = useState<string | null>(null);
  const shown = moving ?? active;
  const tabs = tabsFor(kinds, active, moving);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  // Left and right move between tabs, as a tablist should; the kind follows once the keys rest.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const at = tabs.findIndex((t) => t.key === shown);
    if (at < 0) return;
    e.preventDefault();
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].key;
    setMoving(next);
    refs.current.get(next)?.focus();
    stop();
    timer.current = setTimeout(() => {
      timer.current = null;
      setMoving(null);
      if (next !== active) onSelect(next, { replace: true });
    }, ARROW_SETTLE_MS);
  };

  const choose = (key: string) => {
    stop();
    setMoving(null);
    onSelect(key);
  };

  return (
    <nav className={s.kinds} aria-label="Resource kinds" data-page-keys>
      <div role="tablist" aria-label="Kinds" className={s.list} onKeyDown={onKey}>
        {tabs.map((t) => {
          const on = t.key === shown;
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
              onClick={() => choose(t.key)}
            >
              {t.title}
              {t.key === active && on && count !== null && <em className={s.n}>{count}</em>}
            </button>
          );
        })}
      </div>
      {kinds !== undefined && onAllKinds && (
        <button type="button" className={s.more} aria-haspopup="dialog" aria-keyshortcuts=":" onClick={onAllKinds}>
          All {kinds.length} kinds
          <span className={k.k} aria-hidden="true">{capsOf("kinds")[0]}</span>
        </button>
      )}
      {error !== null && (
        <span className={s.err}>
          <span role="alert">Can't load the list of kinds: {error}</span>
          {onRetry && (
            <button type="button" className={s.retry} onClick={onRetry}>
              Retry
            </button>
          )}
        </span>
      )}
    </nav>
  );
}
