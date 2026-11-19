# Architecture

OmniKrux is one FastAPI process that serves a JSON/WebSocket API under `/api` and, in the image, the built React app as static files. One Docker image holds both. State lives in a SQLite database and an encryption key in the data directory (`/data` in the image).

```
browser (React) ──HTTP + WebSocket──▶ FastAPI (omnikrux.main) ──▶ clusters, cloud providers
                                           └── SQLite + secret key in OMNIKRUX_DATA_DIR
```

## Code layout

```
Dockerfile              multi-stage build: frontend, cloud login plugins, Python runtime
backend/
  pyproject.toml        dependencies, ruff and pytest settings (uv.lock pins them)
  omnikrux/             the application package
  tests/                pytest suites, one folder per package
frontend/
  package.json          scripts: dev, build, check:startup, test
  src/                  the React app
  scripts/              the startup bundle budget check
scripts/                dev-kind.sh and its fixtures
docs/                   these guides, design specs and plans
```

## Backend packages

`backend/omnikrux/main.py` builds the app (`create_app`): validates settings, wires every service into `app.state` in a lifespan function, adds the two middleware, includes each package's router and mounts the SPA last so it never shadows `/api`.

| Package | Role |
| --- | --- |
| `config.py` | `Settings`: every `OMNIKRUX_*` environment variable |
| `db.py`, `migrations/` | SQLAlchemy async engine; Alembic migrations run at startup |
| `clusters/` | The cluster registry, kubeconfig parsing and import, `/api/clusters` |
| `cloud/` | Cloud accounts and discovery: one adapter per provider (`azure.py`, `aws.py`, `gcp.py`, `oci.py`), token broker, discovery loop, `/api/cloud/*` and `/api/settings` |
| `kube/` | Connections to clusters, token sources, API discovery, the list-and-watch source |
| `resources/` | Kinds (`kinds.py`, `kind_rows.py`), the kind catalog, describe, YAML output (the one place Secret values are masked), `/api/kinds` and the per-object routes |
| `watch/` | `WatchHub` and per-cluster, per-kind `WatchCache`; the `/api/watch` WebSocket |
| `actions/` | The action pipeline and one handler per action (`edit`, `scale`, `restart`, `rollback`, `delete`, `evict`, `cordon`, `uncordon`, `drain`) |
| `audit/` | The audit table, `AuditLog`, `/api/audit` |
| `logs/`, `exec/` | The `/api/logs` and `/api/exec` WebSockets; debug containers and node shells |
| `portforward/` | The port-forward manager and `/api/port-forwards` |
| `metrics/` | metrics-server reads and cache |
| `security/` | `SecretBox`, the encryption for stored credentials |
| `stream_sessions.py` | Tracks open log and exec streams so removing a cluster or account can end them |
| `web.py`, `web_security.py` | SPA serving; the Host check and cross-origin write guard |

### Watch and streams

Lists are live. The browser opens one `/api/watch?kind=...` WebSocket per visible kind. `WatchHub` keeps a `WatchCache` per (cluster, kind) that lists the kind (in pages of 500) and then watches it, backs off and retries when a cluster is unreachable, and fans snapshots and deltas out to every subscriber. A cluster that does not serve a kind is reported as such and rechecked every five minutes. Logs and shells are separate WebSockets (`/api/logs`, `/api/exec`). Every WebSocket route refuses a cross-origin browser before accepting.

### The action pipeline and audit

Every change to a cluster goes through `actions/pipeline.py`. The browser never sends a change itself:

1. `POST /api/actions/plan` names an action and a target. The handler reads the live object and returns the plan (diff, title, whether a typed confirmation is needed). The server keeps the plan, by id, for 300 seconds, and a plan can be used once.
2. `POST /api/actions/{plan_id}/apply` takes only the plan id and the typed confirmation. It cannot act on anything but what was planned.
3. Before the handler's `apply` runs, `AuditLog.begin` writes the record. If that fails, nothing is applied ("no audit, no change"). The record is finished as `succeeded`, `failed` or `unknown` afterwards.
4. Each handler's apply carries a Kubernetes precondition, so an object that changed since the review answers with a conflict instead of being changed.

