import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Cluster, KindInfo } from "../../api/types";
import { ContextMenu, isBlankMenuSurface, isMenuKey, menuAnchor, type MenuAnchor, type MenuItem } from "../chrome/ContextMenu";
import { tabLabel } from "./tabLabel";
import type { AppId, KubeView, Tab } from "./workspace";
import s from "./WorkspaceTabs.module.css";

const colors: Record<string, string> = {
  aks: "#2F8BFF", eks: "#FF9A1F", gke: "#2FBF71", oke: "#E2543E", kind: "#7DD3FC", onprem: "#A3A0B8",
};

interface Props {
  app: AppId;
  tabs: Tab<KubeView>[];
  active: string;
  clusters: Cluster[];
  kinds?: KindInfo[];
  onActivate(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  onEditPinned?(): void;
  onSplit?(id: string): void;
  split?: readonly [string, string];
}

export function WorkspaceTabs({ app, tabs, active, clusters, kinds, onActivate, onClose, onNew, onEditPinned, onSplit, split }: Props) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focused, setFocused] = useState(Math.max(0, tabs.findIndex((t) => t.id === active)));
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; id?: string } | null>(null);
  useEffect(() => setFocused(Math.max(0, tabs.findIndex((t) => t.id === active))), [active, tabs]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (onEditPinned && isMenuKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ anchor: menuAnchor(e.currentTarget), id: tabs[i].id });
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i + tabs.length - 1) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    setFocused(next);
    refs.current[next]?.focus();
  };

  if (app !== "kubernetes") {
    const title = app === "audit" ? "Audit log" : "Settings";
    return <div className={s.strip} role="tablist" aria-label={`${title} tabs`} data-page-keys>
      <button role="tab" aria-selected="true" className={s.tab}>{title}</button>
    </div>;
  }

  const menuItems: MenuItem[] = [];
  const target = menu?.id;
  if (target && target !== active && !split?.includes(target) && onSplit) {
    menuItems.push({ id: "split", label: "Split side by side", onSelect: () => onSplit(target), restoreFocus: false });
  }
  if (onEditPinned) {
    menuItems.push({ id: "pins", label: "Edit pinned kinds…", onSelect: onEditPinned, restoreFocus: false });
  }

  return (
    <div className={s.strip} role="tablist" aria-label="Kubernetes tabs" data-page-keys
      onContextMenu={(e) => {
        if (!onEditPinned || !isBlankMenuSurface(e.target)) return;
        e.preventDefault();
        setMenu({ anchor: menuAnchor(refs.current[focused] ?? e.currentTarget, e) });
      }}>
      {tabs.map((tab, i) => {
        const view = tab.view;
        const label = tabLabel(view, { kinds, clusters });
        const scope = view.page === "kind"
          ? clusters.filter((cluster) => view.clusters === null || view.clusters.includes(cluster.id))
          : [];
        const scopeTitle = view.page === "kind" && view.clusters !== null
          ? view.clusters.map((id) => clusters.find((cluster) => cluster.id === id)?.name ?? id).join(", ")
          : "all clusters";
        return (
          <div className={s.wrap} key={tab.id} data-active={tab.id === active}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id); } }}
            onContextMenu={(e) => {
              if (!onEditPinned) return;
              e.preventDefault();
              e.stopPropagation();
              setMenu({ anchor: menuAnchor(refs.current[i] ?? e.currentTarget, e), id: tab.id });
            }}>
            <div className={s.stripe}>
              {view.page === "home" ? <span style={{ background: "#C9B8FF" }} />
                : scope.map((cluster) => <span key={cluster.id} style={{ background: colors[cluster.provider] }} />)}
            </div>
            <button
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="tab"
              aria-selected={tab.id === active}
              aria-haspopup={onEditPinned ? "menu" : undefined}
              tabIndex={focused === i ? 0 : -1}
              className={s.tab}
              title={view.page === "home" ? "Home" : `${label.split(" · ")[0]} on ${scopeTitle}`}
              onClick={() => onActivate(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {view.page === "home" && <span aria-hidden="true">⌂ </span>}
              {label}
              {view.page === "kind" && view.filters.status === "failing" && (
                <span className={s.failing}> ◆<span className={s.sr}> (failing only)</span></span>
              )}
            </button>
            <button type="button" className={s.close} aria-label={`Close tab ${label}`}
              title="Close tab (Alt W)" onClick={() => onClose(tab.id)}>×</button>
          </div>
        );
      })}
      <button type="button" className={s.add} aria-label="New tab" title="New tab (Alt T)" onClick={onNew}>+</button>
      {menu && menuItems.length > 0 && <ContextMenu anchor={menu.anchor} label="Workspace tabs"
        items={menuItems}
        onClose={() => setMenu(null)} />}
    </div>
  );
}
