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

## Local development cluster

`bash scripts/dev-kind.sh` creates a kind cluster (`omnikrux-dev`) with demo workloads in the `demo` namespace.
