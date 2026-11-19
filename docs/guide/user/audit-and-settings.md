# Audit and Settings

Two pages sit at the bottom of the left rail: Audit (`Alt 8`) and Settings (`Alt 9`). Both are shared by every app. Switching to them and back returns you to the same Kubernetes tab.

## Audit

The audit log records what was done, on which cluster, when and how it ended. OmniKrux has no login yet, so the Who column reads `local` for every record. The log is kept in the data volume next to your clusters.

### What is recorded

- Changes: edit, scale, restart, roll back, delete, evict, cordon, uncordon and drain.
- Shells, debug containers, node shells and port-forwards.
- Secret key reveals (by key name only, never the value).
- Clusters added or removed, and cloud accounts connected or removed.

A change is written before it is applied. If the log cannot be written, nothing is applied (see [Changing things](kubernetes.md#changing-things)). If OmniKrux stops while a record is still open, the record is marked "Unknown" on the next start.

### Reading the log

Records are listed newest first with these columns: When, Who, Action, Where (cluster and namespace), What, Outcome and Message. Outcomes are Succeeded, Ended (a shell or port-forward that was closed), Failed, Started (still in progress) and Unknown (it is not known how it ended).

Open a record (click it, or select it with `↑` `↓` and press `Enter` or `Space`) to see its start and finish time, the full message, the diff of the change when there is one, and its details. Drag the dividers between column headings to resize a column.

### Filters

- **All activity** and **Failed only** switch the view. **Failed only** finds failed records across the whole stored history, including older pages. Switching starts at the newest matching records. The chosen view survives a reload.
- **Cluster** and **Action** pick lists.
- **Search** matches names, namespaces and messages.

The filters combine. **Load older** continues in the chosen view; when it is gone, "That is everything recorded." is shown.

## Settings

Settings has these sections, top to bottom.

### Cloud accounts

Connect accounts, see which CLI logins OmniKrux found, check an account now and remove accounts. Each account shows its principal, how it signs in, when it was last checked and how many clusters were found and added. See [Cloud accounts and clusters](cloud.md).

### Clusters

Lists every cluster in OmniKrux with where it came from (a kubeconfig file, an uploaded kubeconfig or a cloud account), its server and Kubernetes version. **Remove** takes a cluster out of OmniKrux (nothing changes in the cluster itself). A cluster that came from the mounted kubeconfig file comes back on the next start unless its context is gone from the file.

**Add from a kubeconfig** imports contexts from a file you choose or from pasted text. The text is kept only while that section is open, and a kubeconfig can contain tokens and keys, so import only ones you trust (an `exec` command in it runs on every connection). Clusters imported this way are marked as uploaded.

### Encryption

Says where the key that encrypts stored credentials comes from: the `OMNIKRUX_SECRET_KEY` environment variable, or a key file created in the data directory on first start. Keep the key with the data volume: without it, stored credentials cannot be read.

### Pinned kinds

The kind tabs above every Kubernetes table, in this order. The defaults are Pods, Deployments, StatefulSets, DaemonSets, Jobs, Services, Ingresses, Secrets, Nodes, Events and Helm releases.

- Reorder by dragging a row by its grip, or focus it and press `Alt ↑` / `Alt ↓`. The row's **⋯** menu has Move up, Move down and Remove.
- **Add a kind** searches the kinds your clusters serve; `↓` `↑` `Enter` pick one.
- **Reset to default** restores the list above.

### This browser

Tabs and pinned kinds are saved in this browser only, not shared with anyone. If the saved pinned kinds cannot be read, OmniKrux restores the defaults and tells you; if saving fails (storage blocked or full) it says so and keeps working in memory. Clear this site's data in your browser to start fresh; that resets tabs and preferences, not clusters in the data volume.
