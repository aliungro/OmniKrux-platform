# OmniKrux guides

OmniKrux is a local infrastructure console: a FastAPI backend and a React frontend, shipped as one Docker image. Today it has two apps, Kubernetes and Monitoring (in development), plus the shared Audit and Settings pages.

These guides describe what the code does now. The [project README](../../README.md) stays the full reference for run options, environment variables and troubleshooting notes.

## For people using OmniKrux

| Guide | Read it to |
| --- | --- |
| [Getting started](user/getting-started.md) | Run the image, mount a kubeconfig, open the console and look around. |
| [Kubernetes](user/kubernetes.md) | Browse clusters and kinds, read details, logs and shells, change things safely, forward ports, use tabs and shortcuts. |
| [Cloud accounts and clusters](user/cloud.md) | Connect Azure, AWS, Google Cloud or Oracle Cloud and add the clusters OmniKrux finds. |
| [Monitoring](user/monitoring.md) | Set up projects, sources and groups, query them through OmniKrux, build dashboards, explore metrics and logs, get alerts, install the tools a project is missing, and import and export dashboards, also from Grafana. |
| [Audit and Settings](user/audit-and-settings.md) | Read the audit log, manage pinned kinds, clusters and accounts. |

## For people working on OmniKrux

| Guide | Read it to |
| --- | --- |
| [Setup](developer/setup.md) | Install the tools, run the backend and frontend, create the kind dev cluster. |
| [Testing](developer/testing.md) | Run the exact gates before you commit. |
| [Architecture](developer/architecture.md) | Find your way around the code; see how a change is applied and how a new app joins the rail. |
| [Monitoring](developer/monitoring.md) | Find your way around the Monitoring code, its connectors, the catalog, the dashboard document, Explore, the alert engine, installing the tools and the install pins, the export format, and its tests. |
| [Releasing](developer/releasing.md) | Build the image, tag a version and push. |

## Conventions

- The product name is written OmniKrux in text. Code identifiers, packages, environment variables, volumes and image names are lower case (`omnikrux`, `OMNIKRUX_*`).
- Keys are written the way the console draws them: `Alt 1`, `Ctrl K`, `Shift L`. On macOS `Ctrl Enter` is `⌘ Enter` and `Ctrl Del` is `⌘ ⌫`.
