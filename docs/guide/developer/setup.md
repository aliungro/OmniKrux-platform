# Developer setup

## Prerequisites

| Tool | Needed for | Notes |
| --- | --- | --- |
| Python 3.12 or newer | Backend | `backend/pyproject.toml` requires `>=3.12` |
| uv | Backend dependencies | Run as `python -m uv` in the commands below, so a `uv` on `PATH` is not required (`pip install uv` or your usual way) |
| Node.js and npm | Frontend | The image builds with Node 22 (`node:22-alpine`) |
| Docker | Building and running the image | Also needed by kind |
| kind and kubectl | The local dev cluster | Optional. `scripts/dev-kind.sh` finds them on `PATH`, or in a `.tools/` folder at the repository root (git-ignored) |

## Get the code

```bash
git clone https://github.com/aliungro/omnikrux-platform.git
cd omnikrux-platform
```

(The repository is private; use whatever access you have to it.)

## Backend

The backend is a FastAPI app in `backend/omnikrux/`, managed with uv.

```bash
cd backend
python -m uv sync --frozen
```

`--frozen` installs exactly what `uv.lock` says, the development group (pytest, pytest-asyncio, httpx, ruff) included.

Run it on port 8080, which is where the frontend dev server sends `/api`:

```bash
cd backend
python -m uv run --frozen uvicorn omnikrux.main:app --port 8080 --reload
```

Outside a container the backend:

- reads `~/.kube/config` (set `OMNIKRUX_KUBECONFIG` to one path, or several separated by your OS path separator, to use others);
- keeps its database and encryption key in `.omnikrux-data/` relative to where you start it, so `backend/.omnikrux-data/` here (git-ignored); set `OMNIKRUX_DATA_DIR` to move it;
- does not rewrite `127.0.0.1` kubeconfig servers (that is on only in the container; override with `OMNIKRUX_REWRITE_LOOPBACK`);
- serves only `/api`, because `OMNIKRUX_STATIC_DIR` is not set. Without it there is no built frontend to serve.

The settings are the fields of `backend/omnikrux/config.py`, each with an `OMNIKRUX_` prefix. Database migrations (Alembic, in `backend/omnikrux/migrations/`) run on every start.

## Frontend

```bash
cd frontend
npm ci
npm run dev
```

Open the URL Vite prints. `vite.config.ts` proxies `/api` (WebSockets included) to `http://localhost:8080`, so start the backend first. The page and the API share a host and port as far as the browser can tell, which keeps the cross-origin write guard happy; do not point the browser straight at port 8080's API from a page served elsewhere.

## The kind dev cluster

```bash
bash scripts/dev-kind.sh
```

This creates a kind cluster named `omnikrux-dev` (context `kind-omnikrux-dev`) from `scripts/fixtures/kind-config.yaml` (one control-plane node and one labelled worker), then applies metrics-server and the demo workloads: a `demo` namespace with workloads, a custom resource (`widgets.example.omnikrux.dev`) and metrics-server. It is safe to re-run.

```bash
bash scripts/dev-kind.sh --recreate
```

deletes the cluster and builds it again; the API port changes, so point OmniKrux at the new kubeconfig and restart it. Run it only on this disposable cluster.

To see the cluster in a locally running backend, use the kubeconfig kind wrote (`kind get kubeconfig --name omnikrux-dev`), for example:

```bash
kind get kubeconfig --name omnikrux-dev > /tmp/omnikrux-dev-kubeconfig
OMNIKRUX_KUBECONFIG=/tmp/omnikrux-dev-kubeconfig python -m uv run --frozen uvicorn omnikrux.main:app --port 8080
```

Run that second command from `backend`. The same cluster is what the `kind` tests use (see [Testing](testing.md)).

## Running the real image locally

```bash
docker build -t omnikrux:dev .
```

then use the run commands in [Getting started](../user/getting-started.md). The image build runs `npm ci` and `npm run build` in a Node stage, so a failing frontend build or startup budget check fails the image too.
