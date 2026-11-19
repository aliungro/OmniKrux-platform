# Testing

Run these before you commit. They are the gates; a change is not done until all of them pass.

## Backend

From `backend`:

```bash
cd backend
python -m uv run --frozen pytest -q -m "not kind and not cloud_live"
python -m uv run --frozen ruff check .
python -m uv run --frozen ruff format --check .
```

- The pytest command is the full default suite. It needs no cluster, no Docker and no cloud account: Kubernetes and the cloud providers are replaced by local fakes (`backend/tests/fakekube.py`, `backend/tests/fakecloud.py`), and a network guard (`backend/tests/netguard.py`) keeps tests off the real network.
- pytest settings live in `backend/pyproject.toml`: async mode is `auto`, the test folder is `tests`.
- `ruff check` lints and `ruff format --check` verifies formatting (line length 100, Python 3.12). Run `python -m uv run --frozen ruff format .` to fix formatting.

Tests are grouped by package under `backend/tests/` (`actions`, `audit`, `cloud`, `clusters`, `exec`, `kube`, `logs`, `metrics`, `portforward`, `resources`, `security`, `watch`, plus a few top-level files). Run one area or file while you work:

```bash
python -m uv run --frozen pytest -q tests/actions
python -m uv run --frozen pytest -q tests/test_config.py -k allowed_hosts
```

## Frontend

From `frontend`:

```bash
cd frontend
npm test
npm run build
```

- `npm test` runs Vitest (`vitest run`, jsdom). Shared helpers are in `frontend/src/test/`.
- `npm run build` runs `tsc -b` (type check), `vite build`, and then `npm run check:startup`. The startup check fails the build when the initial JavaScript (what the browser must load before anything shows) is over its budget of 512,180 bytes, or when a module that must stay deferred (Audit, Settings, the resource table, the details, xterm, CodeMirror) ends up in the initial load. Keep new heavy code behind a `lazy` import.
- The startup check itself has a test: `node --test scripts/check-startup-bundle.node.mjs` from `frontend`.

## Markers

Two pytest markers are excluded from the default run. Both are registered in `backend/pyproject.toml`.

### `kind`

Tests that need a running kind cluster named `omnikrux-dev`: `backend/tests/e2e/`, `tests/kube/test_source_kind.py` and `tests/watch/test_ws_kind.py`. They skip themselves when kind (or kubectl, for the end-to-end ones) is missing or the cluster is not running.

Use them when you change how OmniKrux talks to a real API server: watches, actions, drain, shells, port-forwards, metrics, the cloud proxy path. Create the cluster first (see [Setup](setup.md)), then from `backend`:

```bash
bash ../scripts/dev-kind.sh
python -m uv run --frozen pytest -q -m kind
```

### `cloud_live`

Opt-in, read-only checks against your own real cloud accounts (`backend/tests/live/test_cloud_live.py`). They never run by default, and select a provider only when all of these hold:

- you pass `-m cloud_live` explicitly;
- `OMNIKRUX_LIVE_CLOUDS` lists the providers (a comma-separated subset of `azure`, `aws`, `gcp`, `oci`);
- the provider's own settings and login are available (for example `OMNIKRUX_LIVE_GCP_PROJECT` and Application Default Credentials for Google Cloud).

For example, from `backend`:

```bash
OMNIKRUX_LIVE_CLOUDS=gcp OMNIKRUX_LIVE_GCP_PROJECT=my-project python -m uv run --frozen pytest -m cloud_live tests/live -q
```

Without the opt-in the live checks are skipped, which you can confirm by running the same command without the environment variables. A transport guard refuses any request outside a read-only allowlist. Use these only when you change provider adapters and want real verification.

## Before you commit

```bash
cd backend && python -m uv run --frozen pytest -q -m "not kind and not cloud_live" && python -m uv run --frozen ruff check . && python -m uv run --frozen ruff format --check .
cd ../frontend && npm test && npm run build
```
