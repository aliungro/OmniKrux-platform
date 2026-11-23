// Catalogs for the finder and suggestion tests.
import type { OwnerCatalog, OwnerMetric, OwnerStreamLabel } from "../catalog/merge";

export const owned = (name: string, over: Partial<OwnerMetric> = {}): OwnerMetric => ({
  name, type: null, help: null, unit: null, labels: [], series: 1, family: null, sourceId: "prom", projectIds: [], ...over,
});
export const counter = (name: string, labels: string[], series = 1) => owned(name, { type: "counter", labels, series });
export const gauge = (name: string, labels: string[], series = 1) => owned(name, { type: "gauge", labels, series });
export const family = (name: string, type: "histogram" | "summary", labels: string[], series = 1): OwnerMetric[] =>
  [`${name}_bucket`, `${name}_sum`, `${name}_count`].map((n) =>
    owned(n, { type, family: name, labels: n.endsWith("_bucket") ? [...labels, "le"] : labels, series }));
export const streamOf = (name: string, values: string[]): OwnerStreamLabel =>
  ({ name, values, sourceId: "loki", projectIds: [] });

export const catalog = (
  metrics: (OwnerMetric | OwnerMetric[])[], streams: OwnerStreamLabel[] = [], kind: "project" | "group" = "project",
): OwnerCatalog => ({
  ownerKind: kind, metrics: metrics.flat(), streams,
  hasPrometheus: metrics.length > 0, hasLoki: streams.length > 0, builtAt: null, problems: [], notes: [],
});

export const CAT = catalog(
  [
    counter("http_requests_total", ["route", "status", "pod"], 40),
    family("http_request_duration_seconds", "histogram", ["route"]),
    gauge("container_memory_working_set_bytes", ["namespace", "pod", "container"]),
    counter("kube_pod_container_status_restarts_total", ["namespace", "pod"]),
  ],
  [streamOf("app", ["api", "web"]), streamOf("level", ["error", "info"])],
);

export const KIND = catalog(
  [
    counter("prometheus_http_requests_total", ["code", "handler"], 30),
    family("prometheus_http_request_duration_seconds", "histogram", ["handler"]),
    counter("kube_pod_container_status_restarts_total", ["namespace", "pod"]),
    counter("container_cpu_usage_seconds_total", ["namespace", "pod", "container"]),
    // node-exporter, as the cluster scrapes it.
    counter("node_cpu_seconds_total", ["cpu", "instance", "job", "mode"], 32),
    gauge("up", ["job", "instance"]),
  ],
  [streamOf("job", ["a", "b"]), streamOf("level", ["error", "info"])],
);

export const bigCatalog = (n: number): OwnerCatalog =>
  catalog(
    Array.from({ length: n }, (_, i) =>
      i % 3 === 0
        ? counter(`svc${i}_requests_total`, ["route", "status", "pod"], i)
        : gauge(`svc${i}_error_depth_${i % 7}`, ["route", "node"], i)),
    [streamOf("app", Array.from({ length: 50 }, (_, i) => `app${i}`))],
  );