Handlers register in `actions/__init__.py` with `register(name, handler)`. Long actions (drain) run as jobs in `actions/jobs.py` (`/api/actions/jobs/{id}`, cancellable). Things that do not change an object but still matter (shells, debug containers, node shells, port-forwards, secret reveals, cluster and account add or remove) call the audit log directly with their own action name. The audit table (`audit/models.py`) keeps snapshots of the cluster name and provider so a record still reads right after a cluster is removed. The actor is the constant `local` until logins exist.

### Secrets

Two different things are called secrets.

- Kubernetes Secrets: `resources/yaml_out.py` masks every value as `•••••• ({n} bytes)` in YAML, plans and audit diffs. Values reach the browser only through `POST /api/clusters/{cluster_id}/secrets/{namespace}/{name}/reveal`, one key at a time, and each reveal is audited by key name. The `edit` action refuses Secrets and Helm releases.
- OmniKrux's own credentials (cloud account credentials, kubeconfigs with credentials): encrypted with `SecretBox` (Fernet) before they reach the database. The key is `OMNIKRUX_SECRET_KEY` or a `secret.key` file created in the data directory on first start. Credentials are never returned to the browser.

## Frontend

`frontend/src/` is React with TanStack Query and TanStack Virtual, CodeMirror for YAML and xterm for shells.

| Folder | Role |
| --- | --- |
| `main.tsx`, `App.tsx` | Entry; `App` provides the query client and renders `Shell` |
| `api/` | Typed HTTP and WebSocket access: `http.ts`, `ws.ts`, `useWatch.ts` (live lists), `useClusters.ts`, `useCloud.ts`, `useKinds.ts`, `useMetrics.ts` |
| `features/shell/` | The app shell: rail, workspace tabs, workspace state (`workspace.ts`, stored in the browser under `omnikrux.workspace`), the app registry `apps.tsx` |
| `features/kubernetes/`, `home/`, `territories/`, `inspector/` | The Kubernetes app: tab view, Home, the table, the details |
| `features/actions/` | Review dialogs, YAML editor, tools per kind (`tools.ts`) |
| `features/dock/`, `logs/`, `portforward/` | The dock, log panes, port-forwards |
| `features/chrome/` | Filter bar, kind tabs, top bar, and `shortcuts.ts`, the one list of keyboard shortcuts that every other part reads |
| `features/palette/` | The `Ctrl K` command palette |
| `features/audit/`, `settings/` | The Audit and Settings pages |
| `design/` | Fonts and design tokens |

Startup size matters: `npm run build` fails when the initial JavaScript exceeds its budget or when Audit, Settings, the resource table, the details, xterm or CodeMirror are loaded eagerly (see [Testing](testing.md)). The Audit and Settings views are `lazy` imports in `Shell.tsx`.

## How an app is added to the rail

Each OmniKrux app has its own life: its own code area, versions, plans and improvement list, and work on one app does not change another as a side effect. Kubernetes is the first app; Audit and Settings are shared pages that sit in the same rail.

To add an app, in the shared shell:

1. Add its id to `AppId` in `frontend/src/features/shell/workspace.ts` and give the workspace a place for its state if it has tabs.
2. Add an entry to `APPS` in `frontend/src/features/shell/apps.tsx`: `id`, `label`, `title`, the digit `key` (the app opens on `Alt` plus that digit), `place` (`top` or `bottom` of the rail), `tabs` (whether it has workspace tabs) and an `Icon`. The rail, the `Alt` shortcut and the "?" sheet's "Switch app" line all read this list.
3. Render it in `Shell.tsx`, using a `lazy` import so the app stays out of the startup bundle, and add its heavy modules to `deferredModules` in `frontend/scripts/check-startup-bundle.mjs`.
4. Add its hash route in `frontend/src/route.ts` if it needs one (`#/<app>`).
5. On the backend, give it its own package under `backend/omnikrux/` with a router, include it in `create_app`, and reuse the shared pieces instead of copying them: `AuditLog`, `SecretBox` and the action pipeline.

Changes outside the new app's own code are limited to that wiring, and must not change how existing apps behave. Anything that links one app to another is a planned change to the app that shows the link.
