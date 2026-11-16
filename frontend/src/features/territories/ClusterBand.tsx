import type { Cluster, ClusterState, KindInfo, NodePool } from "../../api/types";
import { CLOUD_PROVIDERS } from "../settings/cloudProviders";
import { clusterPoolSummary, countNoun, hasStatus, type Territory } from "./model";
import { PROVIDER_CODE, ProviderBadge, knownProvider } from "./ProviderBadge";
import s from "./ClusterBand.module.css";
import pc from "./provider.module.css";

function serverHost(server: string | null | undefined): string | null {
  if (!server) return null;
  try {
    return new URL(server).host || server;
  } catch {
    return server;
  }
}

/** The shared location on a cluster band, card or search result. */
export function bandLocation(cluster: Cluster): string {
  if (cluster.source === "cloud") {
    const cloud = Object.values(CLOUD_PROVIDERS).find((provider) => provider.kube === cluster.provider);
    return [cloud?.cloud, cluster.region].filter(Boolean).join(" · ");
  }
  const host = serverHost(cluster.server);
  const original = cluster.original_server ? serverHost(cluster.original_server) : null;
  return [cluster.region, original && host ? `via ${host}` : host].filter(Boolean).join(" · ");
}

function poolsTitle(cluster: Territory["cluster"], summary: string): string {
  if (cluster.node_pools === null) return "The cloud provider didn't list this cluster's node pools.";
  return cluster.node_pools?.map(poolDetails).join("\n") || summary;
}

function poolDetails(pool: NodePool): string {
  const machines = [pool.count, pool.machine_type].filter((part) => part !== null && part !== "").join(" × ");
  const details = [machines, pool.version && `(${pool.version})`].filter(Boolean).join(" ");
  return details ? `${pool.name}: ${details}` : pool.name;
}

function Summary({ t, kind }: { t: Territory; kind: KindInfo }) {
  if (t.state === "error") {
    const message = t.message ?? "This cluster reported an error without details";
    return <span className={s.error} title={message}>{message}</span>;
  }
  if (t.state === "syncing" && t.message) {
    // Retrying after a failure: keep the reason on screen until the retry succeeds or fails.
    return <span className={s.error} title={t.message}>{t.message}</span>;
  }
  if (t.state === "absent" && t.discoveryFailed) {
    // The cluster couldn't read the kind's API group: it may have the kind, so this is a failure.
    return <span className={s.error} data-testid="band-unlisted" title={t.discoveryFailed}>{t.discoveryFailed}</span>;
  }
  if (t.state === "absent") {
    // Not an error: this cluster just doesn't have the kind (a CRD that only some clusters install).
    const message = t.message ?? `This cluster doesn't serve ${kind.key}.`;
    return <span className={s.absent} data-testid="band-absent" title={message}>{message}</span>;
  }
  if (t.state !== "ready") return <span className={s.sum}>Connecting…</span>;
  if (t.total === 0) return <span className={s.sum} data-testid="band-summary">No {kind.plural_label}</span>;
  if (t.rows.length === 0) return <span className={s.sum} data-testid="band-summary">No {kind.plural_label} match</span>;
  // Health only for kinds that have a status worth judging; an event's type isn't one.
  const health = hasStatus(kind) && kind.key !== "events";
  return (
    <span className={s.sum} data-testid="band-summary">
      {countNoun(kind, t.total)}
      {health && (
        <>
          ,{" "}
          {t.failing > 0 ? <span className={s.failing}>{t.failing} failing</span> : "all healthy"}
        </>
      )}
    </span>
  );
}

export function ClusterBand({
  t,
  kind,
  onRetry,
  rowIndex,
  columnCount = kind.columns.length,
  metricsNote = null,
}: {
  t: Territory;
  kind: KindInfo;
  /** With the band's state: an absent kind is retried by asking the cluster for its kinds again. */
  onRetry: (clusterId: string, state: ClusterState) => void;
  rowIndex?: number;
  columnCount?: number;
  /** Why this cluster's CPU and memory columns have no numbers (metrics-server missing, not answering). */
  metricsNote?: string | null;
}) {
  const { cluster } = t;
  const provider = knownProvider(cluster.provider);
  const host = serverHost(cluster.server);
  // Spec §11: say so when the console reaches the cluster at another address than the kubeconfig's.
  const original = cluster.original_server ? serverHost(cluster.original_server) : null;
  const loc = bandLocation(cluster);
  const version = cluster.kubernetes_version && `v${cluster.kubernetes_version.replace(/^v/, "")}`;
  const pools = clusterPoolSummary(cluster);
  const note = cluster.cloud_note;
  return (
    <div role="row" aria-rowindex={rowIndex} className={`${s.band} ${pc[provider]}${t.rows.length === 0 ? ` ${s.alone}` : ""}`} tabIndex={-1}>
      <div role="rowheader" aria-colspan={columnCount} className={s.cell}>
        <ProviderBadge provider={provider} large />
        <b className={s.name} title={cluster.name}>{cluster.name}</b>
        {loc && <span className={s.loc} title={loc}>{loc}</span>}
        {original && (
          <span
            className={s.loc}
            data-testid="band-rewrite"
            title={`Your kubeconfig says ${original}, which inside the console's container is the container itself, so the console connects via ${host} instead.`}
          >
            (kubeconfig: {original})
          </span>
        )}
        {version && <span className={s.loc} title={version}>{version}</span>}
        {pools && <span className={s.loc} title={poolsTitle(cluster, pools)}>{pools}</span>}
        {cluster.environment === "production" && <span className={`${s.env} ${s.prod}`}>Production</span>}
        {cluster.environment === "development" && <span className={`${s.env} ${s.dev}`}>Development</span>}
        <Summary t={t} kind={kind} />
        {metricsNote && t.state === "ready" && (
          <span className={s.metricsNote} data-testid="band-metrics" title={metricsNote}>{metricsNote}</span>
        )}
        {(t.state === "error" || t.state === "absent" || (t.state === "syncing" && t.message)) && (
          <button type="button" className={s.retry} onClick={() => onRetry(cluster.id, t.state)}>
            Retry
          </button>
        )}
        {note && <span className={s.cloudNote} title={note}>{note}</span>}
      </div>
      <span className={s.code} aria-hidden="true">{PROVIDER_CODE[provider]}</span>
    </div>
  );
}
