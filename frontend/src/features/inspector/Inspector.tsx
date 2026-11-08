import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { failure } from "../../api/http";
import type { Link, OwnerRef, Provider, ResourceDescribe, ResourceRow } from "../../api/types";
import { capsOf, shortcutsFor } from "../chrome/shortcuts";
import { useGoTo } from "../navigation/navigation";
import { textColumn } from "../territories/model";
import { DescribeView } from "./DescribeView";
import { EventsTable } from "./EventsTable";
import { MetricsView, NodeMetricsView } from "./MetricsView";
import { ResourceDescribeView } from "./ResourceDescribeView";
import { useDescribe, usePodYaml } from "./useDescribe";
import { useResourceDescribe, useResourceYaml } from "./useResourceDescribe";
import type { KeysAsk } from "./SecretValues";
import { useTools, type ToolIntent } from "./Tools";
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
  /** The kind's API verbs: which changes it allows (`update` to edit, `delete` to delete). */
  verbs?: readonly string[];
  /** A change tool's key pressed on the row; run once, then `onIntentDone`. */
  intent?: ToolIntent | null;
  onIntentDone?: () => void;
  onOpenLogs?: (row: ResourceRow) => void;
  onOpenShell?: (row: ResourceRow) => void;
  /** A shell on the pod's node (the dock asks first, then starts a node-shell pod). */
  onNodeShell?: (row: ResourceRow, node: string) => void;
  /** Logs of every pod the owner selects. */
  onOwnerLogs?: (row: ResourceRow, owner: OwnerRef) => void;
  /** Logs of every pod a workload (this row) selects, by its matchLabels; `focus: false` opens it quietly. */
  onWorkloadLogs?: WorkloadLogs;
  onClose?: () => void;
}

/**
 * The details' own part of a key pressed on the row: show the YAML tab, open a workload's pods'
 * logs, or go to a Secret's keys. Change tools are `useTools`' part.
 */
function useViewIntent(
  intent: ToolIntent | null | undefined,
  onIntentDone: (() => void) | undefined,
  on: { yaml: () => void; workloadLogs?: () => void; reveal?: () => void },
) {
  const onRef = useRef(on);
  onRef.current = on;
  useEffect(() => {
    if (!intent) return;
    if (intent.tool === "yaml") onRef.current.yaml();
    else if (intent.tool === "workloadLogs") onRef.current.workloadLogs?.();
    else if (intent.tool === "reveal") onRef.current.reveal?.();
    else return;
    onIntentDone?.();
  }, [intent, onIntentDone]);
}

/**
 * A workload's "Logs" (its `l` key): every pod it selects, by the matchLabels its describe carries.
 * Asked before the describe has loaded, it opens once it has; a workload that selects its pods with
 * expressions says so instead.
 */
