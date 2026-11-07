import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { OwnerRef, Provider, ResourceRow } from "../../api/types";
import { textColumn } from "../territories/model";
import { DescribeView } from "./DescribeView";
import { EventsTable } from "./EventsTable";
import { useDescribe, usePodYaml } from "./useDescribe";
import { YamlView } from "./YamlView";
import { knownProvider } from "../territories/ProviderBadge";
import k from "../chrome/key.module.css";
import pc from "../territories/provider.module.css";
import s from "./Inspector.module.css";

const TABS = ["Describe", "YAML", "Events"] as const;
type Tab = (typeof TABS)[number];

/** Plain words for a failure; the backend's own `detail` comes through verbatim. */
function failure(err: Error): string {
  // fetch rejects with a TypeError when the request never got an answer.
  if (err instanceof TypeError) return "Can't reach the console's server. Check that it's running, then retry.";
  return err.message;
}

function Loaded<T>({ q, children }: { q: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (q.data !== undefined && !q.isError) return <>{children(q.data)}</>;
  if (q.isError) {
    return (
      <div className={s.state} role="alert">
        <span className={s.err}>{failure(q.error)}</span>
        <button type="button" className={s.btn} onClick={() => void q.refetch()} disabled={q.isFetching}>
          Retry
        </button>
      </div>
    );
  }
  return <div className={s.state} role="status">Loading details…</div>;
}

export function Inspector({
  row,
  provider,
  onOpenLogs,
  onOpenShell,
  onNodeShell,
  onOwnerLogs,
  onClose,
}: {
  row: ResourceRow;
  provider: Provider;
  onOpenLogs?: (row: ResourceRow) => void;
  onOpenShell?: (row: ResourceRow) => void;
  /** A shell on the pod's node (the dock asks first, then starts a node-shell pod). */
  onNodeShell?: (row: ResourceRow, node: string) => void;
  /** Logs of every pod the owner selects. */
  onOwnerLogs?: (row: ResourceRow, owner: OwnerRef) => void;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("Describe");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const ns = row.namespace ?? "";
  const rv = textColumn(row, "resource_version") ?? "";
  const describe = useDescribe(row.cluster_id, ns, row.name, rv);
  const yaml = usePodYaml(row.cluster_id, ns, row.name, rv, tab === "YAML");

  // Left/right move between tabs, as a tablist should.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = TABS.indexOf(tab);
    const next = (at + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[next]);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className={`${s.insp} ${pc[knownProvider(provider)]}`} aria-label={`Details for ${row.name}`}>
      <div className={s.bar}>
        <div role="tablist" aria-label="Details" className={s.tabs} onKeyDown={onTabKey}>
          {TABS.map((t, i) => (
            <button
              key={t}
              ref={(el) => { tabRefs.current[i] = el; }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={tab === t}
              aria-controls={`${id}-panel`}
              tabIndex={tab === t ? 0 : -1}
              className={s.tab}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className={s.tools}>
          <button type="button" className={s.btn} disabled={!onOpenLogs} onClick={() => onOpenLogs?.(row)}>
            Logs<span className={`${k.k} ${s.k}`} aria-hidden="true">l</span>
          </button>
          <button type="button" className={s.btn} disabled={!onOpenShell} onClick={() => onOpenShell?.(row)}>
            Shell<span className={`${k.k} ${s.k}`} aria-hidden="true">s</span>
          </button>
          {onClose && (
            <button type="button" className={`${s.btn} ${s.quiet}`} onClick={onClose}>
              Close<span className={`${k.k} ${s.k}`} aria-hidden="true">Esc</span>
            </button>
          )}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${TABS.indexOf(tab)}`}
        className={s.panel}
      >
        {tab === "Describe" && <Loaded q={describe}>{(d) => (
              <DescribeView
                data={d}
                onNodeShell={onNodeShell && ((node) => onNodeShell(row, node))}
                onOwnerLogs={onOwnerLogs && ((owner) => onOwnerLogs(row, owner))}
              />
            )}</Loaded>}
        {tab === "YAML" && <Loaded q={yaml}>{(y) => <YamlView yaml={y} />}</Loaded>}
        {tab === "Events" && (
          <Loaded q={describe}>
            {(d) => (
              <div className={s.events}>
                <EventsTable events={d.events} error={d.events_error} />
              </div>
            )}
          </Loaded>
        )}
      </div>
    </section>
  );
}
