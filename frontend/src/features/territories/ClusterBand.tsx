import type { ClusterState, KindInfo } from "../../api/types";
import { countNoun, hasStatus, type Territory } from "./model";
import { PROVIDER_CODE, ProviderBadge, knownProvider } from "./ProviderBadge";
import s from "./ClusterBand.module.css";
import pc from "./provider.module.css";

function serverHost(server: string | undefined): string | null {
  if (!server) return null;
  try {
    return new URL(server).host || server;
  } catch {
    return server;
  }
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
  metricsNote = null,
}: {
  t: Territory;
  kind: KindInfo;
  /** With the band's state: an absent kind is retried by asking the cluster for its kinds again. */
  onRetry: (clusterId: string, state: ClusterState) => void;
  rowIndex?: number;
  /** Why this cluster's CPU and memory columns have no numbers (metrics-server missing, not answering). */
  metricsNote?: string | null;
}) {
  const { cluster } = t;
  const provider = knownProvider(cluster.provider);
  const host = serverHost(cluster.server);
  // Spec §11: say so when the console reaches the cluster at another address than the kubeconfig's.
  const original = cluster.original_server ? serverHost(cluster.original_server) : null;
  const loc = [cluster.region, original && host ? `via ${host}` : host].filter(Boolean).join(" · ");
  return (
    <div role="row" aria-rowindex={rowIndex} className={`${s.band} ${pc[provider]}${t.rows.length === 0 ? ` ${s.alone}` : ""}`} tabIndex={-1}>
      <div role="rowheader" aria-colspan={kind.columns.length} className={s.cell}>
        <ProviderBadge provider={provider} large />
        <b className={s.name}>{cluster.name}</b>
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
      </div>
      <span className={s.code} aria-hidden="true">{PROVIDER_CODE[provider]}</span>
    </div>
  );
}
