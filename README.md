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

To use port-forwards (see below), add `-p 127.0.0.1:30000-30019:30000-30019` to the command, next to the first `-p`.

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

## Operations

Omnikrux can change things, show live CPU and memory, and forward ports, on top of the views.

### Kinds and custom resources

Every kind a cluster serves is listed, custom resource definitions (CRDs) included, each under its fully qualified name such as `pods`, `deployments.apps` or `widgets.example.omnikrux.dev`. A kind a cluster doesn't have says "This cluster doesn't serve {kind}." instead of showing an empty table. One broken API group doesn't hide the others.

Press `:` to jump to any kind, or `Ctrl K` for the command palette: kinds, views and the actions of the selected row. Neither works while you type in a field, the YAML editor or a terminal. `?` shows every shortcut for the kind you're on.

Keys on a selected row, by kind (`Enter` or `d` opens the details and `y` the YAML on every kind; `e` edits the YAML and `Ctrl D` deletes only on kinds that allow it, and Secrets can't be edited):

| Kind | Keys |
| --- | --- |
| Pods | `l` logs, `p` previous logs, `s` shell, `f` port-forward |
| Deployments | `s` scale, `r` restart, `l` logs of all its pods (rollback is in the details) |
| StatefulSets | `s` scale, `r` restart, `l` logs of all its pods |
| ReplicaSets | `s` scale |
| DaemonSets | `r` restart, `l` logs of all its pods |
| Services | `f` port-forward |
| Nodes | `c` cordon, `u` uncordon, `r` drain, `s` shell on the node |
| Secrets | `x` open the secret's keys, then reveal the focused one |

### How changes work

Every change follows the same steps: Omnikrux shows what it will do, you confirm, the change is written to the audit log, and only then is it applied.

- The review shows the cluster, the object and a diff. What you apply is exactly what you reviewed: it is kept on the server for 300 seconds and used once. If the object changed in the meantime you read "{Kind} {name} changed since you reviewed this change. Review it again."
- On a production cluster the review says so. Deleting or draining on a production cluster asks you to type the object's name. So does deleting or draining a namespace, node, PersistentVolume, PersistentVolumeClaim or custom resource definition, on any cluster.
- No audit, no change: if the audit log can't be written, nothing is applied.
- Edit, scale, restart, roll back (deployments), delete, cordon, uncordon and drain all work this way. Drain runs as a job you can watch and cancel; the node stays cordoned if it stops.
- The audit log is the Audit log view (button in the top bar). It records what was done, on which cluster, when and how it ended (Omnikrux has no login yet, so it doesn't record who), and is kept in the data volume next to your clusters. Exec, debug containers, node shells, port-forwards and secret reveals write a row too.

### Secrets

Secret values stay on the server. Rows, the details, the YAML and diffs show each key masked as `•••••• ({n} bytes)`. Reveal one key at a time; each reveal is audited by key name only, never by value, and the answer is never cached. Secrets can't be edited in Omnikrux: use `kubectl`.

### Metrics

CPU and memory for pods and nodes need metrics-server on the cluster. Without it, or while it isn't answering, the cluster's band says why and the CPU and memory columns stay empty. Metrics are only shown while they are live: after a failed poll, or 45 seconds without a good one, the numbers disappear rather than freeze. `bash scripts/dev-kind.sh` installs metrics-server on the local kind cluster.

### Port-forwards

Press `f` on a pod or service (or use Port-forward in its details) to forward one of its ports to this machine. A forward listens on `127.0.0.1:{port}`, with the port taken from `30000-30019` by default; change the range with `-e OMNIKRUX_PORT_FORWARD_PORTS=31000-31009`. When all ports are in use, stop one first. A service forward needs a ready pod behind it.

A forward is reachable only from this machine. Publish the range on `127.0.0.1` only (`-p 127.0.0.1:30000-30019:30000-30019`, as in the run command above); publishing it without `127.0.0.1` would expose the forwarded service to your network. Forwards stop when Omnikrux stops. With the Linux `--network host` command above, no `-p` is needed: the forwards listen on the host's `127.0.0.1` directly.

Full commands with the port range (set `OMNIKRUX_PORT_FORWARD_PORTS` to something else and publish that range instead if you changed it):

Linux / macOS:

```bash
docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:30000-30019:30000-30019 --add-host=host.docker.internal:host-gateway -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

Windows PowerShell:

```powershell
docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:30000-30019:30000-30019 --add-host=host.docker.internal:host-gateway -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data omnikrux:dev
```

### Other things worth knowing

- A node shell's pod is deleted when you close the session, and stops by itself after 1 hour if you never do.
- The previous logs of a container can take about a minute to appear after it restarts.
- Changes from a web page on another origin are refused (see Troubleshooting); `curl` sends no origin and is not affected.

## Local development cluster

`bash scripts/dev-kind.sh` creates a kind cluster (`omnikrux-dev`) with demo workloads in the `demo` namespace, a custom resource (`widgets.example.omnikrux.dev`), and metrics-server.

`bash scripts/dev-kind.sh --recreate` deletes the cluster and builds it again from `scripts/fixtures/kind-config.yaml` (one control plane and one worker node, which the drain tests use). The cluster's API port changes, so point Omnikrux at the new kubeconfig and restart it. Run it only on this disposable cluster.