function useWorkloadLogs(
  row: ResourceRow,
  kindKey: string,
  describe: UseQueryResult<ResourceDescribe>,
  onWorkloadLogs: WorkloadLogs | undefined,
) {
  const offered = onWorkloadLogs !== undefined && shortcutsFor(kindKey).some((x) => x.id === "workloadLogs");
  const [waiting, setWaiting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const why = `${row.kind} ${row.name} picks its pods with expressions, so their logs can't be opened together. Open one of its pods' logs instead.`;
  const loaded = describe.data !== undefined && !describe.isError ? describe.data : undefined;
  const selector = loaded?.pod_selector ?? null;

  /** Where focus was when the logs were asked for before the describe had answered. */
  const askedFrom = useRef<Element | null>(null);

  const openWith = (d: ResourceDescribe, focus: boolean) => {
    if (d.pod_selector) {
      setNote(null);
      onWorkloadLogs?.(row, d.pod_selector, { focus });
    } else {
      setNote(why);
    }
  };
  const open = () => {
    if (!offered) return;
    if (loaded) {
      openWith(loaded, true);
    } else {
      askedFrom.current = document.activeElement;
      setWaiting(true);
    }
  };

  // Asked before the describe answered: open once it has, taking focus only if you haven't moved
  // on meanwhile (Plan 2 R16); a describe that failed says so itself.
  useEffect(() => {
    if (!waiting) return;
    if (describe.isError) setWaiting(false);
    else if (loaded) {
      setWaiting(false);
      openWith(loaded, document.activeElement === askedFrom.current);
    }
  });

  const button: ReactNode = offered ? (
    <button
      type="button"
      className={s.btn}
      disabled={loaded !== undefined && selector === null}
      title={loaded !== undefined && selector === null ? why : `Logs of every pod matching ${selector ?? "its selector"}`}
      onClick={open}
    >
      Logs
      {capsOf("workloadLogs").map((c) => (
        <span key={c} className={`${k.k} ${s.k}`} aria-hidden="true">{c}</span>
      ))}
    </button>
  ) : null;
  const line: ReactNode = note ? <p className={s.toolError} role="alert">{note}</p> : null;
  return { button, line, open };
}

const NO_VERBS: readonly string[] = [];

export type WorkloadLogs = (row: ResourceRow, selector: string, opts?: { focus?: boolean }) => void;

/**
 * The details under a row, for every kind: Describe, YAML and Events, plus Metrics for pods and
 * nodes. Every object the details name is a link to it, on the row's cluster. The tools on the
 * right change the object (edit, scale, restart, …), each reviewed in a dialog first.
 */
export function Inspector({ kindKey = "pods", ...props }: Props) {
  const goTo = useGoTo();
  const clusterId = props.row.cluster_id;
  const onLink = useCallback((link: Link) => goTo({ ...link, clusterId }), [goTo, clusterId]);
  return kindKey === "pods" ? <PodInspector {...props} onLink={onLink} /> : <ResourceInspector {...props} kindKey={kindKey} onLink={onLink} />;
}

function PodInspector({ row, provider, verbs = NO_VERBS, intent, onIntentDone, onOpenLogs, onOpenShell, onNodeShell, onOwnerLogs, onClose, onLink }: Omit<Props, "kindKey"> & { onLink: (l: Link) => void }) {
  const [tab, setTab] = useState<Tab>("Describe");
  const ns = row.namespace ?? "";
  const rv = textColumn(row, "resource_version") ?? "";
  const describe = useDescribe(row.cluster_id, ns, row.name, rv);
  const yaml = usePodYaml(row.cluster_id, ns, row.name, rv, tab === "YAML");
  const change = useTools({ row, kindKey: "pods", verbs, onNodeShell, onEditing: () => setTab("YAML"), intent, onIntentDone });
  useViewIntent(intent, onIntentDone, { yaml: () => setTab("YAML") });
  const editor = change.editor(yaml.data);
  const tools = (
    <>
      <button type="button" className={s.btn} disabled={!onOpenLogs} onClick={() => onOpenLogs?.(row)}>
        Logs<span className={`${k.k} ${s.k}`} aria-hidden="true">{capsOf("logs")[0]}</span>
      </button>
      <button type="button" className={s.btn} disabled={!onOpenShell} onClick={() => onOpenShell?.(row)}>
        Shell<span className={`${k.k} ${s.k}`} aria-hidden="true">{capsOf("shell")[0]}</span>
      </button>
      {change.buttons}
    </>
  );
  return (
    <Frame row={row} provider={provider} tabs={WITH_METRICS} tab={tab} onTab={setTab} tools={tools} strip={change.strip} onKey={change.onKey} onClose={onClose}>
      {tab === "Describe" && <Loaded q={describe}>{(d) => (
        <DescribeView
          data={d}
          onLink={onLink}
          onNodeShell={onNodeShell && ((node) => onNodeShell(row, node))}
          onOwnerLogs={onOwnerLogs && ((owner) => onOwnerLogs(row, owner))}
        />
      )}</Loaded>}
      {tab === "YAML" && (editor ?? <Loaded q={yaml}>{(y) => <YamlView yaml={y} onEdit={change.canEdit ? change.edit : undefined} />}</Loaded>)}
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

function ResourceInspector({ row, provider, kindKey, verbs = NO_VERBS, intent, onIntentDone, onNodeShell, onWorkloadLogs, onClose, onLink }: Omit<Props, "kindKey"> & { kindKey: string; onLink: (l: Link) => void }) {
  const [tab, setTab] = useState<Tab>("Describe");
  // Every row carries its resource version (backend `base_row`): a change reloads the details.
  const version = textColumn(row, "resource_version") ?? "";
  const describe = useResourceDescribe(row.cluster_id, kindKey, row.namespace, row.name, version);
  const yaml = useResourceYaml(row.cluster_id, kindKey, row.namespace, row.name, version, tab === "YAML");
  const nodes = kindKey === "nodes";
  const change = useTools({ row, kindKey, verbs, onNodeShell, onEditing: () => setTab("YAML"), intent, onIntentDone });
  const logs = useWorkloadLogs(row, kindKey, describe, onWorkloadLogs);
  // Ruling R38: `x` on a Secret's row shows its keys and focuses the first; `x` there reveals it.
  const [keysAsk, setKeysAsk] = useState<KeysAsk | null>(null);
  const keysFocused = useCallback(() => setKeysAsk(null), []);
  useViewIntent(intent, onIntentDone, {
    yaml: () => setTab("YAML"),
    workloadLogs: logs.open,
    reveal: () => {
      setTab("Describe");
      setKeysAsk((prev) => ({ seq: (prev?.seq ?? 0) + 1, from: document.activeElement }));
    },
  });
  const editor = change.editor(yaml.data);
  return (
    <Frame
      row={row}
      provider={provider}
      tabs={nodes ? WITH_METRICS : BASE_TABS}
      tab={tab}
      onTab={setTab}
      tools={
        <>
          {logs.button}
          {change.buttons}
        </>
      }
      strip={
        <>
          {logs.line}
          {change.strip}
        </>
      }
      onKey={change.onKey}
      onClose={onClose}
    >
      {tab === "Describe" && (
        <Loaded q={describe}>
          {/* Keyed on the row's version: a revealed Secret value goes the moment the row changes,
              not when the new describe lands. */}
          {(d) => (
            <ResourceDescribeView
              key={version}
              data={d}
              clusterId={row.cluster_id}
              onLink={onLink}
              focusKeys={keysAsk}
              onKeysFocused={keysFocused}
            />
          )}
        </Loaded>
      )}
      {tab === "YAML" &&
        (editor ?? (
          <Loaded q={yaml}>
            {(y) => <YamlView yaml={y} label={`${row.kind} YAML`} onEdit={change.canEdit ? change.edit : undefined} />}
          </Loaded>
        ))}
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

/**
 * The inspector's frame: the provider stripe, the tabs, the tools on the right, a form the tools
 * open (`strip`), and the panel.
 */
function Frame({
  row,
  provider,
  tabs,
  tab,
  onTab,
  tools,
  strip,
  onKey,
  onClose,
  children,
}: {
  row: ResourceRow;
  provider: Provider;
  tabs: readonly Tab[];
  tab: Tab;
  onTab: (t: Tab) => void;
  tools?: ReactNode;
  strip?: ReactNode;
  onKey?: (e: KeyboardEvent<HTMLElement>) => void;
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
    <section className={`${s.insp} ${pc[knownProvider(provider)]}`} aria-label={`Details for ${row.name}`} onKeyDown={onKey}>
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
        <div className={s.tools} role="toolbar" aria-label="Tools">
          {tools}
          {onClose && (
            <button type="button" className={`${s.btn} ${s.quiet}`} onClick={onClose}>
              Close<span className={`${k.k} ${s.k}`} aria-hidden="true">{capsOf("close")[0]}</span>
            </button>
          )}
        </div>
      </div>
      {strip}
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
