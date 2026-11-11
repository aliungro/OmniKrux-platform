import { useEffect, useRef, type KeyboardEvent } from "react";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import { capsOf } from "../chrome/shortcuts";
import k from "../chrome/key.module.css";
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
    if (focused) refs.current.get(focused)?.parentElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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
                title="Close"
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
        aria-pressed={layout === "split"}
        aria-disabled={sessions.length < 2}
        title={sessions.length < 2 ? "Open a second log or shell to see two side by side." : undefined}
        onClick={() => { if (sessions.length >= 2) onToggleLayout(); }}
      >
        Side by side<span className={k.k} aria-hidden="true">{capsOf("layout")[0]}</span>
      </button>
    </div>
  );
}
