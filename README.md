# Omnikrux

Web console for Kubernetes and multicloud infrastructure, shipped as a single Docker image.

## Run

Build the image:

```bash
docker build -t omnikrux:dev .
```

Linux / macOS:

```bash
docker run --rm -p 8080:8080 --add-host=host.docker.internal:host-gateway \
  -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

Windows PowerShell: the same command with `-v ${env:USERPROFILE}\.kube:/kube:ro`.

Open http://localhost:8080.

Host port 8080 already in use? Pick another host port, for example `-p 8090:8080`, and open http://localhost:8090.

The kubeconfig is read from `/kube/config` inside the container. Cluster state is kept in the `omnikrux-data` volume, so restarts keep the same clusters.

### Linux: kubeconfig permissions

The container runs as uid 10001, but `~/.kube/config` is normally mode 0600 and owned by you, so the command above fails with "permission denied" on Linux (Docker Desktop on Windows and macOS hides this). Omnikrux logs a warning naming the unreadable file and keeps starting without it. Pick one:

- Mount a readable copy (recommended):

  ```bash
  mkdir -p ~/.omnikrux-kube && install -m 644 ~/.kube/config ~/.omnikrux-kube/config
  docker run --rm -p 8080:8080 --add-host=host.docker.internal:host-gateway     -v ~/.omnikrux-kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
  ```

- Run as your own user. A fresh named volume is owned by uid 10001 and is not writable for another user, so use a data directory you own instead of `omnikrux-data`:

  ```bash
  mkdir -p ~/.omnikrux-data
  docker run --rm -p 8080:8080 --add-host=host.docker.internal:host-gateway     --user "$(id -u):$(id -g)" -v ~/.kube:/kube:ro -v ~/.omnikrux-data:/data omnikrux:dev
  ```

## Local development cluster

`bash scripts/dev-kind.sh` creates a kind cluster (`omnikrux-dev`) with demo workloads in the `demo` namespace.
