# Kubernetes

The Kubernetes app shows every cluster in OmniKrux side by side, live. Open it with `Alt 1`.

## Home

Home is where a new tab starts.

- **Search.** Press `/` to focus the search box. It searches clusters, kinds and Pods in every cluster at once. Results are grouped (Clusters, Kinds, Pods, and a "Find ... in ..." entry that opens a kind with your text as its filter). `↑` `↓` move, `Enter` opens, `Esc` clears.
- **Problems right now.** Appears when something needs attention. Connection problems come first, each with **Open cluster**. Failing Pods start collapsed under **Show N failing Pods**; expand to see up to five per cluster, and use **View all N failing Pods** to open that cluster with the failing filter. Opening a Pod entry selects that exact Pod and shows its details. If the Pod has been replaced, OmniKrux does not open a same-name replacement. **Back** returns to Home.
- **Clusters.** One card per cluster. A cluster that is updating or unavailable does not count as healthy; **Partial coverage** means only some clusters have current Pod status. Open a card to browse its Pods.
- **Discovered clusters.** See [Cloud accounts](cloud.md).
- **Recently closed.** Reopen a tab you closed.

## Kinds and tables

Every kind a cluster serves is listed, custom resources included, under its fully qualified name such as `pods`, `deployments.apps` or `widgets.example.omnikrux.dev`. A kind a cluster does not serve says "This cluster doesn't serve {kind}." instead of showing an empty table.

