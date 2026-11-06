import type { Territory } from "./model";
import { COLUMN_COUNT } from "./PodRow";
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

function pods(n: number): string {
  return n === 1 ? "1 pod" : `${n} pods`;
}

function Summary({ t }: { t: Territory }) {
  if (t.state === "error") {
    const message = t.message ?? "This cluster reported an error without details";
    return <span className={s.error} title={message}>{message}</span>;
  }
  if (t.state === "syncing" && t.message) {
    // Retrying after a failure: keep the reason on screen until the retry succeeds or fails.
    return <span className={s.error} title={t.message}>{t.message}</span>;
  }
  if (t.state !== "ready") return <span className={s.sum}>Connecting…</span>;
  if (t.total === 0) return <span className={s.sum} data-testid="band-summary">No pods</span>;
  if (t.rows.length === 0) return <span className={s.sum} data-testid="band-summary">No pods match</span>;
  return (
    <span className={s.sum} data-testid="band-summary">
      {pods(t.total)},{" "}
      {t.failing > 0 ? <span className={s.failing}>{t.failing} failing</span> : "all healthy"}
    </span>
  );
}

export function ClusterBand({
  t,
  onRetry,
  rowIndex,
}: {
  t: Territory;
  onRetry: (clusterId: string) => void;
  rowIndex?: number;
}) {
  const { cluster } = t;
  const provider = knownProvider(cluster.provider);
  const loc = [cluster.region, serverHost(cluster.server)].filter(Boolean).join(" · ");
  return (
    <div role="row" aria-rowindex={rowIndex} className={`${s.band} ${pc[provider]}${t.rows.length === 0 ? ` ${s.alone}` : ""}`} tabIndex={-1}>
      <div role="rowheader" aria-colspan={COLUMN_COUNT} className={s.cell}>
        <ProviderBadge provider={provider} large />
        <b className={s.name}>{cluster.name}</b>
        {loc && <span className={s.loc} title={loc}>{loc}</span>}
        {cluster.environment === "production" && <span className={`${s.env} ${s.prod}`}>Production</span>}
        {cluster.environment === "development" && <span className={`${s.env} ${s.dev}`}>Development</span>}
        <Summary t={t} />
        {(t.state === "error" || (t.state === "syncing" && t.message)) && (
          <button type="button" className={s.retry} onClick={() => onRetry(cluster.id)}>
            Retry
          </button>
        )}
      </div>
      <span className={s.code} aria-hidden="true">{PROVIDER_CODE[provider]}</span>
    </div>
  );
}
