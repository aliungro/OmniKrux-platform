import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { KindInfo } from "../../api/types";
import { kindTitle } from "../territories/model";
import { ContextMenu, isMenuKey, menuAnchor, type MenuAnchor, type MenuItem } from "./ContextMenu";
import { routesKindKeys } from "./pageKeys";
import { capsOf, pageKey, pressed } from "./shortcuts";
import k from "./key.module.css";
import s from "./KindTabs.module.css";

/** Arrow keys show a kind once they rest this long, so moving across tabs opens one watch, not one per tab. */
export const ARROW_SETTLE_MS = 250;

interface Tab {
  key: string;
  title: string;
}

function tabsFor(kinds: KindInfo[] | undefined, active: string, extra: string | null, pinned: readonly string[]): Tab[] {
  const byKey = new Map((kinds ?? []).map((x) => [x.key, x]));
  // Before the kinds have loaded, only the one you're looking at: no tab that might not exist.
  const tabs: Tab[] = pinned.filter((key) => (kinds ? (byKey.get(key)?.clusters.length ?? 0) > 0 : key === active)).map((key) => ({
    key,
    title: kindTitle(byKey.get(key) ?? { key, plural_label: key }),
  }));
  // A kind outside the everyday ones (a CRD from the palette or a link) gets its own tab while open.
  for (const key of [active, extra]) {
    if (key === null || tabs.some((t) => t.key === key)) continue;
    if (kinds !== undefined && pinned.includes(key) && !(byKey.get(key)?.clusters.length)) continue;
    tabs.push({ key, title: kindTitle(byKey.get(key) ?? { key, plural_label: key.split(".")[0] }) });
  }
  return tabs;
}

