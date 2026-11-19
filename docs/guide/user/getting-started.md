# Getting started

This guide takes you from nothing to a running console that shows your clusters.

## What you need

- Docker.
- A kubeconfig with at least one working context (usually `~/.kube/config`).

OmniKrux has no login yet. Every command below publishes the console on `127.0.0.1` only. Anyone who can reach the port can see every cluster in your kubeconfig, so do not expose it to your network.

## Build the image

From a checkout of the repository:

```bash
docker build -t omnikrux:dev .
```

## Run it

The container reads the kubeconfig from `/kube/config` and keeps its own state in `/data`.

Linux and macOS:

```bash
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

Windows PowerShell:

```powershell
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data omnikrux:dev
```

Then open http://localhost:8080.

Things to know about this command:

- The `omnikrux-data` volume holds the cluster list, the audit log and the encryption key for stored credentials. Keep it between runs.
- Host port 8080 busy? Use another host port, for example `-p 127.0.0.1:8090:8080`, and open http://localhost:8090.
- OmniKrux only answers to `localhost`, `127.0.0.1`, `[::1]` and `*.localhost`. To use another name, add `-e OMNIKRUX_ALLOWED_HOSTS=omnikrux.example,localhost`.
- A kubeconfig server on `127.0.0.1` or `localhost` (kind, minikube, k3d) points at the container itself, so OmniKrux rewrites it to `host.docker.internal` and says so on the cluster's band.
- To use port-forwards, publish a port range as well. See [port-forwards](kubernetes.md#port-forwards).

### Linux specifics

- `~/.kube/config` is normally mode 0600, but the container runs as uid 10001 and cannot read it. OmniKrux logs a warning and starts without it. Either mount a readable copy:

  ```bash
  mkdir -p ~/.omnikrux-kube && install -m 644 ~/.kube/config ~/.omnikrux-kube/config
  docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway -v ~/.omnikrux-kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
  ```

  or run as your own user with a data directory you own:

  ```bash
  mkdir -p ~/.omnikrux-data
  docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway --user "$(id -u):$(id -g)" -v ~/.kube:/kube:ro -v ~/.omnikrux-data:/data omnikrux:dev
  ```

- kind publishes its API server on the host's `127.0.0.1`, which `host.docker.internal` cannot reach on Linux. Use the host network and turn the rewrite off:

  ```bash
  docker run --rm --network host -e OMNIKRUX_REWRITE_LOOPBACK=false -v ~/.omnikrux-kube:/kube:ro -v omnikrux-data:/data omnikrux:dev uvicorn omnikrux.main:app --host 127.0.0.1 --port 8080
  ```

## How clusters get in

On every start OmniKrux imports the contexts in `/kube/config`. A context that is no longer in the file is removed again, but only when every configured file was read; a missing or unreadable mount never removes clusters. You can also add a kubeconfig from Settings (see [Audit and Settings](audit-and-settings.md)) or connect a cloud account (see [Cloud accounts](cloud.md)).

If Home says "No clusters yet", the kubeconfig was not found at `/kube/config`. Check the `-v` mount and restart.

## First look around

The left rail has three apps:

| App | Key |
| --- | --- |
| Kubernetes | `Alt 1` |
| Audit | `Alt 8` |
| Settings | `Alt 9` |

Kubernetes opens on Home:

1. **Search.** Press `/` and type a pod, deployment, node or cluster name. `↑` `↓` choose a result and `Enter` opens it.
2. **Problems right now.** Connection problems and failing Pods across all clusters, with **Open cluster** to go and look.
3. **Clusters.** One live card per cluster. Open a card to browse its Pods.
4. **Discovered clusters.** Clusters found through connected cloud accounts.

From a cluster you can press `:` to jump to any kind, `Ctrl K` for the command palette, or `?` for every shortcut available on the current screen.

Next: [Kubernetes](kubernetes.md).

## Stopping and resetting

Press `Ctrl C` in the terminal that runs the container. Port-forwards stop with it, and a node shell that was never closed stops by itself after one hour (see [Kubernetes](kubernetes.md#logs-and-shells)).

Tabs and pinned kinds are saved in the browser, not on the server. Clearing this site's data in your browser resets them; it does not touch the clusters in the data volume.
