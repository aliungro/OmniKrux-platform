import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { isMac } from "../chrome/shortcuts";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import { identity, type DockLayout, type Session } from "./dockState";
import { KIND_LABEL, SessionMarker, sessionName, tagOf } from "./SessionMarker";
import { SessionMenu } from "./SessionMenu";
import s from "./SessionTabs.module.css";

export function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}

export function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

/** Reveal the full tab and its close button within the strip's horizontal scroll. */
export function revealSessionTab(tab: HTMLElement) {
  const wrapper = tab.parentElement;
  const strip = wrapper?.parentElement;
  if (!wrapper || !strip) return;
  const bounds = wrapper.getBoundingClientRect();
  const left = strip.getBoundingClientRect().left + strip.clientLeft;
  const right = left + strip.clientWidth;
  if (bounds.left < left) strip.scrollLeft += bounds.left - left;
  else if (bounds.right > right) strip.scrollLeft += bounds.right - right;
}

/**
 * Whether the strip's tabs don't fit in one row. Measured when the strip is resized, and when
 * `contents` (what the tabs show, and which is selected) changes, since that changes their widths
 * and not the strip's.
 */
export function useStripOverflow(ref: RefObject<HTMLElement | null>, contents: string): boolean {
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOver(el.scrollWidth > el.clientWidth + 1);
  }, [ref, contents]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOver(el.scrollWidth > el.clientWidth + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return over;
}

/** The focus went with something that was removed (the menu's search box). */
function focusLost(): boolean {
  const at = document.activeElement;
  return at === null || at === document.body || !at.isConnected;
}

/**
 * One row of tabs, one per session, sized to their pod names: the cluster's badge and colour, the
 * session's marker (follows row, pinned, Shell, Previous...) and the pod. The full
 * "cluster / namespace / pod (container)" is the tab's tooltip and accessible name. When the tabs
 * don't fit, an "{n} open" button lists every session with a search box.
 */
export function SessionTabs({
  base,
  sessions,
  focused,
  layout,
  onFocus,
  onClose,
  onToggleLayout,
}: {
  base: string;
  sessions: Session[];
  focused: string | null;
  layout: DockLayout;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onToggleLayout: () => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const strip = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  /** Where the focus goes once the menu has closed: the picked tab, or (with `pick` unset) the button. */
  const afterMenu = useRef<{ pick?: string } | null>(null);
  // The selection counts too: the selected tab doesn't shrink and shows its close button.
  const overflow = useStripOverflow(
    strip,
    [focused, ...sessions.map((x) => [x.id, x.pod, tagOf(x)].join(" "))].join("\n"),
  );
  // Ctrl+Del, or Cmd+Backspace on a Mac, closes the tab that has the focus.
  const mac = isMac();
  const closeTitle = mac ? "Close (⌘⌫)" : "Close (Ctrl+Del)";
  const closeKeys = mac ? "Meta+Backspace" : "Control+Delete";

  // Reveal the full session, including its close button, when it is opened or selected.
  useEffect(() => {
    const tab = focused ? refs.current.get(focused) : undefined;
    if (tab) revealSessionTab(tab);
  }, [focused]);

  const closeMenu = () => {
    afterMenu.current = {};
    setMenuOpen(false);
  };
  const pick = (id: string) => {
    afterMenu.current = { pick: id };
    setMenuOpen(false);
    if (sessions.some((x) => x.id === id)) onFocus(id);
  };

  // Once the menu has closed: focus the tab it picked; or, if the pick has closed meanwhile or the
  // menu took the focus with it, the button (the selected tab when the button is gone too).
  useLayoutEffect(() => {
    const after = afterMenu.current;
    if (!after || menuOpen) return;
    afterMenu.current = null;
    const picked = after.pick === undefined ? undefined : refs.current.get(after.pick);
    if (picked) {
      revealSessionTab(picked);
      picked.focus();
    } else if (after.pick !== undefined || focusLost()) {
      (more.current ?? (focused ? refs.current.get(focused) : undefined))?.focus();
    }
  });

  // Left/right move between tabs, Home/End jump to the ends, as a tablist should. With a modifier
  // they are someone else's (Alt+Left and Alt+Right are history).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = sessions.findIndex((x) => x.id === focused);
    if (at < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % sessions.length;
    else if (e.key === "ArrowLeft") next = (at + sessions.length - 1) % sessions.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = sessions.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = sessions[next].id;
    onFocus(id);
    refs.current.get(id)?.focus();
  };

  return (
    <div className={s.bar}>
      <div ref={strip} role="tablist" aria-label="Logs and shells" className={s.tabs} onKeyDown={onKey}>
        {sessions.map((x) => {
          const on = x.id === focused;
          const provider = knownProvider(x.cluster.provider);
          const where = identity(x);
          return (
            <div
              key={x.id}
              className={`${s.sess} ${pc[provider]}${on ? ` ${s.on}` : ""}`}
              data-provider={provider}
              data-follow={x.follow ? "" : undefined}
              data-dock-session={x.id}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => { if (e.button === 1) onClose(x.id); }}
            >
              <button
                ref={(el) => {
                  if (el) refs.current.set(x.id, el);
                  else refs.current.delete(x.id);
                }}
                type="button"
                role="tab"
                id={tabId(base, x.id)}
                aria-label={sessionName(x)}
                aria-selected={on}
                aria-controls={panelId(base, x.id)}
                tabIndex={on ? 0 : -1}
                title={`${KIND_LABEL[x.kind]}: ${where}`}
                className={s.tab}
                onClick={() => onFocus(x.id)}
              >
                <ProviderBadge provider={x.cluster.provider} />
                <SessionMarker session={x} />
                <span className={s.pod}>{x.pod}</span>
              </button>
              <button
                type="button"
                className={s.x}
                aria-label={`Close ${KIND_LABEL[x.kind].toLowerCase()} ${where}`}
                title={closeTitle}
                aria-keyshortcuts={closeKeys}
                onClick={() => onClose(x.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {(overflow || menuOpen) && (
        <button
          ref={more}
          type="button"
          className={s.more}
          aria-label={`All ${sessions.length} open logs and shells`}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          // While the menu is open, Esc here closes only the menu, as it does in the menu.
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !menuOpen) return;
            e.preventDefault();
            e.stopPropagation();
            closeMenu();
          }}
        >
          {`${sessions.length} open`}
          <svg aria-hidden="true" viewBox="0 0 10 10" focusable="false">
            <path d="M2 3.75 5 6.75l3-3" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={s.lay}
        aria-label="Side by side"
        aria-pressed={layout === "split"}
        aria-disabled={sessions.length < 2}
        title={sessions.length < 2 ? "Side by side (Ctrl+\\). Open a second log or shell to use it." : "Side by side (Ctrl+\\)"}
        onClick={() => { if (sessions.length >= 2) onToggleLayout(); }}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
          <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
          <path d="M8 2v12" />
        </svg>
      </button>
      {menuOpen && (
        <SessionMenu id={menuId} anchor={more} sessions={sessions} focused={focused} onPick={pick} onClose={closeMenu} />
      )}
    </div>
  );
}
