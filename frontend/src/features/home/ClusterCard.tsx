import { bandLocation } from "../territories/ClusterBand";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import { statusClass, type Territory } from "../territories/model";
import pc from "../territories/provider.module.css";
import s from "./ClusterCard.module.css";

export function ClusterCard({ territory: t, onOpen }: { territory: Territory; onOpen: () => void }) {
  const { cluster } = t;
  const warnings = t.state === "ready" ? t.rows.filter(row => statusClass(row) === "warn").length : 0;
  const failed = t.state === "error" || (t.state === "ready" && t.failing > 0);
  const health = t.state === "error" ? `Can't reach it: ${t.message ?? "This cluster reported an error without details"}`
    : t.state !== "ready" ? "Connecting…"
    : t.failing > 0 ? `${t.failing} of ${t.total} pods failing`
    : warnings > 0 ? `${t.total} pods, ${warnings} need attention`
    : `${t.total} pods, all healthy`;
  return <button type="button" className={`${s.card} ${pc[knownProvider(cluster.provider)]}`} onClick={onOpen}>
    <ProviderBadge provider={knownProvider(cluster.provider)} />
    <b className={s.name}>{cluster.name}</b>
    <span className={s.location}>{bandLocation(cluster)}</span>
    {cluster.environment !== "unknown" && <span className={`${s.environment} ${cluster.environment === "production" ? s.production : s.development}`}>{cluster.environment === "production" ? "Production" : "Development"}</span>}
    <span className={`${s.health}${failed ? ` ${s.failed}` : warnings > 0 ? ` ${s.warning}` : ""}`}>
      {failed && <span aria-hidden="true">◆ </span>}{health}
    </span>
  </button>;
}
