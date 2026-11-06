import type { Provider } from "../../api/types";
import s from "./ProviderBadge.module.css";
import pc from "./provider.module.css";

export const PROVIDER_CODE: Record<Provider, string> = {
  aks: "AKS",
  eks: "EKS",
  gke: "GKE",
  oke: "OKE",
  kind: "KIND",
  onprem: "K8S",
};

const PROVIDER_NAME: Record<Provider, string> = {
  aks: "Azure Kubernetes Service",
  eks: "Amazon Elastic Kubernetes Service",
  gke: "Google Kubernetes Engine",
  oke: "Oracle Kubernetes Engine",
  kind: "kind (local Kubernetes)",
  onprem: "Kubernetes (on-premises or other)",
};

/** Falls back to the generic K8S identity for anything the backend did not classify. */
export function knownProvider(p: string): Provider {
  return p in PROVIDER_CODE ? (p as Provider) : "onprem";
}

export function ProviderBadge({ provider, large = false }: { provider: Provider; large?: boolean }) {
  const p = knownProvider(provider);
  return (
    <span className={`${s.pv} ${pc[p]}${large ? ` ${s.large}` : ""}`} title={PROVIDER_NAME[p]}>
      {PROVIDER_CODE[p]}
    </span>
  );
}
