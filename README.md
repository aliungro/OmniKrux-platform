# OmniKrux

Web console for Kubernetes and multicloud infrastructure, shipped as a single Docker image.

## Documentation

Task-oriented guides for using and working on OmniKrux are in [docs/guide](docs/guide/README.md): getting started, the Kubernetes app, cloud accounts, Audit and Settings, and developer setup, testing, architecture and releasing.

## Run

Build the image:

```bash
docker build -t omnikrux:dev .
```

OmniKrux has no login yet, so every command below publishes it on `127.0.0.1` only (`-p 127.0.0.1:8080:8080`): anyone who can reach the port can see every cluster in your kubeconfig, so don't expose it to your network.

Linux / macOS:

```bash
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

Windows PowerShell:

```powershell
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data omnikrux:dev
```

Open http://localhost:8080.

To use port-forwards (see below), add `-p 127.0.0.1:30000-30019:30000-30019 -e OMNIKRUX_PORT_FORWARD_BIND=0.0.0.0` to the command, next to the first `-p`. Docker can only pass published ports to forwards that listen on every interface inside the container; your machine still publishes them on `127.0.0.1` only.

Host port 8080 already in use? Pick another host port, for example `-p 127.0.0.1:8090:8080`, and open http://localhost:8090.

OmniKrux answers only to requests addressed to `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`. To reach it under another name, set `-e OMNIKRUX_ALLOWED_HOSTS=omnikrux.example,localhost` (comma-separated; `*` turns the check off).

The kubeconfig is read from `/kube/config` inside the container. Cluster state is kept in the `omnikrux-data` volume, so restarts keep the same clusters.

Kubeconfig servers on `127.0.0.1`/`localhost` (kind, minikube, k3d) point at the container itself, so inside the container OmniKrux rewrites them to `host.docker.internal` and says so on the cluster's band.

### Linux: local clusters (kind, minikube)

kind publishes its API server on the host's `127.0.0.1` only, which `host.docker.internal` (the Docker bridge address) cannot reach on Linux. Run on the host network instead and turn the address rewrite off. `-p` does not apply on the host network, so bind uvicorn to `127.0.0.1` yourself to keep OmniKrux off your LAN:

```bash
docker run --rm --network host -e OMNIKRUX_REWRITE_LOOPBACK=false -v ~/.omnikrux-kube:/kube:ro -v omnikrux-data:/data omnikrux:dev uvicorn omnikrux.main:app --host 127.0.0.1 --port 8080
```

(`~/.omnikrux-kube` is the readable copy from the next section.)

### Linux: kubeconfig permissions

The container runs as uid 10001, but `~/.kube/config` is normally mode 0600 and owned by you, so the command above fails with "permission denied" on Linux (Docker Desktop on Windows and macOS hides this). OmniKrux logs a warning naming the unreadable file and keeps starting without it. Pick one:

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

### Upgrading from an earlier version

Clusters imported through the API are treated as coming from your kubeconfig file; if their context isn't in the mounted file they are removed on first start — upload them again.

## Cloud accounts

Connect an account in Settings → Cloud accounts to find its Kubernetes clusters. OmniKrux reads cloud account and cluster metadata and uses short-lived tokens to talk to clusters you add. Cloud discovery only reads from your provider. Use the usual review flow for operations on Kubernetes objects. OmniKrux encrypts entered credentials before storing them and never returns them to the browser.

Use an existing CLI login by mounting its folder read-only, then select the account in Settings. Keep the mount flags for the providers you use. The destination folders are the image defaults.

Linux / macOS (bash)

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -v ~/.kube:/kube:ro -v omnikrux-data:/data \
  -v ~/.azure:/cloud/azure:ro -v ~/.aws:/cloud/aws:ro \
  -v ~/.config/gcloud:/cloud/gcloud:ro -v ~/.oci:/cloud/oci:ro \
  omnikrux:dev
```

Windows PowerShell

```powershell
docker run --rm -p 127.0.0.1:8080:8080 `
  --add-host=host.docker.internal:host-gateway `
  -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data `
  -v "${env:USERPROFILE}\.aws:/cloud/aws:ro" `
  -v "${env:APPDATA}\gcloud:/cloud/gcloud:ro" `
  -v "${env:USERPROFILE}\.oci:/cloud/oci:ro" `
  omnikrux:dev
```

