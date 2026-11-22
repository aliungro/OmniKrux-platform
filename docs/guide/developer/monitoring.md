# Monitoring: developer guide

Monitoring reads metrics and logs from tools you already run (a Prometheus-compatible service, Loki) and shows them per project. It has sources, projects, groups, label filters, discovery in known clusters, the query proxy and dashboards. Explore and Alerts are not here yet. For what the app does for its users, see the [user guide](../user/monitoring.md).

## Code layout

Backend, under `backend/omnikrux/monitoring/`:

| Path | What it holds |
| --- | --- |
| `router.py` | `/api/monitoring`: the one router, behind a same-origin check. Each feature router's routes are adopted into it. |
| `services.py` | `build_services`: the stores, transports, connectors, health cache and discovery, built once in the app's lifespan as `app.state.monitoring`. |
| `models.py` | The SQLAlchemy tables (below). |
| `sources/` | Sources: `types.py` (the config shapes), `store.py` (storage, with secrets encrypted by the app's secret box), `rules.py` (input checks shared by the routes), `api.py` (`/sources`, `/discovery/{cluster}`, `/suggest-filter`), `transport.py` (how a source is reached), `connector.py` (the connector shape), `prometheus.py` and `loki.py` (the connectors), `discovery.py`, `health.py`. |
| `projects/` | Projects, links and groups: `store.py`, `types.py`, `api.py` (`/projects`, `/groups`, `/tree`, `/setup`). |
| `query/` | `api.py` (`POST /query`, `POST /query/batch`, `GET /label-values`), `run.py` (the pipeline behind them), `filters.py` (label filters and their injection), `series.py` (the one result format), `suggest.py` (filter suggestions for Kubernetes projects). |
| `dashboards/` | `schema.py` (the dashboard document and its checks), `store.py` (dashboards and their versions), `api.py` (the routes), `ready_made.py` (the generated views). See [Dashboards](#dashboards). |
| `audit.py` | Writes Monitoring's entries to the shared audit log. |

Frontend, under `frontend/src/monitoring/`: `MonitoringApp.tsx` (the app and its pages), `shell/` (tab state), `sidebar/`, `home/`, `sources/`, `setup/`, `projects/`, `groups/`, `search/`, `api/` (client, hooks, types, query helper), `dashboards/` and `charts/` (see [Dashboards](#dashboards)) and `test/` (a fake API for tests).

### Tables and migrations

Migration `0006` adds an `app` column to the audit log, so each entry records which app made it. Migration `0007` creates the Monitoring tables, and `0008` the dashboard tables (see [Dashboards](#dashboards)). `0007` holds:

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
5. If the new tool has a query language, teach `query/filters.py` to inject a filter into it and map the language to that injector in `_INJECTORS` in `query/api.py`. Until then, a query from a project in that language is refused with `bad_request`, never sent as written.

## The query proxy and filter injection

Every Monitoring query goes through `POST /api/monitoring/query`; the browser never talks to a tool. The body names a `source_id`, optionally a `project_id`, and the query (instant or range, times in seconds).

- With a `project_id`, the source must be linked to that project (otherwise `404 not_linked`). The link's label filter is added to every selector of the query: `inject_promql` for PromQL, `inject_logql` for LogQL. A query the scanner can't read, or a selector it can't filter, is refused with `bad_query`. The raw query is never sent unfiltered as a fallback. Where the scanner is unsure whether a word is a metric name, it filters it, so a wrong guess makes the tool refuse the query and never answers it with another project's data.
- Without a `project_id` the query runs as written. Only the Sources page does this, and no project's data is involved.
- Every error answers `detail = {"code", "message"}` with a code from `QueryErrorCode` (`not_found`, `not_linked`, `bad_request`, `bad_query`, `unreachable`, `timeout`, `unauthorized`, `too_large`, `tool_error`) and plain words, never a stack trace or a response body.
- The answer is one format for every tool (`query/series.py`): `series` with `points` for metrics, `streams` with `entries` for logs. It also returns the filter that was applied and the query that was sent.

Frontend code must send `project_id` on every query made from a project or group view. That is the isolation rule.

## Dashboards

A dashboard belongs to one project or one group and is stored as one JSON document, plus every version it has had. The browser runs the panels' queries through the query proxy; the server never runs a panel by itself.

### The dashboard document, schemaVersion 1

This is the format OmniKrux stores and shows on the JSON tab. It is checked in two places that follow each other field for field: `backend/omnikrux/monitoring/dashboards/schema.py` (`validate_dashboard`, the authority, run on every create, save, copy and restore) and `frontend/src/monitoring/dashboards/schema.ts` (`validateDashboard`, used by the JSON tab and drafts). Both are hand-written walkers over plain JSON values, so the problem text and its order are exact.

A document is normalised as well as checked: omitted fields get the defaults below, text is trimmed where noted, and thresholds are sorted by value. What is stored and returned is the normalised document. Unknown fields are refused (`Unknown field "x".`), reported after the object's known fields, in code-point order. A problem is a `path` (`panels[2].layout.x`; empty for the document) and a `message`. At most 50 problems are reported, and a document over 1 MB is refused whole with "The dashboard is larger than 1 MB."

Document:

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `schemaVersion` | number | required | Must be `1`: "This OmniKrux reads dashboards with schemaVersion 1." |
| `title` | text | required | 1 to 120 characters, no line breaks, trimmed: "Use 1 to 120 characters, without line breaks." Unique among the owner's dashboards. |
| `description` | text | `""` | At most 2000 characters. |
| `time` | `{from, to}` | `{"from": "now-6h", "to": "now"}` | Each is `now`, `now-<number><s\|m\|h\|d\|w>` or a UTC time like `2026-11-19T10:00:00Z`; the start has to be before the end. |
| `refresh` | text or null | `null` | `null`, `10s`, `30s`, `1m`, `5m`, `15m` or `1h`. |
| `variables` | list | `[]` | At most 20. |
| `panels` | list | `[]` | At most 100. |

Variable (only `type` `labelValues` exists):

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `name` | text | required | Letters, digits and `_`, starting with a letter or `_`, at most 40 characters, not starting with `__` (those are the built-ins `__interval`, `__rate_interval` and `__range`). Unique in the document. |
| `label` | text | the name | 1 to 120 characters, no line breaks. |
| `type` | text | required | `labelValues`. |
| `source` | source | required | See below. |
| `labelName` | text | required | A label name: letters, digits and `_`, not starting with a digit. |
| `match` | text | `""` | A selector that narrows the values; at most 1000 characters. It may use variables defined before this one ("Uses $x, which comes after this variable. Move x before it."). |
| `multi` | boolean | `false` | May several values be chosen. |
| `includeAll` | boolean | `false` | Offer **All**. |
| `default` | list of text, or `"all"` | `[]` | At most 100 values; more than one needs `multi`; `"all"` needs `includeAll`. |

Source, used by variables and queries: `{"type": "prometheus" | "loki", "id": text | null}`. `id` null means the project's first source of that type, which is what makes a document portable between projects. In a group dashboard `id` must be null ("In a group dashboard each project uses its own source, so "id" must be null."); each member project uses its own.

Panel:

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `id` | text | required | 1 to 40 lower-case letters, digits or dashes, starting with a letter or digit; unique in the document. |
| `type` | text | required | `timeseries`, `stat`, `gauge`, `bar`, `table` or `logs`. |
| `title` | text | required | At most 120 characters, no line breaks (may be empty). |
| `description` | text | `""` | At most 2000 characters. |
| `layout` | `{x, y, w, h}` | required | Whole numbers in grid cells: `x` 0 to 22, `y` 0 to 999, `w` 2 to 24, `h` 2 to 40; `x + w` at most 24 (the grid is 24 columns); panels may not overlap ("Panel "a" overlaps panel "b". Move one of them."). |
| `queries` | list | required | 1 to 10; a logs panel has exactly one, and it is a Loki query. |
| `options` | object | the type's defaults | See below. |
| `alert` | null | `null` | Anything else is refused: "Panel alerts arrive in a later update; leave "alert" as null." |

Query: `ref` (a capital letter A to Z, different in each query; required), `source` (required), `expr` (1 to 10000 characters; required; its `$name` and `${name}` must be variables of the document or built-ins), `legend` (`""`, at most 200 characters; `{{label}}` is replaced by the series' label), `hidden` (`false`).

Options by type (a `thresholds` entry is `{value: number, color: "ok" | "warn" | "bad"}`, at most 10; `unit` is one of `none`, `short`, `percent`, `percentunit`, `s`, `ms`, `bytes`, `Bps`, `reqps`, `cores`; `decimals` is null or 0 to 6):

| Type | Options and defaults | Default size (w by h) |
| --- | --- | --- |
| `timeseries` | `unit` none, `decimals` null, `thresholds` [], `min` null, `max` null, `legend` `bottom` (or `hidden`), `style` `lines` (`area`, `stacked`) | 12 by 8 |
| `stat` | `unit`, `decimals`, `thresholds`, `calc` `last` (`mean`, `max`, `min`, `sum`), `sparkline` true | 6 by 4 |
| `gauge` | `unit`, `decimals`, `thresholds`, `min` 0, `max` null, `calc` `last` | 6 by 6 |
| `bar` | `unit`, `decimals`, `thresholds`, `min` null, `legend` `bottom`, `orientation` `horizontal` (or `vertical`) | 12 by 8 |
| `table` | `unit`, `decimals`, `thresholds`, `columns` [] (empty: every label), `sort` null or `{column, descending}` | 12 by 8 |
| `logs` | `limit` 100 (1 to 1000), `wrap` true, `order` `newest` (or `oldest`) | 24 by 10 |

The same rules are written as cases in `backend/tests/monitoring/dashboard_schema_cases.json`: each has a name, the owner kind, the `input`, the `normalized` document it must produce, and the exact `problems` (path and message, in order). `test_dashboard_schema.py` runs every case against the Python walker and `schema.test.ts` runs the same file against the TypeScript one, so the two can't drift. A change to a rule starts with a case.

**Compatibility.** Stored documents are read back by later versions, and later features (importing dashboards, alerts on a panel) read them too. Within `schemaVersion` 1 you may only add something an older document can omit, with a default, so every stored document stays valid and means what it did. A change that would make a stored document invalid or change its meaning (renaming or removing a field, changing a default, tightening a limit) needs `schemaVersion` 2: the walkers then accept both, the store keeps old versions as they were written, and a migration step brings version 1 documents forward on read. Never edit what version 1 means in place.

### Routes and tables

Routes are under `/api/monitoring`, in `dashboards/api.py` and adopted into the router like the others:

| Route | What it does |
| --- | --- |
| `GET /dashboards` | The saved dashboards (`owner_kind` and `owner_id` narrow it): id, owner, title, version, panel count, update time. |
| `POST /dashboards` | Creates one for an owner from a document. |
| `POST /dashboards/copy` | Copies a dashboard, or a ready-made view, for any owner, with a title (default "… (copy)", made unique) and the sources the owner can't use set to null. |
| `GET /dashboards/{id}` | One dashboard with its document. A ready-made id (`ready:<project id>:<key>`) is generated here and never stored. |
| `PUT /dashboards/{id}` | Saves a document as the next version, given `base_version`. |
| `DELETE /dashboards/{id}?version=n` | Deletes it and every version of it. |
| `GET /dashboards/{id}/versions`, `GET .../versions/{v}` | The version list (newest first) and one version's document. |
| `POST /dashboards/{id}/versions/{v}/restore` | Saves version `v`'s document as the next version, given `base_version`. |
| `GET /projects/{id}/ready-made` | The project's ready-made views, with what its Prometheus lacks. |
| `POST /query/batch`, `GET /label-values` | The query routes dashboards use (below). |

A save, restore or delete names the version it started from. If another save landed since, nothing changes and the answer is 409 `version_conflict` with `current_version`. Every refusal answers `detail = {"code", "message"}` (`invalid_dashboard` also carries `problems`; the codes are in `DashboardErrorCode`). Bodies are read by the route itself, so a body of the wrong shape is refused in the same words and never with FastAPI's list of errors. Ready-made views answer `read_only` to a save, restore or delete.

Every change is audited before it is made and finished after (`begin_change`, `finish_change`): no audit, no change. The details hold the owner, versions and panel counts, never the document. The actions are `dashboard_add`, `dashboard_save`, `dashboard_restore` and `dashboard_remove`.

Migration `0008` creates two tables:

- `monitoring_dashboards`: one row per dashboard: owner kind and id, title (unique per owner), the normalised document as JSON, the current version and the times.
- `monitoring_dashboard_versions`: one row per version, the current one included: document, title, panel count, origin (`created`, `copied`, `saved` or `restored`), `restored_from` and `copied_from`.

Deleting a project or a group deletes its dashboards and their versions in the same transaction. The delete review lists them (`dashboards` in the review), and a delete whose review went stale is refused, like M1's.

### How a panel run is built

`frontend/src/monitoring/dashboards/runPanel.ts` turns a panel into requests; the server runs them.

1. **Variables and built-ins.** `interpolate.ts` substitutes `$name` and `${name}` in each shown, non-empty query in one left-to-right pass over the original text, tracking the quote it is in. A value is escaped for that quote (double, single or backtick), and a multi-value variable or **All** becomes a regex (`.+` for all). A value that can't be placed safely, which is anything outside quotes that isn't a plain word, raises `VariableError` ("Put $x inside double quotes in the query."), and that query is skipped with the reason, never sent unsubstituted. Comments (`#`) are copied untouched. The built-ins are `$__interval` (the step), `$__rate_interval` (four steps, at least a minute) and `$__range` (the range), written as durations.
2. **Time and step.** `time.ts` resolves the range against "now" (the page owns "now"; each refresh is a new window, never the old one sent again). `stepFor` picks the smallest of a fixed list of steps that keeps about 60 points per grid column the panel is wide, and `alignRange` rounds the window to the step so repeated runs hit the same points. Bar and table panels run an instant query at the end of the range; every other type runs a range query; a logs panel also sends its `limit` and direction.
3. **Sources and fan-out.** A project dashboard sends each query to the source it names, or the project's first source of that type when `id` is null. A group dashboard sends each query once per selected member project, each to that project's own first source of the type, always with that project's `project_id`. A query whose project has no such source, or whose named source isn't linked, becomes a skipped part with its reason.
4. **The batch.** All requests of a panel go in one `POST /query/batch` (split at 64 by `runRequests`). The route runs at most 8 items at once, each through its own project's filter with M1's limits, and answers 200 with every item's result in order. One item's failure, including an unexpected one, fails only that item, and an item without a `project_id` is refused ("Pick the project this query belongs to.") because a batch never reads a source unfiltered. An item whose source isn't linked answers `not_linked`.
5. **Merging and state.** `mergePanelResults` builds the series, log lines and problems, and decides the state: no parts and no skips is `noQuery`; every part failed or skipped is `unreachable` when each failure is the tool not answering (`unreachable`, `timeout`, `unauthorized`, `too_large`, `tool_error` or a network failure) and `error` otherwise; some failed or skipped, or an answer was cut short, is `partial` (even if the rest is empty, so a failure is never read as no data); no series and no lines is `empty`; else `ready`. Series keys are stable (query, project and sorted labels) so colours follow them. A request that fails as a whole shows its reason with no series: never the previous data. While a new window loads, the last data for the same panel stays shown with a loading mark.

`useDashboardContext.ts` holds what a page needs once: the owner (a project, or a group with its projects), the time, refresh, variables (each read through `GET /label-values` with the project's filter, keeping the choice within what the variable allows), the clock and the status line. Auto-refresh moves "now" and is skipped while the page is hidden.

### The chart chunk

`frontend/src/monitoring/charts/` draws panels on canvas, one component per type behind `ChartView` (`index.ts` exports it as the default). It is loaded lazily from `grid/PanelBody.tsx` (`lazy(() => import("../../charts"))`), and the JSON editor's CodeMirror loads with the JSON tab, so the dashboard page itself stays small and the startup budget (above) holds. `charts/lazyCharts.test.ts` fails if any file outside `charts/` imports the chunk statically (type-only imports are fine); keep it that way when you add code.

- **Decimation.** `decimate.ts` keeps, per pixel column, the first, lowest, highest and last point in time order, so a spike never disappears and a long series costs at most four points per column.
- **Morph and count.** When a panel's query is edited (the grid tracks an edit count per panel; a refresh keeps it), a time series morphs from the last drawn frame to the new data over 380 ms (`mixColumns`, `tween`), a stat counts up to its number, and the panel's frame flashes for 450 ms. Gaps in a series jump to their target.
- **Reduced motion.** `dashboards/motion.ts` follows the system setting live (`usePrefersReducedMotion`), and the grid passes `animate` only for tiles in edit mode with motion allowed. With reduced motion every change jumps: no morph, no count, no highlight. View mode never animates.
- **Colours** come from the design tokens through `getComputedStyle`; series colours follow the series key.

### Drafts and the leave check

`frontend/src/monitoring/dashboards/drafts/` and `editor/`:

- Edit sessions live in `editSessions` (`useDashboardEditor.ts`), one per workspace tab, and a dashboard has at most one session per window: a second tab asking to edit gets "This dashboard is being edited in another tab." The editor reducer (`editorState.ts`) holds the draft, the base version it started from, the JSON tab's text and problems, and a per-panel change count.
- `useDraft.ts` writes the draft to `localStorage` (`omnikrux.monitoring.draft.<dashboard id>`) 500 ms after each change, and at once when the page hides or goes away; Save and Discard remove it. Every access to storage is caught: blocked, full or tampered storage means no drafts, and an entry that can't be read is removed rather than offered.
- Each session writes under its own `writer` id and removes only what it wrote. When another window changes this dashboard's draft (a `storage` event), the session whose user changed it last writes, so the newest draft wins and nothing is dropped silently.
- With storage blocked the edit bar warns, and a `beforeunload` handler asks before a reload or close. Browser Back and reload are otherwise not held; the draft is offered back (`DraftBanner`) when the page opens without a live session.
- `leaveGuard.ts` (`heldLeave`) decides which tab actions leave unsaved changes behind: closing the tab, navigating it elsewhere, Back or Forward in its history. `MonitoringApp` asks it before every tab action, and `LeaveDialog` offers **Stay**, **Discard changes** and **Keep draft and leave** (the last only when drafts work).
- Save with no changes, or with no JSON text waiting, writes nothing and just ends the session. Every save (Save dashboard, Ctrl S, Review changes and Save over it) is refused while the JSON text doesn't apply, and edits outside the JSON tab are refused with `JSON_FIRST` until it is fixed or discarded, so typed text is never dropped. A save over a newer version is reviewed first (`SaveConflict`). Restoring a version is refused while a draft or an edit session exists for the dashboard.

### Ready-made views

`dashboards/ready_made.py` builds each view as a normalised, valid document from small helpers, on request; nothing is stored and no Prometheus call is made. Their sources are `{"type": …, "id": null}`. A project gets all five for Kubernetes with a Prometheus source, `nodes` alone for other kinds, and none without Prometheus.

| Key | Title | Variables | Panels | Reads |
| --- | --- | --- | --- | --- |
| `cluster` | Cluster health | none | 10: node and Pod counts, CPU and memory requested, Pods by phase, CPU and memory by namespace, restarts | kube-state-metrics, cAdvisor |
| `nodes` | Node health | `instance` | 7 (6 off Kubernetes): CPU, memory, load, root disk, network, and node conditions on Kubernetes | node-exporter |
| `namespaces` | Namespace health | `namespace` | 6 | kube-state-metrics, cAdvisor |
| `workloads` | Workload health | `namespace` | 6 | kube-state-metrics, cAdvisor |
| `pods` | Pod health | `namespace`, `pod` | 6, plus a logs panel when the project has Loki | kube-state-metrics, cAdvisor |

`NEEDS` says which exporters a view reads, `NEED_METRIC` is one metric that proves each reports (`kube_pod_info`, `container_cpu_usage_seconds_total`, `node_cpu_seconds_total`), and `NEED_NOTE` is the sentence the project page shows when it doesn't. `GET /projects/{id}/ready-made` reads the metric names once, from the project's first Prometheus source through that link's filter. If it can't read them all it says `checked: false` with the reason instead of guessing.

To add a view:

1. Add its key to `ReadyKey` and `READY_ORDER`, its title and description, its `NEEDS`, a builder function and its branch in `build_ready_made`.
2. Make `ready_keys` offer it for the right project kinds.
3. Add it to `tests/monitoring/test_ready_made.py` (every view must validate as a project dashboard) and, if it reads a new exporter, add the exporter to `Need`, `NEED_METRIC` and `NEED_NOTE`.
4. Add it to the table above and the list in the [user guide](../user/monitoring.md).

To add a panel type:

1. Backend: add it to `PANEL_TYPES`, `DEFAULT_SIZES` and `_OPTION_KEYS` in `schema.py` and write its options in `_options` with defaults.
2. Frontend: the same in `schema.ts` (`PANEL_TYPES`, `DEFAULT_SIZES`, `defaultOptions`, the options walker), plus `queryKindFor` in `runPanel.ts` (instant or range) and how `mergePanelResults` treats its answer.
3. Add cases for it, valid and invalid, to `dashboard_schema_cases.json`; both walkers must pass them.
4. Add its chart component under `charts/` and a branch in `ChartView.tsx`. Keep it inside the chunk.
5. Settings: a tile and glyph in `editor/ChartTab.tsx` (with its options there), anything its options need in `editor/OptionsTab.tsx`, and what `changeType` should keep.
6. Document it in the user guide's panel types and in the options table above.

### Where things are

Backend, under `backend/omnikrux/monitoring/`: `dashboards/` (`schema.py`, `store.py`, `api.py`, `ready_made.py`) and, in `query/`, `run.py` (the pipeline behind `POST /query`, the batch and label values), `api.py` (the routes).

Frontend, under `frontend/src/monitoring/`: `dashboards/` (`schema.ts`, `interpolate.ts`, `time.ts`, `runPanel.ts`, `layout.ts`, `api.ts`, and the folders `page/` (header, time, refresh, variables, the page), `grid/` (panels and their states), `editor/` (edit mode, settings, save), `drafts/`, `json/`, `versions/` and `create/` (new, copy, delete)), `OwnerDashboards.tsx` (the lists and ready-made views on project and group pages) and `charts/`.

## Running the tests

Backend, from `backend`:

```bash
python -m uv run --frozen pytest -q -m "not kind and not cloud_live"
python -m uv run --frozen ruff check .
python -m uv run --frozen ruff format --check .
```

Monitoring's tests are in `backend/tests/monitoring/`. They run against local fake tools (`tests/monitoring/fakes.py`: a Prometheus, a Loki and a Grafana, with every authentication type) and the fake cluster in `tests/fakekube.py`, so they need no cluster and no network. A watchdog in `tests/monitoring/conftest.py` bounds each of them: a test still running after five minutes prints every thread's stack and ends the run, so a hang names itself.

Frontend, from `frontend`:

```bash
npm test
npm run build
```

### The startup budget

The Monitoring app is a lazy chunk: the shell loads it only when you open Monitoring. `npm run build` ends with `check:startup`, which fails when the initial JavaScript is over 512,180 bytes or when anything under `frontend/src/monitoring/` ends up in it. The one exception is `shell/tabState.ts`, which the shell needs to restore tabs. So code under `frontend/src/monitoring/` must not be imported by shell code outside `MonitoringApp.tsx`'s lazy import, except for types, and nothing the shell imports may import the app's pages.

### The kind tests

`backend/tests/e2e/test_monitoring_kind.py` checks discovery, setup, queries, filters and dashboards against a real Prometheus and Loki in the `omnikrux-dev` kind cluster (see [Setup](setup.md) for the cluster). They run with the other kind tests:

```bash
cd backend
python -m uv run --frozen pytest -q -m kind tests/e2e/test_monitoring_kind.py
```

They need Prometheus and Loki in the namespace `monitoring`, with Services named `prometheus-server` and `loki`, and three log lines to read. Without the Services the tests skip and say so. They create their projects, sources and dashboards through the API and delete them again, leaving the tools installed.

The dashboard tests use the Prometheus only:

- `test_ready_made_views_run_on_the_cluster` sets up a project with an empty filter and takes every ready-made view the project lists. It fills each panel's queries in as the browser does (variables as `.+`, the built-ins for a one-hour range at step 30), sends them all through `POST /query/batch` and fails if any item answers `bad_query`. It also checks that **Nodes ready** in Cluster health is at least 1, that **CPU by Pod** in Pod health returns a series, and that the view doesn't report kube-state-metrics or cAdvisor as missing.
- `test_node_health_on_the_cluster` checks that **CPU busy** in Node health has one series per node. It skips with "node-exporter isn't installed in the monitoring namespace." when the project's Prometheus has no `node_cpu_seconds_total`, which is the case with the values below.
- `test_dashboard_lifecycle_on_the_cluster` copies Cluster health into the project, saves a change, restores version 1 and deletes the dashboard, then checks that the four audit records exist in that order.

Install the tools any way you like, for example with Helm or Argo CD, as long as the Services have those names. This is what the checks were written against:

| Tool | Chart | Pinned version | Service |
| --- | --- | --- | --- |
| Prometheus | `prometheus-community/prometheus` | 29.48.0 | `prometheus-server` (port 80) |
| Loki | `grafana/loki` | 7.7.0 (Loki 3.6.11) | `loki` (port 3100) |

Prometheus values (a small server plus kube-state-metrics, no Alertmanager, Pushgateway, node-exporter or volume, six hours of retention). Set `prometheus-node-exporter: {enabled: true}` to run the Node health test instead of skipping it:

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
