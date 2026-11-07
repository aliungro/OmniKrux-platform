# Omnikrux

Web console for Kubernetes and multicloud infrastructure, shipped as a single Docker image.

## Run

Build the image:

```bash
docker build -t omnikrux:dev .
```

Omnikrux has no login yet, so every command below publishes it on `127.0.0.1` only (`-p 127.0.0.1:8080:8080`): anyone who can reach the port can see every cluster in your kubeconfig, so don't expose it to your network.

Linux / macOS:

```bash
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

Windows PowerShell:

```powershell
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data omnikrux:dev
```

Open http://localhost:8080.

Host port 8080 already in use? Pick another host port, for example `-p 127.0.0.1:8090:8080`, and open http://localhost:8090.

Omnikrux answers only to requests addressed to `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`. To reach it under another name, set `-e OMNIKRUX_ALLOWED_HOSTS=omnikrux.example,localhost` (comma-separated; `*` turns the check off).

The kubeconfig is read from `/kube/config` inside the container. Cluster state is kept in the `omnikrux-data` volume, so restarts keep the same clusters.

Kubeconfig servers on `127.0.0.1`/`localhost` (kind, minikube, k3d) point at the container itself, so inside the container Omnikrux rewrites them to `host.docker.internal` and says so on the cluster's band.

### Linux: local clusters (kind, minikube)

kind publishes its API server on the host's `127.0.0.1` only, which `host.docker.internal` (the Docker bridge address) cannot reach on Linux. Run on the host network instead and turn the address rewrite off. `-p` does not apply on the host network, so bind uvicorn to `127.0.0.1` yourself to keep Omnikrux off your LAN:

```bash
docker run --rm --network host -e OMNIKRUX_REWRITE_LOOPBACK=false -v ~/.omnikrux-kube:/kube:ro -v omnikrux-data:/data omnikrux:dev uvicorn omnikrux.main:app --host 127.0.0.1 --port 8080
```

(`~/.omnikrux-kube` is the readable copy from the next section.)

### Linux: kubeconfig permissions

The container runs as uid 10001, but `~/.kube/config` is normally mode 0600 and owned by you, so the command above fails with "permission denied" on Linux (Docker Desktop on Windows and macOS hides this). Omnikrux logs a warning naming the unreadable file and keeps starting without it. Pick one:

- Mount a readable copy (recommended):

  ```bash
  mkdir -p ~/.omnikrux-kube && install -m 644 ~/.kube/config ~/.omnikrux-kube/config
  docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v ~/.omnikrux-kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
  ```

- Run as your own user. A fresh named volume is owned by uid 10001 and is not writable for another user, so use a data directory you own instead of `omnikrux-data`:

  ```bash
  mkdir -p ~/.omnikrux-data
  docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway --user "$(id -u):$(id -g)" -v ~/.kube:/kube:ro -v ~/.omnikrux-data:/data omnikrux:dev
  ```

### Upgrading from Plan 1

Clusters imported through the API are treated as coming from your kubeconfig file; if their context isn't in the mounted file they are removed on first start — upload them again.

## Troubleshooting

You can work a problem from the pod list without leaving Omnikrux.

- Describe, YAML and events open inline under the row (press Enter on a pod). Events show why a container was killed or can't start.
- Logs are live and searchable. Open the previous run's logs for a container that keeps restarting, or open every pod's logs for a workload in one view (each line says which pod it came from). At most 50,000 lines are kept in the browser; Omnikrux says when older ones were dropped.
- Shells open in a pod's container. If a container can't run a shell, start a debug container next to it. Node shells open on a node.
- The bottom dock holds your log and shell sessions as tabs, each labelled with its cluster, namespace and pod, so you can see which cluster your keystrokes go to.

Keyboard shortcuts: `↑` `↓` move, `Enter` details, `l` logs, `p` previous logs, `s` shell, `Ctrl F` search logs, `Ctrl \` layout, `/` filter, `?` all shortcuts.

Things worth knowing before you use them:

- Debug containers and node shells run `busybox:1.36` by default. Set `-e OMNIKRUX_DEBUG_IMAGE=your/image:tag` to use another image (it needs a shell).
- Ephemeral debug containers can't be removed. A debug container stays in the pod until the pod is deleted.
- A node shell creates a privileged pod in the `default` namespace on the node you choose, with full access to the node. Omnikrux deletes the pod when you close the session. If the session is never closed (the browser is shut, Omnikrux is stopped), the pod stops on its own after 1 hour but is not deleted; remove it yourself with `kubectl -n default delete pod <name>`.
- Requests that change things (`POST`, `PUT`, `PATCH`, `DELETE`) from a web page on another origin are refused, and so are WebSocket connections from other origins. Tools such as `curl` send no origin and are not affected.

## Local development cluster

`bash scripts/dev-kind.sh` creates a kind cluster (`omnikrux-dev`) with demo workloads in the `demo` namespace.
