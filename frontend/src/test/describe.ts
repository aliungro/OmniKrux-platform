// Describe answers as the backend sends them (backend/omnikrux/resources/describe.py, describe_any.py), for tests.
import type { ContainerInfo, PodDescribe, ResourceDescribe } from "../api/types";

export const container = (over: Partial<ContainerInfo> = {}): ContainerInfo => ({
  name: "payments-api",
  image: "acmeprod.azurecr.io/payments-api:2.4.1",
  state: "Waiting: CrashLoopBackOff",
  state_class: "bad",
  ready: false,
  restarts: 14,
  last_state: "Terminated: OOMKilled (exit 137)",
  last_finished_at: "2026-11-07T14:04:14Z",
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "256Mi" },
  limit_hit: ["memory"],
  ports: ["8080/TCP"],
  probes: { liveness: "GET :8080/healthz every 10s" },
  env: [],
  mounts: [],
  ...over,
});

export const describeBody = (over: Partial<PodDescribe> = {}): PodDescribe => ({
  pod: {
    name: "payments-api-1",
    namespace: "payments",
    status: "CrashLoopBackOff",
    status_class: "bad",
    node: "aks-np1-03",
    node_link: { kind_key: "nodes", namespace: null, name: "aks-np1-03" },
    pod_ip: "10.244.3.17",
    host_ip: "10.0.0.4",
    qos: "Burstable",
    service_account: "payments-api",
    service_account_link: { kind_key: "serviceaccounts", namespace: "payments", name: "payments-api" },
    owner: {
      kind: "ReplicaSet",
      name: "payments-api-7f9c4",
      selector: "app=payments-api,pod-template-hash=7f9c4",
      link: { kind_key: "replicasets.apps", namespace: "payments", name: "payments-api-7f9c4" },
    },
    started_at: "2026-11-07T14:02:00Z",
    resource_version: "1",
  },
  containers: [container()],
  init_containers: [],
  ephemeral_containers: [],
  volumes: [],
  conditions: [
    { type: "PodScheduled", status: "True", reason: null, message: null },
    { type: "Ready", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [payments-api]" },
  ],
  labels: { app: "payments-api" },
  annotations: {},
  events: [],
  events_error: null,
  ...over,
});

export const resourceDescribe = (over: Partial<ResourceDescribe> = {}): ResourceDescribe => ({
  kind_key: "deployments.apps",
  kind: "Deployment",
  name: "web",
  namespace: "demo",
  uid: "d-1",
  resource_version: "100",
  created_at: "2026-11-07T10:00:00Z",
  fields: [],
  sections: [],
  conditions: [],
  labels: {},
  annotations: {},
  owner: null,
  events: [],
  events_error: null,
  secret_keys: null,
  ...over,
});

/** A Secret's describe: key names and sizes, never values. */
export const secretDescribe = (over: Partial<ResourceDescribe> = {}): ResourceDescribe =>
  resourceDescribe({
    kind_key: "secrets",
    kind: "Secret",
    name: "payments-db",
    namespace: "payments",
    uid: "s-1",
    resource_version: "7",
    fields: [{ label: "Type", value: "Opaque", link: null }],
    secret_keys: [
      { key: "password", size: 12 },
      { key: "username", size: 5 },
    ],
    ...over,
  });
