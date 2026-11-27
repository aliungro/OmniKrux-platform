<p align="center">
  <img src="docs/assets/omnikrux-banner.svg" alt="OmniKrux: one place for everything" width="100%">
</p>

OmniKrux is a web console for your infrastructure that runs on your own machine as one Docker image. Point it at your kubeconfig and cloud logins, and it shows every cluster in one place: what is running, what is failing, its logs and metrics, and safe ways to change it.

> **Early alpha.** OmniKrux has no login yet, so run it on your own machine only (the commands below keep it on `127.0.0.1`).

## What it does

| App | What you get |
| --- | --- |
| **Kubernetes** | Every cluster and every kind, custom resources included. Live logs, shells, port-forwards, CPU and memory. Changes (edit, scale, restart, roll back, drain, delete) are shown as a diff first and run only after you confirm. |
| **Monitoring** | Connects to the Prometheus and Loki you already run. Ready-made views, your own dashboards, Explore for metrics and logs, and alerts. Imports dashboards from a file or straight from Grafana. |
| **Cloud accounts** | Connects Azure, AWS, Google Cloud and Oracle Cloud and finds their Kubernetes clusters for you. |
| **Audit** | A record of every change, shell and secret reveal, with how it ended. |

Everything works from the keyboard: `Ctrl K` opens commands, `:` jumps to a kind, `?` lists every shortcut.

## Quick start

You need Docker and a kubeconfig (usually `~/.kube/config`).

**1. Build the image**

```bash
docker build -t omnikrux:dev .
```

**2. Run it**

Linux and macOS:

```bash
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway \
  -v ~/.kube:/kube:ro -v omnikrux-data:/data omnikrux:dev
```

Windows PowerShell:

```powershell
docker run --rm -p 127.0.0.1:8080:8080 --add-host=host.docker.internal:host-gateway `
  -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data omnikrux:dev
```

**3. Open http://localhost:8080**

Your clusters appear on Home. The `omnikrux-data` volume keeps your clusters, settings and audit log between runs.

## Good to know

- **Port 8080 taken?** Use another host port, for example `-p 127.0.0.1:8090:8080`.
- **On Linux** the container cannot read a private `~/.kube/config`, and kind clusters need the host network. [Getting started](docs/guide/user/getting-started.md#linux-specifics) has the commands.
- **Port-forwards** need a port range published as well. See [Port-forwards](docs/guide/user/kubernetes.md#port-forwards).
- **Cloud logins** are mounted read-only, or entered in Settings and stored encrypted. See [Cloud accounts](docs/guide/user/cloud.md).
- **Secrets** stay masked until you reveal a single key, and each reveal is written to Audit.

## Documentation

| Guide | Read it to |
| --- | --- |
| [Getting started](docs/guide/user/getting-started.md) | Run OmniKrux, connect your clusters and look around. |
| [Kubernetes](docs/guide/user/kubernetes.md) | Browse, troubleshoot and change things safely. |
| [Monitoring](docs/guide/user/monitoring.md) | Set up projects and sources, build dashboards, explore, alert, import from Grafana. |
| [Cloud accounts](docs/guide/user/cloud.md) | Connect Azure, AWS, Google Cloud or Oracle Cloud. |
| [Audit and Settings](docs/guide/user/audit-and-settings.md) | Read the audit log and manage clusters, accounts and preferences. |

Working on the code? Start with [developer setup](docs/guide/developer/setup.md), then [testing](docs/guide/developer/testing.md) and [architecture](docs/guide/developer/architecture.md). All guides are listed in [docs/guide](docs/guide/README.md).

## Built with

FastAPI and Python on the backend, React and TypeScript on the frontend, shipped together as one Docker image.

## Status

OmniKrux is in early alpha and changes quickly. Each app has its own versions: see the [tags](https://github.com/aliungro/OmniKrux-platform/tags).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it explains how changes are reviewed and the [Contributor License Agreement](CLA.md) you sign on your first pull request.

## Security

Please report security problems privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.

## License

OmniKrux is free and open source under the [GNU Affero General Public License v3.0](LICENSE). You can use it, run it for your company and change it. If you offer a modified version to others, including as a hosted service, you must share your changes under the same license.

Need a commercial license without these terms? Open an issue and ask.