- The row of kind tabs shows your pinned kinds. Change them in [Settings](audit-and-settings.md#pinned-kinds) or from a kind tab's menu (right-click it, or press the menu key or `Shift F10`).
- `:` jumps to any kind. `Ctrl K` opens the command palette: kinds, views and the actions of the selected row. Neither works while you type in a field, the YAML editor or a terminal.
- `←` `→` move between kind tabs.

### Filters

Above the table:

- Status chips (for kinds that have a status) and a **Namespace** chip.
- A **Clusters** chip to limit the tab to some clusters.
- A text filter ("Filter by name, label or image"), focused with `/`.
- **Add filter** for a column filter: text, pick-list, number or age, depending on the column. For example Events' Last seen can be filtered to "within 1 h". Active column filters appear as chips; remove a chip to remove its filter, or use **Clear all**.

Filters combine. Filters and sort belong to the workspace tab and return after a reload.

### Sorting, columns and bullets

- Click a sortable column heading to cycle ascending, descending and unsorted. Sorting stays within each cluster.
- Drag the divider between two headers to resize a column. Double-click it to fit the column to its content. On a focused divider, `←` `→` resize and `Enter` resets.
- Pods show one bullet per container beside their status, init containers included. Green dot: running and ready. Amber dot: running but not ready, or waiting. Rose diamond: failing. Hollow ring: finished. Hover for the container name, reason and restart count. At most six bullets show; `+n` holds the rest.

### Moving around

`↑` `↓` select rows. Row keys work as soon as a kind opens, without clicking the table.

## Details

`Enter` or `d` opens the selected row's details inline, under the row; press again to close. The details have four tabs:

| Tab | Key | Shows |
| --- | --- | --- |
| Describe | `1` | The object described, with live status |
| YAML | `2` (or `y` from the table) | The manifest |
| Events | `3` | Events, including why a container was killed or can't start |
| Metrics | `4` | Live CPU and memory (see below) |

In the details, `←` `→` and `Home` `End` move between the tabs. `Esc` closes the details.

### Metrics

CPU and memory for Pods and nodes need metrics-server on the cluster. Without it the cluster's band says why and the columns stay empty. Numbers are shown only while live: after a failed poll, or 45 seconds without a good one, they disappear rather than freeze. A Pod's bar compares usage with its limit, else its request, else its node's allocatable capacity; hover the bar to see the basis.

## Logs and shells

Logs and shells open in the dock at the bottom of the page. The dock is one row of tabs, each labelled with its cluster, namespace and Pod, so you can see where your keystrokes go. When the tabs don't fit, "{n} open" lists every session with a search box.

### Logs

- `l` on a Pod opens the **follow log**. It follows whichever Pod you select, waiting a quarter second after you stop moving. If the selected row is not a Pod it keeps the last Pod and says why.
- `Shift L` pins a log as its own tab. A pinned log never follows the row. `Shift L` inside the follow log pins its Pod.
- `p` opens the previous logs (the run before the last restart). They can take about a minute to appear after a restart.
- On a Deployment, StatefulSet or DaemonSet, `l` opens the logs of all its Pods in one view; each line says which Pod it came from.
- Controls: a container picker (the Pod's default container is used first), **Timestamps** and **Wrap** toggles, **Download**, and search with `Ctrl F` (`Enter` for the next match, `Shift Enter` for the previous). At most 50,000 lines are kept in the browser, and OmniKrux says when older ones were dropped.

### Shells

- `s` on a Pod opens a shell in one of its containers. If a container cannot run a shell, start a debug container next to it. Debug containers and node shells use `busybox:1.36` unless you set `-e OMNIKRUX_DEBUG_IMAGE=your/image:tag` (the image needs a shell). An ephemeral debug container stays in the Pod until the Pod is deleted.
- `s` on a node opens a node shell. It creates a privileged Pod in the `default` namespace on that node, with full access to the node. OmniKrux deletes the Pod when you close the session. If the session is never closed, the Pod stops by itself after one hour but is not deleted; remove it with `kubectl -n default delete pod <name>`.
- Every open of a shell, debug container or node shell is written to the [audit log](audit-and-settings.md#audit).

### Keyboard zones

Which keys work depends on where the keyboard is.

| Zone | Keys |
| --- | --- |
| Table | `↑` `↓` move, `l` follow log, `Shift L` pin a log, `p` previous logs, `s` shell, `Alt ↓` into the logs, `Ctrl Del` delete (reviewed first), `1`–`4` detail tabs while details are open |
| Logs | `↑` `↓` `PgUp` `PgDn` scroll, `Home` / `End` (or `G`) top and live end, `←` `→` switch dock tab, `Ctrl F` search, `Shift L` pin this log, `Ctrl Del` close the tab, `Esc` or `Alt ↑` back to the table |
| Shell | Every key is the shell's, `Esc` included. `Alt ↑` goes back to the table. When the shell has ended (`exit`, `Ctrl D`), `Enter` closes its tab |

`Esc` never closes a log; it returns to the same table row. `Ctrl \` switches the dock between one pane and two panes side by side. Open a second session first: with only one, the button explains why it is disabled. The dock stays when you switch apps or tabs.

## Changing things

Edit, scale, restart, roll back (Deployments), delete, cordon, uncordon, drain and evict (Pods) all follow the same steps:

1. **Review.** OmniKrux shows the cluster, the object and a diff.
2. **Confirm.** You confirm in the dialog.
3. **Audit.** The change is written to the audit log. If the log cannot be written, nothing is applied.
4. **Apply.** OmniKrux applies exactly what you reviewed.

What you review is kept on the server for 300 seconds and used once. If the object changed in the meantime you read "{Kind} {name} changed since you reviewed this change. Review it again." A review opens with its action button focused (Cancel for Delete, Drain and Evict), so `Enter` confirms; `Ctrl Enter` confirms any review.

On a production cluster the review says so. Deleting or draining on a production cluster asks you to type the object's name. So does deleting a namespace, PersistentVolume, PersistentVolumeClaim or custom resource definition, or deleting or draining a node, on any cluster.

### By kind

| Kind | Keys on a selected row |
| --- | --- |
| Pods | `l` follow log, `Shift L` pin, `p` previous logs, `s` shell, `f` port-forward |
| Deployments | `s` scale, `r` restart, `l` logs of all Pods (roll back is in the details) |
| StatefulSets | `s` scale, `r` restart, `l` logs of all Pods |
| ReplicaSets | `s` scale |
| DaemonSets | `r` restart, `l` logs of all Pods |
| Services | `f` port-forward |
| Nodes | `c` cordon, `u` uncordon, `r` drain, `s` shell on the node |
| Secrets | `x` open the secret's keys, then reveal the focused one |

On every kind `Enter` or `d` opens the details and `y` the YAML. `e` edits and `Ctrl D` (or `Ctrl Del`) deletes, only on kinds that allow it. Helm releases are read-only; use `helm` to change them.

- **Edit.** The YAML editor reviews with `Ctrl Enter`. `Esc` leaves the editor onto **Review changes**, and `←` `→` move between **Review changes** and **Discard**.
- **Scale.** Enter the number of replicas.
- **Restart.** Restarts every Pod of the workload.
- **Roll back.** Pick a revision; the previous one is chosen to start with.
- **Cordon and uncordon.** Mark a node unschedulable or schedulable.
- **Drain.** Options: "Evict pods without a controller" and "Delete emptyDir data". Drain runs as a job you can watch and cancel; the node stays cordoned if it stops.
- **Delete.** Select several rows with their checkboxes (up to 50) and use **Delete selected** to review them together.

## Secrets

Secret values stay on the server until you reveal them. Rows, details, YAML and diffs show each key masked as `•••••• ({n} bytes)`. Reveal keys one at a time; several can stay revealed. **Hide** drops one; **Hide all** masks everything. Values are also dropped when the browser tab is hidden, the details close, you select another row or tab, or the resource version changes. Each reveal is audited by key name only. Values live only in the open details' memory, never in browser storage, the URL or history. Secrets cannot be edited in OmniKrux; use `kubectl`.

## Port-forwards

Press `f` on a Pod or Service (or use **Port-forward** in its details), then pick one of the offered ports or type another. A forward listens on `127.0.0.1:{port}` on this machine, using a port from `30000-30019` by default (change it with `-e OMNIKRUX_PORT_FORWARD_PORTS=31000-31009`). A Service forward needs a ready Pod behind it. When all ports are in use, stop one first.

A **Port-forwards** menu appears in the top bar while any exist. It lists each forward with its address, a copy button and **Stop**. Forwards stop when OmniKrux stops. Each start is audited.

Because the console runs in a container, publish the range as well and make the forwards listen on every interface inside the container. Your machine still publishes them on `127.0.0.1` only:

```bash
docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:30000-30019:30000-30019 -e OMNIKRUX_PORT_FORWARD_BIND=0.0.0.0 --add-host=host.docker.internal:host-gateway -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

On Windows PowerShell replace the kubeconfig mount with `-v "${env:USERPROFILE}\.kube:/kube:ro"`. Do not drop `127.0.0.1` from the range: that would expose the forwarded service to your network. With `--network host`, add neither option. `OMNIKRUX_PORT_FORWARD_BIND` must be an IP address or OmniKrux refuses to start.

## Workspace tabs and split view

The tabs above the Kubernetes app each keep their own kind, cluster scope, filters, sort, selected row, scroll position and back/forward history.

| Key | Action |
| --- | --- |
| `Alt T` / `Alt W` | New / close tab |
| `Alt PgUp` / `Alt PgDn` | Previous / next tab |
| `Alt ←` / `Alt →` | Back / forward in this tab |

`+` opens a new Home tab and `×` closes one. The browser's Back and Forward buttons work too. Switching to Audit or Settings and back returns to the same tab. Only the active tab (or the two tabs of a split) is live; background tabs keep no watches or open details.

To see two tabs together, open a tab's menu (right-click it, or the menu key) and choose **Split side by side**, or **Open in new split tab** to open its view in a second pane. **Close split** ends it. A split shows exactly two tabs.

Tabs and pinned kinds are saved in this browser only. If browser storage is blocked, full or unreadable, OmniKrux says so and keeps working in memory.

## Keyboard shortcuts

Press `?` for the sheet of every shortcut; it narrows to the kind you are on. The most useful:

| Shortcut | Action |
| --- | --- |
| `Alt 1` / `Alt 8` / `Alt 9` | Kubernetes / Audit / Settings |
| `Alt T` `Alt W` `Alt PgUp` `Alt PgDn` `Alt ←` `Alt →` | Tabs and history |
| `↑` `↓` | Select the previous / next row |
| `Enter` / `d` | Open or close the details |
| `1`–`4`, `y` | Details tabs, YAML |
| `/` | Focus the filter |
| `:` / `Ctrl K` | Jump to a kind / commands |
| `Ctrl Enter` | Confirm the open review |
| `Ctrl Del` | Delete what has focus: a row (reviewed first) or a dock tab |
| `?` | Show all shortcuts |

Keys typed in a field, the YAML editor or a terminal belong there. Page shortcuts pause under a modal dialog. AltGr never switches apps or tabs.
