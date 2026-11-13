import { useRef, useState } from "react";
import { failure } from "../../api/http";
import type { Cluster } from "../../api/types";
import { useClusters } from "../../api/useClusters";
import { ProviderBadge } from "../territories/ProviderBadge";
import { ImportKubeconfig } from "./ImportKubeconfig";
import { RemoveClusterDialog } from "./RemoveClusterDialog";
import s from "./CloudSettings.module.css";
import settings from "./SettingsView.module.css";

function location(cluster: Cluster, confirmation = false): string {
  if (cluster.source === "cloud") return [cluster.cloud?.account_name ?? "Cloud account", cluster.region].filter(Boolean).join(" · ");
  const source = cluster.source === "upload" ? "uploaded kubeconfig" : "kubeconfig file";
  const detail = confirmation ? `Context ${cluster.context_name}` : cluster.original_server ?? cluster.server;
  return [source, detail].filter(Boolean).join(" · ");
}

export function ClustersSection() {
  const clusters = useClusters();
  const heading = useRef<HTMLHeadingElement>(null);
  const [removing, setRemoving] = useState<Cluster | null>(null);

  return <section className={settings.section} id="clusters" aria-labelledby="settings-clusters-heading">
    <h2 id="settings-clusters-heading" ref={heading} tabIndex={-1}>Clusters</h2>
    {clusters.isPending && <p className={s.muted}>Loading clusters…</p>}
    {clusters.isError && <p className={s.warning} role="alert">{failure(clusters.error)} <button type="button" onClick={() => void clusters.refetch()}>Retry clusters</button></p>}
    {clusters.data?.length === 0 && <p className={s.muted}>No clusters in Omnikrux yet.</p>}
    {!!clusters.data?.length && <ul className={s.items} aria-label="Clusters in Omnikrux">
      {clusters.data.map(cluster => <li key={cluster.id} className={s.item}>
        <div className={s.details}>
          <div className={s.identity}><ProviderBadge provider={cluster.provider} /><strong>{cluster.name}</strong></div>
          <p>{location(cluster)}</p>
          {cluster.kubernetes_version && <p>Kubernetes {cluster.kubernetes_version}</p>}
          {cluster.cloud_note && <p className={s.warning}>{cluster.cloud_note}</p>}
        </div>
        <button type="button" aria-label={`Remove ${cluster.name}`} onClick={() => setRemoving(cluster)}>Remove</button>
      </li>)}
    </ul>}
    <ImportKubeconfig />
    {removing && <RemoveClusterDialog cluster={removing} onClose={() => setRemoving(null)} focusAfterRemoval={heading}
      location={location(removing, true)} />}
  </section>;
}