export function KindTabs({
  kinds,
  active,
  navigationView,
  paneActive = true,
  count,
  onSelect,
  error = null,
  onRetry,
  onAllKinds,
  onOpenKind,
  pinned, onPin, onUnpin, onMove, onEditPinned,
}: {
  /** Every kind some cluster serves; undefined until GET /api/kinds has answered. */
  kinds: KindInfo[] | undefined;
  active: string;
  navigationView?: unknown;
  paneActive?: boolean;
  /** The active kind's rows across ready clusters; null until one has reported (never a made-up 0). */
  count: number | null;
  /** `replace`: the move shouldn't add a history entry (arrowing across tabs). */
  onSelect: (key: string, opts?: { replace: boolean }) => void;
  /** Why the kinds couldn't be loaded, in plain words; null when they could (or are loading). */
  error?: string | null;
  onRetry?: () => void;
  /** Opens the palette on every kind (its `:` mode). */
  onAllKinds?: () => void;
  onOpenKind?: (key: string, split?: boolean) => void;
  pinned: readonly string[];
  onPin: (key: string) => void;
  onUnpin: (key: string) => void;
  onMove: (key: string, by: -1 | 1) => void;
  onEditPinned: () => void;
}) {
  /** Where the arrow keys have moved to, before that kind is shown. */
  const [moving, setMoving] = useState<string | null>(null);
  const shown = moving ?? active;
  const tabs = tabsFor(kinds, active, moving, pinned);
  const [menu, setMenu] = useState<{ key: string; anchor: MenuAnchor } | null>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const run = useRef(false);
  const expected = useRef<string | null>(null);
  const previousActive = useRef(active);
  const previousView = useRef(navigationView);
  useEffect(() => stop, []);
  useLayoutEffect(() => {
    if (paneActive && previousActive.current === active && previousView.current === navigationView) return;
    previousActive.current = active;
    previousView.current = navigationView;
    if (paneActive && expected.current === active) { expected.current = null; return; }
    expected.current = null;
    run.current = false;
    stop();
    setMoving(null);
  }, [active, navigationView, paneActive]);

  const openMenu = (key: string, anchor: MenuAnchor) => {
    stop(); setMoving(null); run.current = false;
    setMenu({ key, anchor });
  };

  // The console, resource rows and the kind strip share one arrow sequence and settle timer.
  const onKey = useEffectEvent((e: globalThis.KeyboardEvent) => {
    if (!paneActive || e.shiftKey || !pressed("moveKind", e) || !pageKey(e)) return;
    const inStrip = e.target instanceof Node && tabList.current?.contains(e.target);
    if (!inStrip && !routesKindKeys(e.target)) return;
    const at = tabs.findIndex((t) => t.key === shown);
    if (at < 0 || tabs.length < 2) return;
    e.preventDefault();
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].key;
    setMoving(next);
    refs.current.get(next)?.focus();
    stop();
    timer.current = setTimeout(() => {
      timer.current = null;
      setMoving(null);
      if (next !== active) {
        expected.current = next;
        onSelect(next, { replace: run.current });
        run.current = true;
      }
    }, ARROW_SETTLE_MS);
  });
  useEffect(() => {
    const onDocumentKey = (e: globalThis.KeyboardEvent) => onKey(e);
    document.addEventListener("keydown", onDocumentKey);
    return () => document.removeEventListener("keydown", onDocumentKey);
  }, []);

  const choose = (key: string) => {
    stop();
    run.current = false;
    expected.current = null;
    setMoving(null);
    onSelect(key);
  };

  const menuTitle = menu && (tabs.find((tab) => tab.key === menu.key)?.title ?? menu.key);
  const items: MenuItem[] = [];
  if (menu) {
    const { key } = menu;
    if (onOpenKind) items.push(
      { id: "open", label: "Open in new tab", onSelect: () => onOpenKind(key), restoreFocus: false },
      { id: "open-split", label: "Open in new split tab", onSelect: () => onOpenKind(key, true), restoreFocus: false },
    );
    const index = pinned.indexOf(key);
    if (index !== -1) {
      items.push(
        { id: "left", label: "Move left", disabled: index === 0, onSelect: () => onMove(key, -1) },
        { id: "right", label: "Move right", disabled: index === pinned.length - 1, onSelect: () => onMove(key, 1) },
        { id: "unpin", label: `Unpin ${menuTitle}`, restoreFocus: false, onSelect: () => {
          onUnpin(key);
          refs.current.get(active)?.focus();
        } },
      );
    }
    items.push({ id: "pins", label: "Edit pinned kinds…", onSelect: onEditPinned, divider: items.length > 0, restoreFocus: false });
  }

  return (
    <nav className={s.kinds} aria-label="Resource kinds" data-page-keys>
      <div ref={tabList} role="tablist" aria-label="Kinds" className={s.list} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { run.current = false; stop(); setMoving(null); } }}>
        {tabs.map((t) => {
          const on = t.key === shown;
          return (
            <div key={t.key} className={s.tabGroup}>
            <button
              ref={(el) => {
                if (el) refs.current.set(t.key, el);
                else refs.current.delete(t.key);
              }}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className={`${s.tab}${on ? ` ${s.on}` : ""}`}
              title={pinned.includes(t.key) ? undefined : t.key}
              aria-haspopup="menu"
              aria-expanded={menu?.key === t.key}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); openMenu(t.key, menuAnchor(e.currentTarget, e)); }}
              onKeyDown={e => { if (isMenuKey(e)) { e.preventDefault(); e.stopPropagation(); openMenu(t.key, menuAnchor(e.currentTarget)); } }}
              onClick={() => choose(t.key)}
            >
              {t.title}
              {t.key === active && on && count !== null && <em className={s.n}>{count}</em>}
            </button>
            {t.key === active && !pinned.includes(t.key) && <button type="button" className={s.pin}
              aria-label={`Pin ${t.title}`} title={`Keep ${t.title} in the tab row`} onClick={() => onPin(t.key)}>＋</button>}
            </div>
          );
        })}
      </div>
      {menu && <ContextMenu anchor={menu.anchor} label={`${menuTitle} tab`} items={items} onClose={() => setMenu(null)} />}
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
