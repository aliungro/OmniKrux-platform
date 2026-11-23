# Monitoring: developer guide

Monitoring reads metrics and logs from tools you already run (a Prometheus-compatible service, Loki) and shows them per project. It has sources, projects, groups, label filters, discovery in known clusters, the query proxy, dashboards, the catalog that the building tools and Explore read, the faster ways to build a panel, and Explore. Alerts are not here yet. For what the app does for its users, see the [user guide](../user/monitoring.md).

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
| `explore/` | `catalog.py` (the catalog cache and `project_catalog`) and `api.py` (`GET /projects/{id}/catalog`). See [The catalog](#the-catalog). |
| `audit.py` | Writes Monitoring's entries to the shared audit log. |

Frontend, under `frontend/src/monitoring/`: `MonitoringApp.tsx` (the app and its pages), `shell/` (tab state), `sidebar/`, `home/`, `sources/`, `setup/`, `projects/`, `groups/`, `search/`, `api/` (client, hooks, types, query helper), `dashboards/` and `charts/` (see [Dashboards](#dashboards)), `catalog/` (the catalog's client and merge, see [The catalog](#the-catalog)), `build/` (the finder, suggestions, recommendations and Add panel's search and rail, see [Building faster](#building-faster-the-finder-and-the-suggestions)), `explore/` (see [Explore](#explore)) and `test/` (a fake API for tests).

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
- `test` (never raises for an unreachable tool; it reports it), `query`, `describe_fields`, `catalog`, `label_values` and `alerting`.

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

**Compatibility.** Stored documents are read back by later versions, and later features (importing dashboards, alerts on a panel) read them too. A change that isn't backward compatible needs `schemaVersion` 2 and a migration; never redefine version 1 in place.

### Routes and tables

Routes are under `/api/monitoring`, in `dashboards/api.py` and adopted into the router like the others:

| Route | What it does |
| --- | --- |
| `GET /dashboards` | The saved dashboards (`owner_kind` and `owner_id` narrow it): id, owner, title, version, panel count, update time. |
| `POST /dashboards` | Creates one for an owner from a document. |
| `POST /dashboards/copy` | Copies a dashboard, or a ready-made view, for any owner, with the sources the owner can't use set to null. A `title` given is used as it is. Without one, a saved dashboard's copy is titled "… (copy)" and a ready-made view's keeps the view's title, either made unique for the owner if taken ("Pod health (2)"). |
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

Deleting a project or a group deletes its dashboards and their versions in the same transaction. The delete review lists them (`dashboards` in the review), and a delete whose review went stale is refused, like a project's delete review.

### How a panel run is built

`frontend/src/monitoring/dashboards/runPanel.ts` turns a panel into requests; the server runs them.

1. **Variables and built-ins.** `interpolate.ts` substitutes `$name` and `${name}` in each shown, non-empty query in one left-to-right pass over the original text, tracking the quote it is in. A value is escaped for that quote (double, single or backtick), and a multi-value variable or **All** becomes a regex (`.+` for all). A value that can't be placed safely, which is anything outside quotes that isn't a plain word, raises `VariableError` ("Put $x inside double quotes in the query."), and that query is skipped with the reason, never sent unsubstituted. Comments (`#`) are copied untouched. A carriage return outside quotes that isn't part of a Windows line break places no variable either (PromQL ends a comment there, this scan only at a line feed, so the two could disagree on the quotes): it raises `VariableError` with its own words, and the query text is never changed. The built-ins are `$__interval` (the step), `$__rate_interval` (four steps, at least a minute) and `$__range` (the range), written as durations.
2. **Time and step.** `time.ts` resolves the range against "now" (the page owns "now"; each refresh is a new window, never the old one sent again). `stepFor` picks the smallest of a fixed list of steps that keeps about 60 points per grid column the panel is wide, and `alignRange` rounds the window to the step so repeated runs hit the same points. Bar and table panels run an instant query at the end of the range; every other type runs a range query; a logs panel also sends its `limit` and direction.
3. **Sources and fan-out.** A project dashboard sends each query to the source it names, or the project's first source of that type when `id` is null. A group dashboard sends each query once per selected member project, each to that project's own first source of the type, always with that project's `project_id`. A query whose project has no such source, or whose named source isn't linked, becomes a skipped part with its reason.
4. **The batch.** All requests of a panel go in one `POST /query/batch` (split at 64 by `runRequests`). The route runs at most 8 items at once, each through its own project's filter with the query proxy's limits, and answers 200 with every item's result in order. One item's failure, including an unexpected one, fails only that item, and an item without a `project_id` is refused ("Pick the project this query belongs to.") because a batch never reads a source unfiltered. An item whose source isn't linked answers `not_linked`.
5. **Merging and state.** `mergePanelResults` builds the series, log lines and problems, and decides the state: no parts and no skips is `noQuery`; every part failed or skipped is `unreachable` when each failure is the tool not answering (`unreachable`, `timeout`, `unauthorized`, `too_large`, `tool_error` or a network failure) and `error` otherwise; some failed or skipped, or an answer was cut short, is `partial` (even if the rest is empty, so a failure is never read as no data); no series and no lines is `empty`; else `ready`. Series keys are stable (query, project and sorted labels). A request that fails as a whole shows its reason with no series: never the previous data. While a new window loads, a panel keeps the chart it last drew; there is no mark on the panel itself, only the page's **Updating…** line.

`useDashboardContext.ts` holds what a page needs once: the owner (a project, or a group with its projects), the time, refresh, variables (each read through `GET /label-values` with the project's filter, keeping the choice within what the variable allows), the clock and the status line. Auto-refresh moves "now" and is skipped while the page is hidden. A variable whose values couldn't be read and that has nothing chosen stops the panels that use it (`blocked`): they show **Query error** with "$name couldn't load its values." instead of running with an empty value, and a later variable whose selector needs it isn't read.

The dashboard document itself is read once to show the page. A later read that fails (on window focus, after a save, after a refused save) never replaces the page or its edit session: the page shows the dashboard as last read with "Couldn't read this dashboard again, so it shows as last read." and **Try again**.

### The chart chunk

`frontend/src/monitoring/charts/` draws the panels, one component per type behind `ChartView`: time series on a canvas, gauges, bars and the stat's sparkline in SVG, and stats, tables and logs as HTML (`index.ts` exports it as the default). It is loaded lazily from `grid/PanelBody.tsx` (`lazy(() => import("../../charts"))`), and the JSON editor's CodeMirror loads with the JSON tab, so the dashboard page itself stays small and the startup budget (above) holds. `charts/lazyCharts.test.ts` fails if any file outside `charts/` imports the chunk statically (type-only imports are fine); keep it that way when you add code.

- **Decimation.** `decimate.ts` keeps, per pixel column, the first, lowest, highest and last point in time order, so a spike never disappears and a long series costs at most four points per column.
- **Morph and count.** When a panel's query is edited (the grid tracks an edit count per panel; a refresh keeps it), a time series morphs from the last drawn frame to the new data over 380 ms (`mixColumns`, `tween`), a stat counts up to its number, and the panel's frame flashes for 450 ms. Gaps in a series jump to their target.
- **Reduced motion.** `dashboards/motion.ts` follows the system setting live (`usePrefersReducedMotion`), and the grid passes `animate` only for tiles in edit mode with motion allowed. With reduced motion every change jumps: no morph, no count, no highlight. View mode never animates.
- **Colours** come from the design tokens; the canvas reads them through `getComputedStyle` at draw time. `seriesColors` gives a panel's series the eight series tokens in turn (by query and project as they run, then by labels), so no two series share one until all eight are used. Colours stay the same across refreshes only while the panel's set of series is unchanged: a series that appears or disappears shifts the colours of the series ordered after it. Near hues are far apart in the list, `--ok` and `--warn` (Good and Warning) come last, and `--bad` is never a series colour.

### Drafts and the leave check

`frontend/src/monitoring/dashboards/drafts/` and `editor/`:

- Edit sessions live in `editSessions` (`useDashboardEditor.ts`), one per workspace tab, and a dashboard has at most one session per window: a second tab asking to edit gets "This dashboard is being edited in another tab." The editor reducer (`editorState.ts`) holds the draft, the base version it started from, the JSON tab's text and problems, and a per-panel change count.
- `useDraft.ts` writes the draft to `localStorage` (`omnikrux.monitoring.draft.<dashboard id>`) 500 ms after each change, and at once when the page hides or goes away; Save and Discard remove it. Every access to storage is caught: blocked, full or tampered storage means no drafts, and an entry that can't be read is removed rather than offered.
- Each session writes under its own `writer` id and removes only what it wrote. When another window changes this dashboard's draft (a `storage` event), the session whose user changed it last writes, so the newest draft wins and nothing is dropped silently.
- With storage blocked the edit bar warns, and a `beforeunload` handler asks before a reload or close. Browser Back and reload are otherwise not held; the draft is offered back (`DraftBanner`) when the page opens without a live session.
- `leaveGuard.ts` (`heldLeave`) decides which tab actions leave unsaved changes behind: closing the tab, navigating it elsewhere, Back or Forward in its history. `MonitoringApp` asks it before every tab action, and `LeaveDialog` offers **Stay**, **Discard changes** and **Keep draft and leave** (the last only when drafts work).
- "Unsaved work" is one question, `hasUnsavedWork` in `editorState.ts`: a draft that differs from its base, or JSON text that doesn't apply yet (the draft keeps its last valid version, which may equal the base). The leave check, the stored draft, the reload prompt, opening something just made in a new tab, the draft offer and a save's answer all ask it, so a broken paste is never dropped silently.
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

## The catalog

The catalog is what a project's sources hold under that project's label filter: metric names with their type, help, unit, labels and series count, and Loki's stream labels with their values. Add panel, the suggestions, the recommendations and Explore's list all read it.

### Route and shape

`GET /api/monitoring/projects/{id}/catalog` (`explore/api.py`) answers one section per linked source, in link order: `source_id`, `source_name`, `source_type`, `state` (`ok`, `partial` when it carries notes, or `error` with a `message` and no catalog), `built_at`, `metrics`, `labels`, `streams` and `notes`. A source that fails is its own `error` section and never fails the project's other sources. It is read only, so nothing is audited. `?refresh=true` rebuilds (`true` or `1`; `false`, `0` or nothing reads the cache; anything else is a `400`). A project that doesn't exist is `404 not_found`.

### What each connector reads

`Connector.catalog(transport, matchers=, now=, limits=)` returns a `SourceCatalog` (`sources/connector.py`).

- **Prometheus-compatible** (`prometheus.py`): `/api/v1/label/__name__/values` and `/api/v1/labels`, both with `match[]` set to the link's filter; `/api/v1/metadata?limit_per_metric=1`; and `/api/v1/series` over the last 15 minutes with the filter injected into `{__name__=~".+"}`, for the labels and series count of each metric. A metric's type comes from its metadata or, without it, from the histogram family rule: `_bucket`, `_sum` and `_count` follow their base name (and a `_bucket` with an `le` label is a histogram). A tool that refuses to list series (4xx), answers too much or too slowly leaves labels empty and adds a note.
- **Loki** (`loki.py`): without a filter, `/loki/api/v1/labels` over the last hour and the values of each label (six calls at a time). With a filter, one `/loki/api/v1/series` call with the filter as the selector, so nothing outside the filter is ever asked for, and the labels and values are read from the streams it returns. Labels that start with `__` are dropped.

### Limits and notes

`CatalogLimits` holds the limits and the connector adds a plain-words note when one applies:

| Limit | Value | Note |
| --- | --- | --- |
| metrics | 5000 | "Showing the first 5000 metrics. Search and the list cover only those." |
| help text | 200 characters, cut with `…` | none |
| series read | 50000 | "Labels per metric come from the first 50000 series." |
| labels per metric | 50 | none |
| stream labels | 50 | "Showing the first 50 log labels." |
| values per stream label | 200 | "Some log labels have more than 200 values; only the first 200 are listed." |
| streams read | 5000 | none |
| no series listing | | "This source didn't list its series, so labels per metric are missing." |

### The filter rule and one caveat

Every Prometheus call that can take `match[]` carries the link's filter, so names and labels come only from what the project may see. The metadata endpoint takes no `match[]`, so it is read whole, but only the names the filtered list returned are looked up in it, and for a histogram's base name only the type is read, never its help or unit.

With `limit_per_metric=1` the answer holds a single entry per metric name, whichever the tool returns first. So a metric name that two projects both export (the same exporter on two clusters behind one shared Prometheus) can show the other project's help text. Only the help and unit are affected; the names, labels and series counts always come from the filtered calls.

### Cache

`explore/catalog.py` keeps entries in `CatalogCache`, keyed by project id, source id, the filter's text and the source's `updated_at`, so one project's entry is never served to another and a changed filter or source builds a new one.

- An entry is served for 300 s (an error for 30 s). `refresh=true` rebuilds, but not more than once per 10 s per source; a refresh inside that gap gets the entry as it is.
- One build per key at a time (single flight): every caller for that key awaits the same task. A caller that goes away never cancels it.
- A build is bounded by 20 s inside the shared task, so a timed-out build ends there and its error is cached like any other. `project_catalog` reads at most four of a call's sources at once, and the whole call answers within the timeout however many sources hang.
- At most 64 entries are kept, the least recently used dropped first.
- The secrets are checked before any request, as for a query. A source whose secrets can't be read is that source's `error` entry.

In the browser, `useProjectCatalog` keeps an answer for 300 s too (`CATALOG_STALE_MS`), and `useRefreshCatalog` asks for `refresh=true` and puts the answer in the cache. A group's catalog is its members' catalogs read one by one (never one request for several projects) and merged by name in `catalog/merge.ts`. Both shapes carry `builtAt`, the oldest build, for the "Known metrics from …" line.

## Building faster: the finder and the suggestions

Code is in `frontend/src/monitoring/build/`. Nothing here calls a model or a paid service.

### The finder

`finder.ts` turns plain words into candidate panels. `buildFinderIndex(catalog)` tokenizes the catalog once (metric names split at `_` and `:`, labels, help words, stream labels and values), and `findPanels(index, text)` scores entries, so a keystroke never re-splits thousands of names. The rules:

- The text is lowered and split on anything but letters, digits, `_` and `:`; words in `STOP_WORDS` are dropped. `by` or `per` followed by a word is the split label; `p50`, `p90`, `p95` and `p99` set the percentile.
- A word scores 4 for a whole-token match (after plural stripping and `SYNONYMS`), 2 for a token it starts (words of three letters or more), 2 for a label name and 1 for a help word. An entry carrying the split label gets 4 more, and one that lacks it loses 3. An entry with no content points never qualifies on intent alone.
- An intent bonus is added by kind: errors (the `error` synonym group, a status label on the counter) +3, latency (a percentile or the latency group, a histogram that looks like a timing) +3, logs +3 for lines and +1 for volume, and "volume" or "count" +3 for volume.
- Results sort by score, then kind (rate, errors, quantile, value, volume, lines), then series count, then title; at most six are kept (`FINDER_MAX_RESULTS`), and a candidate whose query can't be written (`UnwritableQuery`) or repeats an earlier query is skipped.
- Queries are written only through `writeQuery.ts` (`writeMetricQuery`, `writeLogQuery`, `writeVolumeQuery`), which writes a name or label only when it is a plain identifier.

A test (`finder.test.ts`) matches 5000 metrics and requires each search to take under 50 ms on average.

To add a synonym, add the word to the right group in `SYNONYMS` (or a new group, then use it where intent is read in `findPanels`) and add a case to `finder.test.ts`. To add a candidate kind, extend `Kind` and `KIND_RANK`, make `findPanels` call `put` for it, write its query in `write`, and add its tests to `finder.test.ts`.

### The suggestion table

`suggest.ts` holds `RULES`, one function per suggestion; each returns a `Candidate` or `null` when what it needs isn't in the catalog. `suggestPanels(catalog)` runs them in order and keeps up to `MAX_SUGGESTIONS` (8): `requestRate`, `errorRate`, `latencyP95`, `podRestarts`, `logVolume`, `cpuByPod`, `memoryByPod`, `nodeCpu`, `targetsDown`, `errorLogs`. Two rules pick a label in a fixed order: the split label from `SPLIT_LABELS` and the log label from `STREAM_LABELS` (`namespace`, `app`, `service_name`, `job`, `container`), so a cluster whose logs carry both `namespace` and `job` gets `{namespace=~".+"}`.

To add a suggestion:

1. Add a `Make` function to `RULES` in `suggest.ts`. Write its query through the writers, give it a stable `key`, a title and a subtitle.
2. Add its exact-query test to `suggest.test.ts`, against a catalog from `testCatalogs.ts`, and a case for when it must not appear.
3. Add its template to the kind test `test_suggestion_templates_run_on_the_cluster`, with the built-ins filled in (`$__rate_interval` as `2m`, `$__interval` as `30s`).

`candidatePanel` turns a candidate into a panel for the dashboard schema (a logs panel takes no `unit`). `usePreviews` runs the first few cards' queries through `POST /query/batch` (each item carries `project_id`) 250 ms after the list settles, with at most three previews at a time in Add panel.

## Recommendations

`recommend.ts` holds `RULES` (`perSecond`, `widerWindow`, `stackedArea`), each a `RecommendationRule` whose `evaluate(context)` returns a `Recommendation` (`id`, `key`, `text`, `apply(panel)`) or `null`. `recommendFor` returns the first whose key was not dismissed. The key names the rule, the panel and the query, so a dismissal holds for that one case. `RecommendationBar` shows it: **Apply** passes `onApply` a function that rewrites the panel as it is at that moment, and says "That query changed. Review it and try again." when the rewrite changes nothing. Dismissals live in `localStorage` under `omnikrux.monitoring.recommendations.dismissed` (at most 500, with an in-memory fallback), scoped by dashboard id or `explore:{project id}` (`dismissals.ts`).

To add a rule, write a `RecommendationRule` and add it to `RULES`, or call `registerRecommendationRule(rule)`, which returns an unregister function. `RecommendationContext` has a reserved `alert` field: the alerts work will set it from its dry run and register the rule that suggests a threshold, so the context never needs another shape. Nothing sets it yet.

## Explore

Code is in `frontend/src/monitoring/explore/`; the page is lazy like the rest of Monitoring (`ExplorePage.tsx`), and it draws through the lazy `charts/` chunk.

- **Run model** (`useExploreRun.ts`). The text runs `EXPLORE_DEBOUNCE_MS` (300 ms) after the last change, or at once with `run`. Each run is one `POST /query/batch` item carrying `project_id`, so the label filter always applies, and it is built with the same `buildPanelRun` as a dashboard panel. A newer run aborts the older one (`AbortController`) and gets a higher run id; an answer for an older id is dropped. The outcomes are `idle`, `done`, `invalid` (the tool refused the query, or `quickCheck` found an unclosed bracket or quote; the last good result is kept and drawn dimmed as **Last good result**) and `failed` (nothing is drawn). A change of project or source starts over. In logs mode the chart is the log volume (`writeVolumeQuery`, split by the Split chip). `useLinesRun` runs the lines under the chart: one item of at most 1000 lines (`LINES_LIMIT`), newest first, over the whole range or the chosen window, with states of its own, so a failure stays in its section.
- **View state.** `ExploreView` in `shell/tabState.ts` holds `project`, `source`, `expr`, `logs` and `time`. The page writes it with `replace` after a pause; `samePageAndItem` treats an Explore replace as staying, so focus stays in the query field. Each field is validated on its own when a tab is restored. A view that changes under the page (Back, or the sidebar opening Explore on another project) restarts it from that view.
- **Builder** (`builderState.ts`). Picking a metric or stream, **Split by** and **Only** are a reducer over `ExploreBuilder`; `builderQuery` writes the query through the writers. A hand edit sets `detached`, and a chip click writes the query again.
- **Trail** (`trailStore.ts`). Per project in `localStorage` under `omnikrux.monitoring.explore.trail.{project id}`, twenty entries (eight shown). Every access is guarded: blocked or damaged storage only loses the trail.
- **Add to dashboard** (`addToDashboard.ts`). Saves through `PUT /dashboards/{id}` with `origin: "explore"`; the backend then adds `from: "explore"` and `added_panels` (the titles of panels new in that version) to the `dashboard_save` audit details, and refuses the save with a conflict before auditing when the version moved. A new dashboard is created with the panel in it (`createDashboardWithPanel`).

### Chart selection and marks

`TimeSeriesChart` binds pointer and key handlers for a window only when `onSelect` is given, which only Explore does, so dashboards get the same chart as before. A drag across the plot, or `Shift ←` and `Shift →` from the crosshair (chosen once the keys rest), selects a window that snaps to the run's step (or the samples' spacing); the band stays drawn over the whole range. `marks` (`logMarks`) draws one tick per log line at its time, toned by level (`lineTone`), along the bottom. The chosen window goes to `useLinesRun`, and **Show all** (or Esc) clears it.

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

`backend/tests/e2e/test_monitoring_kind.py` checks discovery, setup, queries, filters, dashboards, the catalog and the suggestion templates against a real Prometheus and Loki in the `omnikrux-dev` kind cluster (see [Setup](setup.md) for the cluster). They run with the other kind tests:

```bash
cd backend
python -m uv run --frozen pytest -q -m kind tests/e2e/test_monitoring_kind.py
```

They need Prometheus and Loki in the namespace `monitoring`, with Services named `prometheus-server` and `loki`, and log lines to read (below). Without the Services the tests skip and say so. They create their projects, sources and dashboards through the API and delete them again, leaving the tools installed.

The catalog and suggestion tests use both tools, and need log lines labelled `job="omnikrux-m3-check"`, `namespace="demo"` and a `level` of `info`, `warn` or `error`, from the last hour (push them again when the tests find the `job` value missing or the Loki volume empty; see below):

- `test_catalog_on_the_cluster` sets up a project over the found Prometheus and Loki with empty filters and reads its catalog. Prometheus is `ok` or `partial` and lists `prometheus_http_requests_total` as a `counter` with the labels `code` and `handler`, `prometheus_http_request_duration_seconds_bucket` with its `family`, and `kube_pod_container_status_restarts_total`. Loki lists `job` with the value `omnikrux-m3-check` and a `level` label.
- `test_suggestion_templates_run_on_the_cluster` fills the suggestion templates in for this cluster's metrics (`$__rate_interval` as `2m`, `$__interval` as `30s`) and sends them through `POST /query/batch` over the last hour at step 30. No item may answer `bad_query`, and the request rate and the log volume must return data. The two Loki queries use the log label the suggestion rule would pick: the test reads the catalog and takes the first of `namespace`, `app`, `service_name`, `job` and `container` that it lists (the same order as `STREAM_LABELS` in `build/writeQuery.ts`), so on this cluster they are `{namespace=~".+"}`, not `{job=~".+"}`.
- `test_catalog_follows_a_filter_on_the_cluster` links the same Prometheus to a second project with the filter `job="prometheus"`; its catalog lacks `kube_pod_container_status_restarts_total` and the first project's has it.

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

To push the lines the catalog tests read, send one batch with a port-forward open. These are three streams that differ only in `level`:

```bash
kubectl -n monitoring port-forward svc/loki 3100:3100 &
now=$(date +%s)000000000
for level in info warn error; do
  curl -s -X POST http://127.0.0.1:3100/loki/api/v1/push -H 'Content-Type: application/json' \
    -d "{\"streams\":[{\"stream\":{\"job\":\"omnikrux-m3-check\",\"namespace\":\"demo\",\"level\":\"$level\"},\"values\":[[\"$now\",\"$level line\"]]}]}"
done
```

Both sets of lines age out: Loki only lists labels for streams with lines in the last hour, so push them again before a run when the tests report that the `job` value or the log volume is missing.
