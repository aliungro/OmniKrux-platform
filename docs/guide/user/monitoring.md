# Monitoring

Monitoring is the second app in OmniKrux. It is in development, and this release covers the foundation: you describe what you run, connect the tools that hold its metrics and logs, and OmniKrux checks that it can reach them and query them safely. Dashboards, Explore and Alerts come in later updates.

Open it from the left rail, or press `Alt 2`.

## The ideas

- A **source** is one monitoring tool OmniKrux can ask questions: a Prometheus-compatible metrics service (Prometheus, Thanos, VictoriaMetrics and the like) or a Loki log service. OmniKrux only reads from it.
- A **project** is one thing you run, such as a cluster, a Docker host, some servers or anything of your own. It links to the sources that hold its data, and it only ever sees its own part of them.
- A **label filter** is how a project sees only its part of a source. It is a list of label matchers, for example `cluster="prod-east"` or `namespace="shop", team!="infra"`. OmniKrux adds the filter to every query a project makes, so one shared Prometheus or Loki can serve several projects without any of them seeing another's data. Two projects can use the same source with different filters.
- A **group** combines projects you pick, so you can look at them together. The projects stay where they are, and a project can be in several groups.

## Set up a project

Use **+** next to Projects in the sidebar, or **Set up a project** on Home. When no project exists yet, Home offers a button for each connected cluster that starts the setup for that cluster. The setup has four steps.

1. **What to monitor.** Choose **A Kubernetes cluster**, **A Docker host**, **Servers** or **Something of your own**. For a cluster, pick one of the clusters OmniKrux already knows. If none is connected, **Open Settings** takes you to where you add one.
2. **Sources.** For a cluster, OmniKrux looks inside it for Prometheus, Loki and Grafana and lists what it found. A tool shows as **Reachable** or **Missing**; Grafana only shows as **Found**, because importing its dashboards is not available yet. Tick the tools to use. A source you added earlier can be reused under **Use an existing source**. If nothing is found, or you want a tool that runs elsewhere, use **Add a source by hand**. **Look again** searches the cluster again.
3. **Import.** Marked "Comes later". Importing dashboards, and installing missing tools from here, arrive in a later update. OmniKrux connects to tools that already run.
4. **Name and review.** Give the project a name (leave it empty to keep the suggested one), check the summary of sources and their filters, and press **Create project**. The project, its new sources and all the links are created together, or not at all.

## Add a source by hand

Use **Add a source by hand** in the setup, or **Add a source** on the **Sources** page. Fill in:

- **Type**: Prometheus-compatible or Loki.
- **Address**: the tool's URL, for example `http://prometheus.example:9090`. Use `https://` for a tool with TLS. If the tool is served under a path prefix, include it.
- **Name**: optional. Left empty, OmniKrux names the source after its type and host.
- **Authentication**: how OmniKrux signs in.
  - **None**: no sign-in.
  - **Basic**: a **User name** and **Password**.
  - **Bearer token**: a **Token**, sent as an `Authorization: Bearer` header.
  - **API key header**: a **Header name** (for example `X-API-Key`) and the **Key**.
  - **Client certificate (mTLS)**: a **Client certificate (PEM)** and a **Client key (PEM)**.
- **Custom headers**: extra headers sent with every request. Use **Add header** (up to 20) and **Remove**. Header values are treated as secrets.
- **CA certificate (PEM, optional)**: trust a private certificate authority for an `https://` address.

**Test connection** asks the tool a simple question and reports what it answered, including its version. **Save source** stores it (in setup, the button is **Use this source** and the source is stored with the project).

Passwords, tokens, keys and header values are stored encrypted and are never shown again. When you edit a source, a saved secret shows "Saved. Leave empty to keep it."; leave the field empty to keep it, or type a new value to replace it. A source's type and how it is reached can't change after it is saved; add a new source instead. A source found inside a cluster is reached through that cluster's connection, so its address and sign-in aren't edited here.

## Label filters

Each link between a project and a source has a filter. On the project's page, every source has a **Filter** field. Edit it and press **Save filter**; the page confirms with "Filter saved." and the next query uses it.

- Write matchers like `cluster="prod-east"`, separated by commas. The operators are `=`, `!=`, `=~` and `!~`, and braces around the whole filter are optional. An empty filter means no filter: the project sees everything on that source. A filter can't select by metric name.
- For a Kubernetes project, OmniKrux fills in the filter when it can tell one is needed. It looks at the labels that usually name a cluster (`cluster`, `cluster_name`, `k8s_cluster_name`, `kubernetes_cluster`). When one has several values and one of them is this cluster's name, the filter keeps that value, and the field says why. A source that runs inside the cluster holds only its data and needs no filter. If a source holds several clusters and none is named like yours, the filter stays empty and OmniKrux asks you to set it.
- An automatic filter is only a suggestion. You can change it at any time, and your change is kept.
- Projects of other kinds start with no filter.

**Check data** on a source in a project page reports how many metrics and labels the project can see through its filter (for a Loki source, how many labels). Use it to confirm that a filter keeps what you expect.

## Groups and shortcuts

Use **+** next to Groups in the sidebar to make a **New group**: give it a name and pick its projects. On a group's page, **Edit projects** changes its members and **Delete group…** removes the group; its projects stay as they are.

In the sidebar a group lists its projects as shortcuts (**Go to project …**), so a project that is in a group is one click away from either place. Home lists **Recently opened** projects and groups, and its search finds projects, groups and sources.

**Explore** and **Alerts** in the sidebar, and the **Dashboards** section of a project or group, tell you they arrive in a later update. Nothing in Monitoring evaluates rules or sends notifications yet.

## Rename, unlink and delete

- Use **Rename** beside a project's or group's name to change it.
- **Unlink** removes a project's link to a source. The source stays on the Sources page.
- On the Sources page, each source has **Test**, **Edit** and **Delete**.

Deleting always shows a review first, and nothing is removed until you confirm.

- **Delete project…** lists the sources it created that go with it, the sources it created that other projects still use (these stay), the other sources that are only unlinked, and the groups it leaves. If something changes while the review is open, OmniKrux asks you to review again and changes nothing.
- **Delete source** lists the projects that lose it.
- **Delete group** says that its projects stay as they are.

A source a project did not create, or that another project still uses, is never removed together with a project.

## Audit

Every change in Monitoring is written to the Audit log, marked as coming from Monitoring: **Added a source**, **Changed a source**, **Removed a source**, and the same for projects and groups. An entry names what changed and whether it succeeded. Details never include secrets: an entry says which kind of sign-in a source uses, not the password or token. Reading is not audited: testing a source, opening a project or running a query leaves no entry.

## What comes in later updates

- Dashboards for projects and groups, and importing existing Grafana dashboards.
- Explore: query as you type and browse metrics and logs.
- Alerts: rules, evaluation and notifications.
- Installing monitoring tools from OmniKrux, and discovery for Docker hosts and servers.
