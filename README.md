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

## Local development cluster

`bash scripts/dev-kind.sh` creates a kind cluster (`omnikrux-dev`) with demo workloads in the `demo` namespace.
