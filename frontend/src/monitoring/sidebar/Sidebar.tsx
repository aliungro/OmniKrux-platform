import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import k from "../../features/chrome/key.module.css";
import { loudFiring } from "../alerts/api";
import { useFreshOverview } from "../home/FiringSection";
import type { TreeColor, TreeOut } from "../api/types";
import { focusHeadingOnArrival } from "../dashboards/create/arrival";
import { ownerOfDashboard, type Owner } from "../dashboards/create/currentOwner";
import type { SearchEntry } from "../search/search";
import type { MonitoringView } from "../shell/tabState";
import { FindBox } from "./FindBox";
import { NewDashboardBar } from "./NewDashboardBar";
import { groupKey, projectKey, readExpanded, saveExpanded, treeRows, type TreeRow } from "./treeModel";
import s from "./Sidebar.module.css";

export const DOT: Record<TreeColor, string> = {
  aks: "var(--aks)", eks: "var(--eks)", gke: "var(--gke)", oke: "var(--oke)", kind: "var(--kind)", onprem: "var(--onprem)", custom: "var(--focus)",
};

interface Props {
  view: MonitoringView;
  tree: TreeOut | undefined;
  /** The tree couldn't be read (and nothing is cached). */
  treeFailed: boolean;
  onRetry(): void;
  index: SearchEntry[];
  onOpen(view: MonitoringView, newTab: boolean): void;
  /** Gives the keyboard back to the workspace's <main>. */
  onLeave(): void;
  /** Where new dashboards go (the open page's project or group, else the most recent one). */
  owner: Owner | null;
  /** Opens New dashboard for `owner` (null: picked in the dialog); the keyboard returns to `from`. */
  onNewDashboard(owner: Owner | null, from: HTMLElement): void;
  /** Find's field, for MonitoringApp's `openFind`. */
  findInput: RefObject<HTMLInputElement | null>;
  /**
   * A narrow window: the sidebar is a drawer, shown only while `open`. Esc in it (when nothing in it
   * took the key) and the keyboard moving out of it close it.
   */
  drawer?: { id: string; open: boolean; onEscape(): void; onFocusOut(to: Element): void };
}

const FOCUSABLE = new Set<TreeRow["kind"]>(["group", "project", "shortcut", "dashboard"]);
const ctrl = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

/** The row the open page belongs to: the project's own row, the group's, or the dashboard's. */
function currentKey(view: MonitoringView, rows: TreeRow[]): string | null {
  if (view.page === "project") return projectKey(view.id);
  if (view.page === "group") return groupKey(view.id);
  if (view.page === "dashboard") return rows.find((r) => r.kind === "dashboard" && r.view?.page === "dashboard" && r.view.id === view.id)?.key ?? null;
  return null;
}

/** The open page's own row (not a group's shortcut to a project). */
function isOpenPage(row: TreeRow, view: MonitoringView): boolean {
  if (row.kind === "shortcut" || !row.view || row.view.page !== view.page) return false;
  return "id" in row.view && "id" in view && row.view.id === view.id;
}

/**
 * Explore opened from the sidebar: on the active tab's own project (a project page, or a project's
 * dashboard), or Explore's own when the tab is already Explore; else Explore picks (F28).
 */
export function exploreFrom(view: MonitoringView, tree: TreeOut | undefined): MonitoringView {
  if (view.page === "explore") return view.project ? { page: "explore", project: view.project } : { page: "explore" };
  if (view.page === "project") return { page: "explore", project: view.id };
  if (view.page === "dashboard" && tree) {
    const owner = ownerOfDashboard(tree, view.id);
    if (owner?.kind === "project") return { page: "explore", project: owner.id };
  }
  return { page: "explore" };
}

const ICONS: Record<"home" | "explore" | "alerts" | "sources", ReactNode> = {
  home: <path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5Z" />,
  explore: <><circle cx="8" cy="8" r="5.5" /><path d="m10.25 5.75-1.4 3.1-3.1 1.4 1.4-3.1Z" /></>,
  alerts: <path d="M4 11.5V7.25a4 4 0 0 1 8 0v4.25l1 1H3ZM6.75 14h2.5" />,
  sources: <><ellipse cx="8" cy="4" rx="5" ry="1.75" /><path d="M3 4v8c0 .97 2.24 1.75 5 1.75s5-.78 5-1.75V4M3 8c0 .97 2.24 1.75 5 1.75S13 8.97 13 8" /></>,
};

