import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { failure } from "../../api/http";
import type { Link, OwnerRef, Provider, ResourceRow } from "../../api/types";
import { useGoTo } from "../navigation/navigation";
import { textColumn } from "../territories/model";
import { DescribeView } from "./DescribeView";
import { EventsTable } from "./EventsTable";
import { MetricsView, NodeMetricsView } from "./MetricsView";
import { ResourceDescribeView } from "./ResourceDescribeView";
import { useDescribe, usePodYaml } from "./useDescribe";
import { useResourceDescribe, useResourceYaml } from "./useResourceDescribe";
import { YamlView } from "./YamlView";
import { knownProvider } from "../territories/ProviderBadge";
import k from "../chrome/key.module.css";
import pc from "../territories/provider.module.css";
import s from "./Inspector.module.css";

type Tab = "Describe" | "YAML" | "Events" | "Metrics";
const BASE_TABS: readonly Tab[] = ["Describe", "YAML", "Events"];
const WITH_METRICS: readonly Tab[] = [...BASE_TABS, "Metrics"];

function Loaded<T>({ q, children }: { q: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (q.data !== undefined && !q.isError) return <>{children(q.data)}</>;
  if (q.isError) {
    return (
      <div className={s.state} role="alert">
        <span className={s.err}>{failure(q.error, "retry")}</span>
        <button type="button" className={s.btn} onClick={() => void q.refetch()} disabled={q.isFetching}>
          Retry
        </button>
      </div>
    );
  }
  return <div className={s.state} role="status">Loading details…</div>;
}

interface Props {
  row: ResourceRow;
  provider: Provider;
  /** The row's kind key (`pods`, `deployments.apps`, …). */
  kindKey?: string;
  onOpenLogs?: (row: ResourceRow) => void;
  onOpenShell?: (row: ResourceRow) => void;
  /** A shell on the pod's node (the dock asks first, then starts a node-shell pod). */
  onNodeShell?: (row: ResourceRow, node: string) => void;
  /** Logs of every pod the owner selects. */
  onOwnerLogs?: (row: ResourceRow, owner: OwnerRef) => void;
  onClose?: () => void;
}

/**
 * The details under a row, for every kind: Describe, YAML and Events, plus Metrics for pods and
 * nodes. Every object the details name is a link to it, on the row's cluster.
 */
export function Inspector({ kindKey = "pods", ...props }: Props) {
  const goTo = useGoTo();
  const clusterId = props.row.cluster_id;
  const onLink = useCallback((link: Link) => goTo({ ...link, clusterId }), [goTo, clusterId]);
  return kindKey === "pods" ? <PodInspector {...props} onLink={onLink} /> : <ResourceInspector {...props} kindKey={kindKey} onLink={onLink} />;
}

function PodInspector({ row, provider, onOpenLogs, onOpenShell, onNodeShell, onOwnerLogs, onClose, onLink }: Omit<Props, "kindKey"> & { onLink: (l: Link) => void }) {
  const [tab, setTab] = useState<Tab>("Describe");
  const ns = row.namespace ?? "";
  const rv = textColumn(row, "resource_version") ?? "";
  const describe = useDescribe(row.cluster_id, ns, row.name, rv);
  const yaml = usePodYaml(row.cluster_id, ns, row.name, rv, tab === "YAML");
  const tools = (
    <>
      <button type="button" className={s.btn} disabled={!onOpenLogs} onClick={() => onOpenLogs?.(row)}>
        Logs<span className={`${k.k} ${s.k}`} aria-hidden="true">l</span>
      </button>
      <button type="button" className={s.btn} disabled={!onOpenShell} onClick={() => onOpenShell?.(row)}>
        Shell<span className={`${k.k} ${s.k}`} aria-hidden="true">s</span>
      </button>
    </>
  );
  return (
    <Frame row={row} provider={provider} tabs={WITH_METRICS} tab={tab} onTab={setTab} tools={tools} onClose={onClose}>
      {tab === "Describe" && <Loaded q={describe}>{(d) => (
        <DescribeView
          data={d}
          onLink={onLink}
          onNodeShell={onNodeShell && ((node) => onNodeShell(row, node))}
          onOwnerLogs={onOwnerLogs && ((owner) => onOwnerLogs(row, owner))}
        />
      )}</Loaded>}
      {tab === "YAML" && <Loaded q={yaml}>{(y) => <YamlView yaml={y} />}</Loaded>}
      {tab === "Metrics" && <MetricsView clusterId={row.cluster_id} ns={ns} name={row.name} />}
      {tab === "Events" && (
        <Loaded q={describe}>
          {(d) => (
            <div className={s.events}>
              <EventsTable events={d.events} error={d.events_error} />
            </div>
          )}
        </Loaded>
      )}
    </Frame>
  );
}

/**
 * What the watch knows changed about the row. Only pods carry their resource version; for other
 * kinds any change to the row's columns or labels reloads the describe.
 */
function rowVersion(row: ResourceRow): string {
  return textColumn(row, "resource_version") ?? JSON.stringify([row.columns, row.labels]);
}

function ResourceInspector({ row, provider, kindKey, onClose, onLink }: Omit<Props, "kindKey"> & { kindKey: string; onLink: (l: Link) => void }) {
  const [tab, setTab] = useState<Tab>("Describe");
  const version = useMemo(() => rowVersion(row), [row]);
  const describe = useResourceDescribe(row.cluster_id, kindKey, row.namespace, row.name, version);
  const yaml = useResourceYaml(row.cluster_id, kindKey, row.namespace, row.name, version, tab === "YAML");
  const nodes = kindKey === "nodes";
  return (
    <Frame row={row} provider={provider} tabs={nodes ? WITH_METRICS : BASE_TABS} tab={tab} onTab={setTab} onClose={onClose}>
      {tab === "Describe" && (
        <Loaded q={describe}>{(d) => <ResourceDescribeView data={d} clusterId={row.cluster_id} onLink={onLink} />}</Loaded>
      )}
      {tab === "YAML" && <Loaded q={yaml}>{(y) => <YamlView yaml={y} label={`${row.kind} YAML`} />}</Loaded>}
      {tab === "Metrics" && nodes && <NodeMetricsView clusterId={row.cluster_id} name={row.name} />}
      {tab === "Events" && (
        <Loaded q={describe}>
          {(d) => (
            <div className={s.events}>
              <EventsTable events={d.events} error={d.events_error} />
            </div>
          )}
        </Loaded>
      )}
    </Frame>
  );
}

/** The inspector's frame: the provider stripe, the tabs, the tools on the right, and the panel. */
function Frame({
  row,
  provider,
  tabs,
  tab,
  onTab,
  tools,
  onClose,
  children,
}: {
  row: ResourceRow;
  provider: Provider;
  tabs: readonly Tab[];
  tab: Tab;
  onTab: (t: Tab) => void;
  tools?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  // Left/right move between tabs, as a tablist should.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = tabs.indexOf(tab);
    const next = (at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    onTab(tabs[next]);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className={`${s.insp} ${pc[knownProvider(provider)]}`} aria-label={`Details for ${row.name}`}>
      <div className={s.bar}>
        <div role="tablist" aria-label="Details" className={s.tabs} onKeyDown={onTabKey}>
          {tabs.map((t, i) => (
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
              onClick={() => onTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className={s.tools}>
          {tools}
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
        aria-labelledby={`${id}-tab-${tabs.indexOf(tab)}`}
        className={s.panel}
      >
        {children}
      </div>
    </section>
  );
}
