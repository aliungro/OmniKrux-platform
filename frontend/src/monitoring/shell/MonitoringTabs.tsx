import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AppTabs } from "../../features/shell/workspace";
import s from "../../features/shell/WorkspaceTabs.module.css";
import m from "./MonitoringTabs.module.css";
import type { MonitoringView } from "./tabState";

interface Props {
  tabs: AppTabs<MonitoringView>;
  /** The tab's name; `tabId` lets a tab editing a dashboard show its draft title. */
  labelFor(view: MonitoringView, tabId: string): string;
  /** The tab's top stripe: the project's colour, lilac otherwise. */
  colorFor(view: MonitoringView): string;
  onActivate(id: string): void;
  /** Returns true when the close was held (the app asks first): the keyboard stays with its question. */
  onClose(id: string): boolean;
  onNew(): void;
}

/**
 * Monitoring's tab strip, drawn like the Kubernetes one. The tabs scroll sideways in their own
 * list, + stays in view after it, and the active tab is brought into view as it opens or is shown.
 */
export function MonitoringTabs({ tabs, labelFor, colorFor, onActivate, onClose, onNew }: Props) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const activeIndex = Math.max(0, tabs.tabs.findIndex((t) => t.id === tabs.active));
  const [focused, setFocused] = useState(activeIndex);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => setFocused(activeIndex), [activeIndex, tabs.tabs.length]);
  // Only when the tabs don't fit their list; never smooth (the strip jumps to the tab, with or
  // without reduced motion).
  useEffect(() => {
    const tab = refs.current.get(tabs.active)?.parentElement;
    const list = tab?.parentElement;
    if (list && list.scrollWidth > list.clientWidth) tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tabs.active]);
  // A closed tab's button is gone: the keyboard lands on the tab that is now active.
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    refs.current.get(tabs.active)?.focus();
  }, [refocus, tabs.active]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const n = tabs.tabs.length;
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowLeft") next = (i + n - 1) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    setFocused(next);
    refs.current.get(tabs.tabs[next].id)?.focus();
  };

  const close = (id: string) => {
    if (!onClose(id)) setRefocus(true);
  };

  return (
    <div className={s.strip}>
      <div className={m.list} role="tablist" aria-label="Monitoring tabs">
      {tabs.tabs.map((tab, i) => {
        const label = labelFor(tab.view, tab.id);
        const active = tab.id === tabs.active;
        return (
          <div className={`${s.wrap} ${m.wrap}`} key={tab.id} data-active={active}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(tab.id); } }}>
            <div className={s.stripe}><span style={{ background: colorFor(tab.view) }} /></div>
            <button
              ref={(el) => { if (el) refs.current.set(tab.id, el); else refs.current.delete(tab.id); }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={focused === i ? 0 : -1}
              className={`${s.tab} ${m.tab}`}
              title={label}
              onClick={() => onActivate(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {tab.view.page === "home" && <span className={m.home} aria-hidden="true">⌂</span>}
              <span className={m.label}>{label}</span>
            </button>
            <button type="button" className={`${s.close} ${m.fixed}`} aria-label={`Close ${label}`} title="Close tab (Alt W)" onClick={() => close(tab.id)}>×</button>
          </div>
        );
      })}
      </div>
      <button type="button" className={`${s.add} ${m.fixed}`} aria-label="New tab" title="New tab (Alt T)" onClick={onNew}>+</button>
    </div>
  );
}