Windows encrypts the Azure CLI login cache for your Windows user. For the Linux container on Windows, open Settings → Cloud accounts → Enter credentials and supply an existing Azure service principal's subscription ID, tenant ID, client ID and client secret.

Run `gcloud auth application-default login` on the host to provide Application Default Credentials for Google Cloud. For OCI, keep the API signing key and any session token file inside the mounted OCI folder. On Linux the container runs as UID 10001. When your private files are readable only by your user, start the image with `--user "$(id -u):$(id -g)"` and use a data directory you own to mount at `/data`. Keep credential files private.

The image includes `kubelogin` and `gke-gcloud-auth-plugin` for kubeconfigs that name those executables. On the stock image, the GKE plugin uses Application Default Credentials from the mounted gcloud folder. In a derived image with `gcloud` on `PATH`, the GKE plugin follows the kubeconfig's arguments and can use the CLI login. OmniKrux handles supported token commands from `aws`, `aws-iam-authenticator` and `oci` directly when the corresponding CLI is absent. When those executables are on `PATH` in a derived image, they take precedence. `kubelogin` logins that use the Azure CLI (`azurecli`, `devicecode`, `interactive`) run the real `kubelogin` when both it and `az` are on `PATH` (for example a native run on a machine with the Azure CLI); otherwise OmniKrux reads the mounted Azure CLI login itself. Importing a kubeconfig runs its `exec` command on every connection, so import only kubeconfigs you trust; the command never receives OmniKrux's own `OMNIKRUX_*` settings, such as the secret key.

OmniKrux checks for newly discovered clusters every 600 seconds by default. Set `-e OMNIKRUX_CLOUD_DISCOVERY_SECONDS=900` to check every 15 minutes. Use **Check now** in Settings to check sooner. Review and add clusters under **Discovered clusters** on Kubernetes Home. In Pods, the **New clusters found** notice takes you to that list. Removing a cloud cluster in Settings removes it from OmniKrux and dismisses its discovery entry. Removing a cloud account disconnects its clusters from OmniKrux.

The optional live suite uses existing accounts. Run it only when you want real read-only verification, for example from `backend` with the local GCP project and ADC available.

```bash
OMNIKRUX_LIVE_CLOUDS=gcp OMNIKRUX_LIVE_GCP_PROJECT=my-project python -m uv run pytest -m cloud_live tests/live -q
```

Run the command without the live opt-in to verify that the live checks are skipped.

## Monitoring

Monitoring (in development) is the second app in the rail, opened with `Alt 2`. It connects projects to the Prometheus-compatible and Loki tools you already run, shows each project only its own part of them through label filters, and records its changes in Audit. Dashboards, Explore and Alerts come in later updates. See the [user guide](docs/guide/user/monitoring.md) and the [developer guide](docs/guide/developer/monitoring.md).

## Finding your way

The left rail switches between Kubernetes, Audit and Settings. Kubernetes starts on Home, with a search for clusters, kinds and pods and a live card for each cluster. Open a cluster card to browse its pods; Home health reports failing pods in rose and pods needing attention in amber. Connection issues appear first under **Problems right now**, with **Open cluster** to inspect that cluster. Cloud connection messages use safe retry guidance. Clusters that are updating or unavailable do not count as healthy; **Partial coverage** means only some clusters have current Pod status.

Failing Pods start collapsed under **Show N failing Pods**. Expand to see up to five per cluster, with each Pod's name, namespace, cluster and status; **View all N failing Pods** opens that cluster with the failing filter. Open a Pod entry to select that exact Pod and show its details in the active pane. The usual `1`–`4` detail tabs and existing tools remain available. If the Pod disappears or is replaced, OmniKrux does not open a same-name replacement. **Back** returns to Home with the list expanded as before and restores focus to the entry when it still exists, otherwise to the problems heading or search.

The workspace tabs above Kubernetes each hold their own kind, cluster scope, filters, sort, selected row, scroll position and back/forward history. Use `+` to open a fresh Home tab and `×` to close a tab. Back and Forward step through the active tab's views; the browser's Back and Forward buttons work too. Switching to Audit or Settings and back returns to the same Kubernetes tab. Only the active tab's view is live; background tabs do not keep their own watches or open details.

