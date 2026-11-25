// The dashboard's header, one row: where it lives and its title, its views, the time range,
// refreshing, Edit (or Copy to edit) and More actions; in edit mode, Discard and Save dashboard.
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { escapeCloses } from "../../focus";
import { closesOnLeave, menuKeys, POPUP, useCloseOutside } from "./popover";
import s from "./DashboardPage.module.css";

export type DashboardTab = "dashboard" | "json" | "versions";
export const TAB_LABELS: Record<DashboardTab, string> = { dashboard: "Dashboard", json: "JSON", versions: "Versions" };

export interface MenuAction {
  label: string;
  /** Absent: shown, but not available yet. */
  onSelect?(): void;
  danger?: boolean;
}

function ActionsMenu({ actions, buttonRef }: { actions: MenuAction[]; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) buttonRef.current?.focus();
  }, [buttonRef]);
  const closeQuietly = useCallback(() => close(false), [close]);
  useCloseOutside(open, root, closeQuietly);
  useLayoutEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  return (
    <div ref={root} className={s.popAnchor}>
      <button ref={buttonRef} type="button" className={s.iconButton} aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div {...POPUP} className={`${s.popup} ${s.popupEnd}`} onKeyDown={escapeCloses(() => close(true))} onBlur={closesOnLeave(closeQuietly)}>
          <div ref={menu} role="menu" aria-label="More actions" className={s.menu} onKeyDown={menuKeys}>
            {actions.map((a) => (
              <button key={a.label} type="button" role="menuitem" tabIndex={-1} className={s.menuItem}
                data-danger={a.danger || undefined} aria-disabled={a.onSelect ? undefined : true}
                onClick={() => { if (!a.onSelect) return; close(true); a.onSelect(); }}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  title: string;
  titleId: string;
  titleRef: RefObject<HTMLHeadingElement | null>;
  ownerName: string;
  onOwner(e: MouseEvent<HTMLAnchorElement>): void;
  readyMade: boolean;
  tabs: DashboardTab[];
  tab: DashboardTab;
  tabIds: (tab: DashboardTab) => { tab: string; panel: string };
  onTab(tab: DashboardTab): void;
  tabRefs: RefObject<Partial<Record<DashboardTab, HTMLButtonElement | null>>>;
  timeControl: ReactNode;
  refreshControl: ReactNode;
  editRef: RefObject<HTMLButtonElement | null>;
  /** Edit (a saved dashboard) or Copy to edit (a ready-made view); absent: not available yet. */
  onEdit?(): void;
  moreRef: RefObject<HTMLButtonElement | null>;
  actions: MenuAction[];
  /** After the title, such as the Editing pill. */
  badge?: ReactNode;
  /** Edit mode: these replace Edit and More actions. */
  editControls?: ReactNode;
  /** Right after the title in Tab order (an offered draft); it draws on its own row. */
  afterTitle?: ReactNode;
}

export function DashboardHeader(p: Props) {
  // Arrow keys move between the views, like any tab list; Home and End go to the ends.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = p.tabs.indexOf(p.tab);
    const next = e.key === "ArrowRight" ? p.tabs[(at + 1) % p.tabs.length]
      : e.key === "ArrowLeft" ? p.tabs[(at - 1 + p.tabs.length) % p.tabs.length]
      : e.key === "Home" ? p.tabs[0] : e.key === "End" ? p.tabs[p.tabs.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    p.onTab(next);
  };
  return (
    <header className={s.header}>
      <div className={s.heading}>
        <p className={s.crumb}>
          <a href="#" className={s.owner} onClick={(e) => { e.preventDefault(); p.onOwner(e); }}>{p.ownerName}</a>
          <span className={s.slash} aria-hidden="true">/</span>
        </p>
        <h1 id={p.titleId} ref={p.titleRef} tabIndex={-1} className={s.title} title={p.title}>{p.title}</h1>
        {p.readyMade && <span className={s.readyTag}>Ready-made</span>}
        {p.badge}
      </div>
      {p.afterTitle}
      <div role="tablist" aria-label="Dashboard views" className={s.tabs} onKeyDown={onTabKey}>
        {p.tabs.map((t, i) => {
          const ids = p.tabIds(t);
          const on = t === p.tab;
          return (
            <button key={t} ref={(el) => { p.tabRefs.current[t] = el; }} id={ids.tab} type="button" role="tab" aria-selected={on}
              aria-controls={on ? ids.panel : undefined} tabIndex={on ? 0 : -1} aria-keyshortcuts={String(i + 1)}
              className={s.tab} onClick={() => p.onTab(t)}>
              {TAB_LABELS[t]}
            </button>
          );
        })}
      </div>
      <div className={s.controls}>
        {p.timeControl}
        {p.refreshControl}
        {p.editControls ?? (
          <>
            <button ref={p.editRef} type="button" className={s.edit} aria-keyshortcuts={p.readyMade ? undefined : "e"}
              aria-disabled={p.onEdit ? undefined : true} onClick={() => p.onEdit?.()}>
              {p.readyMade ? "Copy to edit" : "Edit"}
            </button>
            <ActionsMenu actions={p.actions} buttonRef={p.moreRef} />
          </>
        )}
      </div>
    </header>
  );
}