export function Sidebar({ view, tree, treeFailed, onRetry, index, onOpen, onLeave, owner, onNewDashboard, findInput, drawer }: Props) {
  const counts = useFreshOverview()?.counts;
  const firing = counts ? loudFiring(counts) : 0;
  const [expanded, setExpanded] = useState(readExpanded);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  // The row that last had the keyboard, while the keyboard is still in the tree.
  const lastFocused = useRef<HTMLElement | null>(null);
  const rows = useMemo(() => (tree ? treeRows(tree, expanded) : []), [tree, expanded]);
  const focusable = rows.filter((r) => FOCUSABLE.has(r.kind));
  const selected = currentKey(view, rows);
  const ownerKey = owner ? (owner.kind === "project" ? projectKey(owner.id) : groupKey(owner.id)) : null;
  const roving = focusable.find((r) => r.key === focusKey)?.key ?? focusable.find((r) => r.key === selected)?.key ?? focusable[0]?.key;

  // A row that goes away with focus on it (its project was removed) hands focus to the tree's
  // roving row, never leaving it on <body>.
  useEffect(() => {
    const last = lastFocused.current;
    if (!last || last.isConnected || document.activeElement !== document.body) return;
    lastFocused.current = null;
    if (roving) refs.current.get(roving)?.focus();
    else onLeave();
  }, [rows, roving, onLeave]);

  const toggle = (key: string, open: boolean) => {
    setExpanded((old) => {
      if (old.has(key) === open) return old;
      const next = new Set(old);
      if (open) next.add(key); else next.delete(key);
      saveExpanded(next);
      return next;
    });
  };

  const moveTo = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    refs.current.get(key)?.focus();
  };

  const open = (row: TreeRow, newTab: boolean) => {
    if (row.view) onOpen(row.view, newTab);
  };

  const onRowKey = (e: KeyboardEvent<HTMLElement>, row: TreeRow) => {
    if (e.altKey) return;
    const i = focusable.findIndex((r) => r.key === row.key);
    const expandable = row.kind === "group" || row.kind === "project";
    switch (e.key) {
      case "ArrowDown": moveTo(focusable[i + 1]?.key); break;
      case "ArrowUp": moveTo(focusable[i - 1]?.key); break;
      case "Home": moveTo(focusable[0]?.key); break;
      case "End": moveTo(focusable[focusable.length - 1]?.key); break;
      case "ArrowRight":
        if (!expandable) return;
        if (!row.expanded) toggle(row.key, true);
        else {
          const at = rows.findIndex((r) => r.key === row.key);
          const child = rows.slice(at + 1).find((r) => r.level === 1 && FOCUSABLE.has(r.kind) || r.level === 0);
          if (child && child.level === 1) moveTo(child.key);
        }
        break;
      case "ArrowLeft":
        if (expandable && row.expanded) toggle(row.key, false);
        else if (row.level === 1) moveTo(row.key.slice(0, row.key.indexOf("/")));
        break;
      case "Enter":
        if (e.shiftKey) return;
        open(row, ctrl(e));
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onRowClick = (e: MouseEvent<HTMLElement>, row: TreeRow) => {
    setFocusKey(row.key);
    open(row, ctrl(e));
  };

  const navItem = (target: MonitoringView, label: string, icon: keyof typeof ICONS, badge?: ReactNode, name?: string) => {
    const current = view.page === target.page || (target.page === "sources" && view.page === "source");
    return (
      <button type="button" className={s.navItem} aria-current={current ? "page" : undefined} aria-label={name}
        onClick={(e) => onOpen(target, ctrl(e))}>
        <svg className={s.navIcon} viewBox="0 0 16 16" aria-hidden="true">{ICONS[icon]}</svg>
        <span>{label}</span>
        {badge}
      </button>
    );
  };

  const section = (row: TreeRow) => {
    const groups = row.key === "section:groups";
    const empty = groups ? !tree?.groups.length : !tree?.projects.length;
    return (
      <div key={row.key} role="none" className={s.sectionWrap}>
        <div className={s.section} data-row-kind="section" data-row-label={row.label}>
          <span>{row.label}</span>
          <button type="button" className={s.plus} aria-label={groups ? "New group" : "New project"}
            title={groups ? "New group" : "New project"}
            onClick={(e) => {
              // Setup opens with the keyboard on its step's heading (the group form on its name field).
              if (!groups) focusHeadingOnArrival("setup");
              onOpen(groups ? { page: "newGroup" } : { page: "setup" }, ctrl(e));
            }}>+</button>
        </div>
        {tree && empty && <p className={s.emptyLine}>{groups ? "Combine projects into a group with +" : "No projects yet"}</p>}
      </div>
    );
  };

  const item = (row: TreeRow) => {
    if (row.kind === "section") return section(row);
    if (row.kind === "empty") {
      return <div key={row.key} role="none" className={`${s.row} ${s.child} ${s.muted}`} data-row-kind="empty" data-row-label={row.label}>{row.label}</div>;
    }
    if (row.kind === "subheading") {
      return <div key={row.key} role="none" className={`${s.row} ${s.child} ${s.subheading}`} data-row-kind="subheading" data-row-label={row.label}>{row.label}</div>;
    }
    const expandable = row.kind === "group" || row.kind === "project";
    const label = row.kind === "shortcut" ? `Go to project ${row.label}` : row.readyMade ? `${row.label}, ready-made` : row.label;
    const plusFor = owner && row.key === ownerKey ? owner : null;
    return (
      <div
        key={row.key}
        ref={(el) => { if (el) refs.current.set(row.key, el); else refs.current.delete(row.key); }}
        role="treeitem"
        aria-label={label}
        aria-level={row.level + 1}
        aria-expanded={expandable ? !!row.expanded : undefined}
        aria-selected={row.key === selected}
        aria-current={isOpenPage(row, view) ? "page" : undefined}
        tabIndex={row.key === roving ? 0 : -1}
        className={`${s.row} ${row.level === 1 ? s.child : ""} ${s[row.kind] ?? ""}`}
        data-row-kind={row.kind}
        data-row-label={row.label}
        onKeyDown={(e) => onRowKey(e, row)}
        onClick={(e) => onRowClick(e, row)}
        onFocus={() => setFocusKey(row.key)}
      >
        {expandable && (
          <span className={s.chevron} aria-hidden="true"
            onClick={(e) => { e.stopPropagation(); setFocusKey(row.key); toggle(row.key, !row.expanded); }}>
            <svg viewBox="0 0 10 10"><path d="M3.5 2 6.5 5 3.5 8" /></svg>
          </span>
        )}
        {row.kind === "group" && <i className={`${s.folder} ${row.expanded ? s.folderOpen : ""}`} aria-hidden="true" />}
        {row.color && <i className={s.dot} data-dot={row.color} style={{ background: DOT[row.color] }} aria-hidden="true" />}
        <span className={s.label} title={row.label}>{row.label}</span>
        {row.readyMade && (
          <svg className={s.readyIcon} viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5 7.4 4.6 10.5 6 7.4 7.4 6 10.5 4.6 7.4 1.5 6 4.6 4.6Z" /></svg>
        )}
        {row.kind === "shortcut" && <span className={s.arrow} aria-hidden="true">↗</span>}
        {plusFor && (
          // Pointer only (tabIndex -1): from the keyboard, N does the same from anywhere.
          <button type="button" tabIndex={-1} className={s.rowPlus} aria-label={`New dashboard in ${plusFor.name}`}
            title={`New dashboard in ${plusFor.name}`}
            onClick={(e) => { e.stopPropagation(); onNewDashboard(plusFor, e.currentTarget.closest<HTMLElement>('[role="treeitem"]') ?? e.currentTarget); }}>+</button>
        )}
      </div>
    );
  };

  return (
    <nav
      id={drawer?.id}
      className={drawer ? `${s.sidebar} ${s.drawer}` : s.sidebar}
      aria-label="Monitoring"
      hidden={drawer ? !drawer.open : undefined}
      onKeyDown={drawer ? (e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        drawer.onEscape();
      } : undefined}
      onBlur={drawer ? (e) => {
        const to = e.relatedTarget;
        if (drawer.open && to instanceof Element && !e.currentTarget.contains(to)) drawer.onFocusOut(to);
      } : undefined}
    >
      <div className={s.head}>
        <span className={s.title}>Monitoring</span>
        <span className={k.k} aria-hidden="true">Alt 2</span>
      </div>
      <FindBox index={index} onOpen={onOpen} onLeave={onLeave} inputRef={findInput} />
      <div className={s.nav}>
        {navItem({ page: "home" }, "Home", "home")}
        {navItem(exploreFrom(view, tree), "Explore", "explore")}
        {navItem({ page: "alerts" }, "Alerts", "alerts",
          firing > 0 && <span className={s.firingCount} aria-hidden="true">{firing}</span>,
          firing > 0 ? `Alerts, ${firing} firing` : undefined)}
        {navItem({ page: "sources" }, "Sources", "sources",
          tree && <span className={s.count}>{tree.source_count}</span>,
          tree ? `Sources (${tree.source_count})` : undefined)}
      </div>
      <div
        className={s.tree}
        role="tree"
        aria-label="Projects and groups"
        onFocus={(e) => { lastFocused.current = e.target; }}
        onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) lastFocused.current = null; }}
      >
        {tree ? rows.map(item) : treeFailed ? (
          <div role="none" className={s.failed}>
            <p className={s.emptyLine} role="alert">Couldn't load your projects and groups. Check that OmniKrux is running, then try again.</p>
            <button type="button" className={s.retry} onClick={onRetry}>Try again</button>
          </div>
        ) : <p className={s.emptyLine} role="status">Loading projects…</p>}
      </div>
      <NewDashboardBar owner={owner} loaded={tree !== undefined} hasProjects={(tree?.projects.length ?? 0) > 0}
        onNew={(from) => onNewDashboard(owner, from)}
        onImport={(newTab) => onOpen({ page: "import", ...(owner ? { target: { kind: owner.kind, id: owner.id } } : {}) }, newTab)} />
    </nav>
  );
}