Settings lets you reorder, add or remove pinned kinds (including Secrets), or reset the kind row to its defaults. Drag a pinned kind (or focus it and press `Alt ↑` / `Alt ↓`); Move up, Move down and Remove are in its ⋯ menu. Tabs and pinned kinds are saved in this browser only, never shared with another browser or person. To start fresh, clear this site's data in your browser; this resets tabs and preferences, not clusters in the server's data volume. If browser storage is blocked, full or unreadable, OmniKrux explains the problem and keeps working in memory. Workspace and pinned-kind storage problems can have separate notices.

| Shortcut | Action |
| --- | --- |
| `Alt 1` / `Alt 8` / `Alt 9` | Kubernetes / Audit / Settings |
| `Alt T` / `Alt W` | New / close Kubernetes tab |
| `Alt PgUp` / `Alt PgDn` | Previous / next workspace tab |
| `Alt ←` / `Alt →` | Back / forward in this tab |
| `↑` / `↓` | Select the previous / next row |
| `Enter` / `d` | Open or close the selected row's details |
| `/` | Focus the row filter |
| `:` / `Ctrl K` | Jump to a kind / open commands |
| `?` | Show all shortcuts, including this kind's row actions |

Row keys work as soon as a kind view opens, without clicking the table: press `↓`, then `l` on Pods: a follow log opens in the dock and follows the pod you select, while the keyboard stays on the table. Keys typed in a field, YAML editor or terminal belong there; page shortcuts pause under a modal dialog. AltGr does not switch apps or tabs.

### Upgrading from Plan 3

Old `#kind=` and `#audit` links still open. The new workspace starts on Home when there is no saved workspace or link to open.

## Troubleshooting

You can work a problem from the pod list without leaving OmniKrux.

