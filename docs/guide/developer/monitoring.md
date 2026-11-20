# Monitoring: developer guide

Monitoring reads metrics and logs from tools you already run (a Prometheus-compatible service, Loki) and shows them per project. This release is the foundation: sources, projects, groups, label filters, discovery in known clusters and the query proxy. Dashboards, Explore and Alerts are not here yet. For what the app does for its users, see the [user guide](../user/monitoring.md).

## Code layout

Backend, under `backend/omnikrux/monitoring/`:

| Path | What it holds |
| --- | --- |
| `router.py` | `/api/monitoring`: the one router, behind a same-origin check. Each feature router's routes are adopted into it. |
| `services.py` | `build_services`: the stores, transports, connectors, health cache and discovery, built once in the app's lifespan as `app.state.monitoring`. |
| `models.py` | The SQLAlchemy tables (below). |
| `sources/` | Sources: `types.py` (the config shapes), `store.py` (storage, with secrets encrypted by the app's secret box), `rules.py` (input checks shared by the routes), `api.py` (`/sources`, `/discovery/{cluster}`, `/suggest-filter`), `transport.py` (how a source is reached), `connector.py` (the connector shape), `prometheus.py` and `loki.py` (the connectors), `discovery.py`, `health.py`. |
| `projects/` | Projects, links and groups: `store.py`, `types.py`, `api.py` (`/projects`, `/groups`, `/tree`, `/setup`). |
| `query/` | `api.py` (`POST /query`), `filters.py` (label filters and their injection), `series.py` (the one result format), `suggest.py` (filter suggestions for Kubernetes projects). |
| `audit.py` | Writes Monitoring's entries to the shared audit log. |

Frontend, under `frontend/src/monitoring/`: `MonitoringApp.tsx` (the app and its pages), `shell/` (tab state), `sidebar/`, `home/`, `sources/`, `setup/`, `projects/`, `groups/`, `search/`, `api/` (client, hooks, types, query helper) and `test/` (a fake API for tests).

### Tables and migrations

Migration `0006` adds an `app` column to the audit log, so each entry records which app made it. Migration `0007` creates the Monitoring tables:

- `monitoring_sources`: one row per source. Secrets are stored encrypted; the API never returns them, only whether one is set.
- `monitoring_projects`: one row per project (kind, optional cluster).
- `monitoring_project_sources`: the links, each with its label filter, the filter's origin (`user`, `auto` or `none`) and whether the project created the source.
- `monitoring_groups` and `monitoring_group_members`.

A change to these tables is a new migration under `backend/omnikrux/migrations/versions/`, never an edit of an old one.

## Connectors

A connector knows one tool's API and nothing about reaching it. `sources/connector.py` defines the `Connector` protocol:

- `type`, `label` and `language` (`promql` or `logql`);
- `test` (never raises for an unreachable tool; it reports it), `query`, `describe_fields`, `label_values` and `alerting`.

Every call besides `test` raises `SourceUnreachable` when the tool can't be reached and `QueryRejected` when the tool refuses a request. Both carry plain-words messages. The `SourceTransport` a connector is handed does the reaching: the address, authentication, headers, CA and the path through a cluster's API when a source is reached inside a cluster.

To add a connector:

1. Implement `Connector` in `backend/omnikrux/monitoring/sources/<name>.py`, and add its type to `SourceType` in `sources/types.py`.
2. Register it in `default_connectors()` in `sources/connector.py`.
3. Add its fake to `backend/tests/monitoring/fakes.py` (see `FakePrometheus` and `FakeLoki`), and its tests next to `test_prometheus.py` and `test_loki.py`.
4. Add its frontend label: the type in `frontend/src/monitoring/api/types.ts` and its name in `sources/sourceLabels.ts`, then the places that list types (`sources/SourceForm.tsx`, `setup/`).
5. If the new tool has a query language, teach `query/filters.py` to inject a filter into it. Until it can, queries from a project must be refused, not sent as written.

## The query proxy and filter injection

Every Monitoring query goes through `POST /api/monitoring/query`; the browser never talks to a tool. The body names a `source_id`, optionally a `project_id`, and the query (instant or range, times in seconds).

- With a `project_id`, the source must be linked to that project (otherwise `404 not_linked`). The link's label filter is added to every selector of the query: `inject_promql` for PromQL, `inject_logql` for LogQL. A query the scanner can't read, or a selector it can't filter, is refused with `bad_query`. The raw query is never sent unfiltered as a fallback. Where the scanner is unsure whether a word is a metric name, it filters it, so a wrong guess makes the tool refuse the query and never answers it with another project's data.
- Without a `project_id` the query runs as written. Only the Sources page does this, and no project's data is involved.
- Every error answers `detail = {"code", "message"}` with a code from `QueryErrorCode` (`not_found`, `not_linked`, `bad_request`, `bad_query`, `unreachable`, `timeout`, `unauthorized`, `too_large`, `tool_error`) and plain words, never a stack trace or a response body.
- The answer is one format for every tool (`query/series.py`): `series` with `points` for metrics, `streams` with `entries` for logs. It also returns the filter that was applied and the query that was sent.

Frontend code must send `project_id` on every query made from a project or group view. That is the isolation rule.

## Running the tests

Backend, from `backend`:

```bash
python -m uv run --frozen pytest -q -m "not kind and not cloud_live"
python -m uv run --frozen ruff check .
python -m uv run --frozen ruff format --check .
```

Monitoring's tests are in `backend/tests/monitoring/`. They run against local fake tools (`tests/monitoring/fakes.py`: a Prometheus, a Loki and a Grafana, with every authentication type) and the fake cluster in `tests/fakekube.py`, so they need no cluster and no network.

Frontend, from `frontend`:

```bash
npm test
npm run build
```

### The startup budget

The Monitoring app is a lazy chunk: the shell loads it only when you open Monitoring. `npm run build` ends with `check:startup`, which fails when the initial JavaScript is over 512,180 bytes or when anything under `frontend/src/monitoring/` ends up in it. The one exception is `shell/tabState.ts`, which the shell needs to restore tabs. So code under `frontend/src/monitoring/` must not be imported by shell code outside `MonitoringApp.tsx`'s lazy import, except for types, and nothing the shell imports may import the app's pages.

### The kind tests

`backend/tests/e2e/test_monitoring_kind.py` checks discovery, setup, queries and filters against a real Prometheus and Loki in the `omnikrux-dev` kind cluster (see [Setup](setup.md) for the cluster). They run with the other kind tests:

```bash
cd backend
python -m uv run --frozen pytest -q -m kind tests/e2e/test_monitoring_kind.py
```

They need Prometheus and Loki in the namespace `monitoring`, with Services named `prometheus-server` and `loki`, and three log lines to read. Without the Services the tests skip and say so. They create their projects and sources through the API and delete them again, leaving the tools installed.

Install the tools any way you like, for example with Helm or Argo CD, as long as the Services have those names. This is what the checks were written against:

| Tool | Chart | Pinned version | Service |
| --- | --- | --- | --- |
| Prometheus | `prometheus-community/prometheus` | 29.48.0 | `prometheus-server` (port 80) |
| Loki | `grafana/loki` | 7.7.0 (Loki 3.6.11) | `loki` (port 3100) |

Prometheus values (a small server plus kube-state-metrics, no Alertmanager, Pushgateway, node-exporter or volume, six hours of retention):

```yaml
alertmanager: {enabled: false}
prometheus-pushgateway: {enabled: false}
prometheus-node-exporter: {enabled: false}
kube-state-metrics: {enabled: true}
server:
  persistentVolume: {enabled: false}
  retention: 6h
  resources:
    requests: {cpu: 50m, memory: 256Mi}
    limits: {memory: 512Mi}
```

Loki values (single binary, filesystem storage, no persistence):

```yaml
deploymentMode: SingleBinary
loki:
  auth_enabled: false
  commonConfig: {replication_factor: 1}
  storage: {type: filesystem}
  schemaConfig:
    configs:
      - from: "2024-04-01"
        store: tsdb
        object_store: filesystem
        schema: v13
        index: {prefix: index_, period: 24h}
singleBinary:
  replicas: 1
  persistence: {enabled: false}
  # Chart 7.7.0 with persistence off leaves /var/loki read-only; give Loki an empty scratch volume there.
  extraVolumes: [{name: data, emptyDir: {}}]
  extraVolumeMounts: [{name: data, mountPath: /var/loki}]
read: {replicas: 0}
write: {replicas: 0}
backend: {replicas: 0}
gateway: {enabled: false}
chunksCache: {enabled: false}
resultsCache: {enabled: false}
lokiCanary: {enabled: false}
test: {enabled: false}
minio: {enabled: false}
```

With Helm, for example:

```bash
helm upgrade --install prometheus prometheus-community/prometheus -n monitoring --create-namespace --version 29.48.0 -f prometheus-values.yaml --wait
helm upgrade --install loki grafana/loki -n monitoring --version 7.7.0 -f loki-values.yaml --wait
```

Then push three log lines labelled `{job="omnikrux-live-check"}`. Open a port-forward to Loki and post them to its push endpoint:

```bash
kubectl -n monitoring port-forward svc/loki 3100:3100 &
now=$(date +%s)000000000
curl -s -X POST http://127.0.0.1:3100/loki/api/v1/push -H 'Content-Type: application/json' -d "{\"streams\":[{\"stream\":{\"job\":\"omnikrux-live-check\"},\"values\":[[\"$now\",\"live check line 1\"],[\"$((now+1))\",\"live check line 2\"],[\"$((now+2))\",\"live check line 3\"]]}]}"
```

Loki keeps them for as long as the pod runs; push them again after it restarts. With no persistent volume they are lost when the pod is replaced.
