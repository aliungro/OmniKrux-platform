import type { CloudKubeProvider, CloudProvider } from "../../api/types";

export const CLOUD_PROVIDERS = {
  azure: { cloud: "Azure", account: "Azure subscription", cli: "Azure CLI", kube: "aks" },
  aws: { cloud: "AWS", account: "AWS account", cli: "AWS CLI", kube: "eks" },
  gcp: { cloud: "Google Cloud", account: "Google Cloud project", cli: "gcloud", kube: "gke" },
  oci: { cloud: "Oracle Cloud", account: "Oracle Cloud tenancy", cli: "OCI CLI", kube: "oke" },
} satisfies Record<CloudProvider, { cloud: string; account: string; cli: string; kube: CloudKubeProvider }>;