- Describe, YAML and events open inline under the row (press Enter on a pod). Events show why a container was killed or can't start.
- Logs are live and searchable. Open the previous run's logs for a container that keeps restarting, or open every pod's logs for a workload in one view (each line says which pod it came from). At most 50,000 lines are kept in the browser; OmniKrux says when older ones were dropped.
- Shells open in a pod's container. If a container can't run a shell, start a debug container next to it. Node shells open on a node.
- The dock is one row of tabs sized to their names, each labelled with its cluster, namespace and pod, so you can see which cluster your keystrokes go to. When the tabs don't fit, "{n} open" lists every session, with a search box.
- The follow log (◉ follows row) shows the pod you select. It waits a quarter second after you stop moving, keeps the last pod and says why when the selected row isn't a pod, and says when the pod is gone. It reads the pod's default container, with a picker for the others.
- Pinned logs (`Shift L`, 📌) never follow the row.
- `Esc` never closes a log. `Ctrl Del` (`⌘ ⌫` on macOS) closes a dock tab, or deletes the focused resource after the usual review.
- "Side by side" (or `Ctrl \`) shows two open logs or shells together. Open a second session to enable it; with only one, the button explains why it is disabled. The dock stays available when you switch apps or workspace tabs. Scrollbars are thin and plum, lighter on hover.

Keyboard shortcuts depend on where the keyboard is:

| Zone | Keys |
|---|---|
| Table | `↑` `↓` move · `l` follow log · `Shift L` pin a log · `p` previous logs · `s` shell · `Alt ↓` into the logs · `Ctrl Del` / `⌘ ⌫` delete (reviewed first) · `1`–`4` detail tabs while the details are open |
| Logs | `↑` `↓` `PgUp` `PgDn` scroll · `Home` / `End` top and live end (`G` too) · `←` `→` switch tab · `Ctrl F` search · `Shift L` pin this log · `Ctrl Del` / `⌘ ⌫` close the tab · `Esc` / `Alt ↑` back to the table |
| Shell | every key is the shell's, `Esc` included; `Alt ↑` back to the table; once the shell has ended (`exit`, `Ctrl D`), `Enter` closes its tab; `Ctrl Del` (`⌘ ⌫`) on the shell's tab closes it |

`Enter` details, `Ctrl \` layout, `/` filter and `?` all shortcuts work as before. In the details, `←` `→` and `Home` / `End` move between the Describe, YAML, Events and Metrics tabs.

Things worth knowing before you use them:

- Debug containers and node shells run `busybox:1.36` by default. Set `-e OMNIKRUX_DEBUG_IMAGE=your/image:tag` to use another image (it needs a shell).
- Ephemeral debug containers can't be removed. A debug container stays in the pod until the pod is deleted.
- A node shell creates a privileged pod in the `default` namespace on the node you choose, with full access to the node. OmniKrux deletes the pod when you close the session. If the session is never closed (the browser is shut, OmniKrux is stopped), the pod stops on its own after 1 hour but is not deleted; remove it yourself with `kubectl -n default delete pod <name>`.
- Requests that change things (`POST`, `PUT`, `PATCH`, `DELETE`) from a web page on another origin are refused, and so are WebSocket connections from other origins. Tools such as `curl` send no origin and are not affected.

## Operations

OmniKrux can change things, show live CPU and memory, and forward ports, on top of the views.

### Kinds and custom resources

Every kind a cluster serves is listed, custom resource definitions (CRDs) included, each under its fully qualified name such as `pods`, `deployments.apps` or `widgets.example.omnikrux.dev`. A kind a cluster doesn't have says "This cluster doesn't serve {kind}." instead of showing an empty table. One broken API group doesn't hide the others.

Press `:` to jump to any kind, or `Ctrl K` for the command palette: kinds, views and the actions of the selected row. Neither works while you type in a field, the YAML editor or a terminal. `?` shows every shortcut for the kind you're on.

In the YAML editor, `Ctrl Enter` (`⌘ Enter`) reviews your changes, `Esc` leaves the editor onto Review changes, and `←` `→` move between Review changes and Discard.

Keys on a selected row, by kind (`Enter` or `d` opens the details and `y` the YAML on every kind; `e` edits the YAML and `Ctrl D` deletes only on kinds that allow it (`Ctrl Del` (`⌘ ⌫`) deletes too), and Secrets can't be edited):

| Kind | Keys |
| --- | --- |
| Pods | `l` follow log, `Shift L` pin a log, `p` previous logs, `s` shell, `f` port-forward |
| Deployments | `s` scale, `r` restart, `l` logs of all its pods (rollback is in the details) |
| StatefulSets | `s` scale, `r` restart, `l` logs of all its pods |
| ReplicaSets | `s` scale |
| DaemonSets | `r` restart, `l` logs of all its pods |
| Services | `f` port-forward |
| Nodes | `c` cordon, `u` uncordon, `r` drain, `s` shell on the node |
| Secrets | `x` open the secret's keys, then reveal the focused one |

### How changes work

Every change follows the same steps: OmniKrux shows what it will do, you confirm, the change is written to the audit log, and only then is it applied.

- A review opens with its action button focused (Cancel for Delete, Drain and Evict), so `Enter` confirms; `Ctrl Enter` (`⌘ Enter` on macOS) confirms any review.
- The review shows the cluster, the object and a diff. What you apply is exactly what you reviewed: it is kept on the server for 300 seconds and used once. If the object changed in the meantime you read "{Kind} {name} changed since you reviewed this change. Review it again."
- On a production cluster the review says so. Deleting or draining on a production cluster asks you to type the object's name. So does deleting a namespace, PersistentVolume, PersistentVolumeClaim or custom resource definition, or deleting or draining a node, on any cluster.
- No audit, no change: if the audit log can't be written, nothing is applied.
- Edit, scale, restart, roll back (deployments), delete, cordon, uncordon and drain all work this way. Drain runs as a job you can watch and cancel; the node stays cordoned if it stops.
- In Audit, switch between **All activity** and **Failed only**. **Failed only** finds failed records across the stored history, including older pages, and combines with the cluster, action and text filters. Switching views starts at the newest matching records; **Load older** continues in the chosen view. The selected view survives reload.
- The audit log is the Audit app (Audit in the left rail). It records what was done, on which cluster, when and how it ended (OmniKrux has no login yet, so it doesn't record who), and is kept in the data volume next to your clusters. Exec, debug containers, node shells, port-forwards and secret reveals write a row too.

### Secrets

Until explicitly revealed, secret values stay on the server. Rows, the details, the YAML and diffs show each key masked as `•••••• ({n} bytes)`. Reveal keys individually; several keys can stay revealed together. "Hide" drops one revealed value; "Hide all" masks every key and drops all revealed values and pending reveals. Values are also dropped when the browser tab is hidden, the details close, you select another row or workspace tab, or the resource version changes. Each reveal is audited by key name only, never by value. Values live only in the open details' memory: never in browser storage, the URL, history or the query cache. Secrets can't be edited in OmniKrux: use `kubectl`.

### Column filters, sorting and container status

Use a column header's filter control for text, pick-list, number or age filters, depending on the column. For example, Events' Last seen can be filtered to "within 1 h". Active filters appear as chips; remove a chip to remove its filter. Filters combine with the main text, namespace and status filters. Click a sortable column heading to cycle ascending, descending and unsorted; sorting stays within each cluster. Filters and sort belong to the workspace tab and return after reload.

Drag the divider between two headers to resize a column (a guide shows the width); double-click it to fit the column to its content; `←` `→` on a focused divider resize it and `Enter` resets it. After a mouse drag the keyboard goes back to the row it was on.

Pods show one bullet per container beside their status, including init containers. A green dot means running and ready; an amber dot means running but not ready, or waiting; a rose diamond means failing; a muted hollow ring means finished. Hover a bullet for its container name, reason and restart count (finished containers show their completion reason). At most six bullets are shown; `+n` holds the remaining containers' details.

### Metrics

CPU and memory for pods and nodes need metrics-server on the cluster. Without it, or while it isn't answering, the cluster's band says why and the CPU and memory columns stay empty. Metrics are only shown while they are live: after a failed poll, or 45 seconds without a good one, the numbers disappear rather than freeze. `bash scripts/dev-kind.sh` installs metrics-server on the local kind cluster.

For each resource independently, a pod's CPU or memory bar compares live usage with a positive limit first, otherwise its request, otherwise its node's allocatable capacity. Node rows use the node's allocatable capacity. Hover the bar to see the basis and amount; "of node" explicitly means no request or limit is set. If no basis is available, OmniKrux shows the live number without a bar. Usage above a request is not treated as a limit breach.

### Port-forwards

Press `f` on a pod or service (or use Port-forward in its details) to forward one of its ports to this machine. A forward listens on `127.0.0.1:{port}`, with the port taken from `30000-30019` by default; change the range with `-e OMNIKRUX_PORT_FORWARD_PORTS=31000-31009`. When all ports are in use, stop one first. A service forward needs a ready pod behind it.

A forward is reachable only from this machine. With the usual run commands, publish the range on `127.0.0.1` only and add `-e OMNIKRUX_PORT_FORWARD_BIND=0.0.0.0`, as in the commands below: Docker can only pass published ports to forwards that listen on every interface inside the container, and your machine still publishes them on `127.0.0.1` only. Publishing the range without `127.0.0.1` would expose the forwarded service to your network. With the Linux `--network host` command above, add neither: the forwards listen on the host's `127.0.0.1`, the default. `OMNIKRUX_PORT_FORWARD_BIND` must be an IP address, or OmniKrux refuses to start. Forwards stop when OmniKrux stops.

Full commands with the port range (set `OMNIKRUX_PORT_FORWARD_PORTS` to something else and publish that range instead if you changed it):

Linux / macOS:

```bash
docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:30000-30019:30000-30019 -e OMNIKRUX_PORT_FORWARD_BIND=0.0.0.0 --add-host=host.docker.internal:host-gateway -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

Windows PowerShell:

```powershell
docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:30000-30019:30000-30019 -e OMNIKRUX_PORT_FORWARD_BIND=0.0.0.0 --add-host=host.docker.internal:host-gateway -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data omnikrux:dev
```

### Other things worth knowing

- A node shell's pod is deleted when you close the session, and stops by itself after 1 hour if you never do.
- The previous logs of a container can take about a minute to appear after it restarts.
- Changes from a web page on another origin are refused (see Troubleshooting); `curl` sends no origin and is not affected.
- The measured Plan 5 image is 548 MB, 117 MB larger than the 431 MB Plan 4 image. The increase includes the cloud dependencies and the two Kubernetes credential plugins.

## Local development cluster

`bash scripts/dev-kind.sh` creates a kind cluster (`omnikrux-dev`) with demo workloads in the `demo` namespace, a custom resource (`widgets.example.omnikrux.dev`), and metrics-server.

`bash scripts/dev-kind.sh --recreate` deletes the cluster and builds it again from `scripts/fixtures/kind-config.yaml` (one control plane and one worker node, which the drain tests use). The cluster's API port changes, so point OmniKrux at the new kubeconfig and restart it. Run it only on this disposable cluster.
