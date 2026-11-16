import { useEffect, useRef, type KeyboardEvent } from "react";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import { identity, type DockLayout, type Session } from "./dockState";
import s from "./SessionTabs.module.css";

const KIND_LABEL = { logs: "Logs", shell: "Shell" } as const;

/** What sets a session apart from a plain one, shown as a small tag on its tab. */
function tagOf(x: Session): string | null {
  if (x.cleanupPod) return "Node";
  if (x.debug) return "Debug";
  if (x.selector) return "All pods";
  if (x.previous) return "Previous";
  return null;
}

export function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}

export function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

/** Reveal the full tab and its close button within the strip's vertical scroll area. */
export function revealSessionTab(tab: HTMLElement) {
  const wrapper = tab.parentElement;
  const strip = wrapper?.parentElement;
  if (!wrapper || !strip) return;
  const bounds = wrapper.getBoundingClientRect();
  const top = strip.getBoundingClientRect().top + strip.clientTop;
  const bottom = top + strip.clientHeight;
  if (bounds.top < top) strip.scrollTop += bounds.top - top;
  else if (bounds.bottom > bottom) strip.scrollTop += bounds.bottom - bottom;
}

/**
 * One tab per session: the cluster's badge and colour, the kind, and where it points
 * ("cluster / namespace / pod (container)"), so you can tell two clusters' shells apart at a glance.
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

  // Reveal the full session, including its close button, when it is opened or selected.
  useEffect(() => {
    const tab = focused ? refs.current.get(focused) : undefined;
    if (tab) revealSessionTab(tab);
  }, [focused]);

  // Left/right move between tabs, Home/End jump to the ends, as a tablist should.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
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
      <div role="tablist" aria-label="Logs and shells" className={s.tabs} onKeyDown={onKey}>
        {sessions.map((x) => {
          const on = x.id === focused;
          const provider = knownProvider(x.cluster.provider);
          const tag = tagOf(x);
          const where = identity(x);
          return (
            <div
              key={x.id}
              className={`${s.sess} ${pc[provider]}${on ? ` ${s.on}` : ""}`}
              data-provider={provider}
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
                aria-label={`${KIND_LABEL[x.kind]}${tag ? ` ${tag}` : ""}: ${where}`}
                aria-selected={on}
                aria-controls={panelId(base, x.id)}
                tabIndex={on ? 0 : -1}
                title={`${KIND_LABEL[x.kind]}: ${where}`}
                className={s.tab}
                onClick={() => onFocus(x.id)}
              >
                <ProviderBadge provider={x.cluster.provider} />
                <span className={s.kind}>{KIND_LABEL[x.kind]}</span>
                {tag && <span className={s.tag}>{tag}</span>}
                <span className={s.where}>
                  <span className={s.ctx}>{`${x.cluster.name} / ${x.namespace} / `}</span>
                  <span className={s.pod}>{x.pod}</span>
                  {x.container && !x.selector && <span className={s.ctr}>{` (${x.container})`}</span>}
                </span>
              </button>
              <button
                type="button"
                className={s.x}
                aria-label={`Close ${KIND_LABEL[x.kind].toLowerCase()} ${where}`}
                title={x.kind === "logs" ? "Close (Esc)" : "Close"}
                aria-keyshortcuts={x.kind === "logs" ? "Escape" : undefined}
                onClick={() => onClose(x.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
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
    </div>
  );
}
