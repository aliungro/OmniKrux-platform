# Monitoring

Monitoring is the second app in OmniKrux. It is in development. So far you can describe what you run, connect the tools that hold its metrics and logs, have OmniKrux check that it can reach them and query them safely, and build dashboards on top of that. Explore and Alerts come in later updates.

Open it from the left rail, or press `Alt 2`.

## The ideas

- A **source** is one monitoring tool OmniKrux can ask questions: a Prometheus-compatible metrics service (Prometheus, Thanos, VictoriaMetrics and the like) or a Loki log service. OmniKrux only reads from it.
- A **project** is one thing you run, such as a cluster, a Docker host, some servers or anything of your own. It links to the sources that hold its data, and it only ever sees its own part of them.
- A **label filter** is how a project sees only its part of a source. It is a list of label matchers, for example `cluster="prod-east"` or `namespace="shop", team!="infra"`. OmniKrux adds the filter to every query a project makes, so one shared Prometheus or Loki can serve several projects without any of them seeing another's data. Two projects can use the same source with different filters.
- A **group** combines projects you pick, so you can look at them together. The projects stay where they are, and a project can be in several groups.
- A **dashboard** is a page of panels that run queries against a project's sources (or, for a group, against each of its projects). Every dashboard belongs to one project or one group, and its title is unique among that owner's dashboards. Dashboards are described in [Dashboards](#dashboards) below.

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

**Check data** on a source in a project page reports how many metrics and labels the project can see through its filter (for a Loki source, how many labels). Use it to confirm that a filter keeps what you expect. The count belongs to the saved filter: it goes away when you edit or save the filter, so check again afterwards.

## Groups and shortcuts

Use **+** next to Groups in the sidebar to make a **New group**: give it a name and pick its projects. On a group's page, **Edit projects** changes its members and **Delete group…** removes the group; its projects stay as they are.

In the sidebar a group lists its projects as shortcuts (**Go to project …**), so a project that is in a group is one click away from either place. Home lists **Recently opened** projects and groups, and its search finds projects, groups and sources.

**Explore** and **Alerts** in the sidebar tell you they arrive in a later update. Nothing in Monitoring evaluates rules or sends notifications yet.

## Dashboards

A dashboard is a grid of panels. Each panel runs one or more queries and draws the answer as a chart, a number, a table or log lines. A dashboard belongs to one **project** or one **group**; the owner's page lists its dashboards under **Dashboards**, and the sidebar lists them under their owner. Every query a dashboard makes goes through its project's label filter, so a project's dashboards only ever show that project's data.

### Open one and read it

Open a dashboard from its owner's page, from the sidebar, or by finding it with **/** (Find). Hold Ctrl or Cmd while you open it to use a new tab.

The header shows the owner, the title, the views (**Dashboard**, **JSON** and **Versions**), the time range, the refresh controls and **Edit**.

- **Time range.** The time button shows the range in use. It offers the presets from **Last 5 minutes** to **Last 7 days**, and **Custom range…**, where **From** and **To** take `now`, `now-6h`-style offsets (units `s`, `m`, `h`, `d`, `w`) or a UTC time such as `2026-11-19T10:00:00Z`. **To** has to be after **From**.
- **Refresh.** The refresh button (or `r`) reads everything again. **Auto-refresh** re-reads every 10 s, 30 s, 1 min, 5 min, 15 min or 1 h, or is **Off**. It only runs while the page is visible, and each refresh moves the window to the new "now".
- **Updated.** Under the header, **Updated** and a clock time says when the data was last read. It shows the oldest read among the panels, and **Updating…** while any panel is loading.

The time range, auto-refresh, the variables and the open view belong to the workspace tab you are in. Changing them does not change the saved dashboard; its own starting range and refresh are part of its JSON.

### Variables and the Projects dropdown

A dashboard can have variables, shown as buttons under the header such as **Namespace: All**. A variable's values are read from its source (through the project's filter) for the time range in use. Open one to choose a value, or several when it allows it (**All** is there when the variable includes it). With more than ten values a **Filter values** box appears. A variable can depend on the ones before it, for example a Pod list that follows the chosen namespaces. A value chosen earlier that no longer exists shows as "(not found)" until you change it.

If a variable's values can't be read, the list says why. **Try again** appears when the read failed, and **Link one on …'s page** when the project has no source of that type.

On a group dashboard the first button is **Projects**. It chooses which of the group's projects the dashboard shows. Every panel runs each of its queries once per chosen project, and its series are named with the project in front (for example `Shop · web`). A project that lacks the source a query needs fails on its own: the panel is marked **Partial** and says which project it is.

Variables are placed in a query with care. OmniKrux escapes a value for the quotes it lands in, so a value can't break out of the query. Where a value can't be placed safely (a variable written outside any quotes, holding anything other than a plain word), the panel shows **Query error** and asks you to put the variable in double quotes in the query. Inside double quotes any value is fine.

### What a panel says

- **Loading…** until its queries first answer. Later runs (a refresh, another time range or variable value) keep the chart until the new answer arrives, and the **Updating…** line above says data is being read.
- **This panel has no query yet.** when no query has text.
- **No data in this time range.** when the queries answered with nothing.
- **Partial** (a mark in the panel's header; hover or focus it for the reasons) when some queries failed, were skipped, or an answer was cut short. The rest is drawn and the reasons say what is missing. A failure is never shown as "no data".
- **Source unreachable** when every query failed because the tool did not answer (it is down, refused the sign-in, timed out or answered with an error of its own). **Try again** runs the panel's queries once more.
- **Query error** when every query was refused, for example a query the tool can't parse, a variable that can't be placed, or a source that is no longer linked. The reason is the tool's or OmniKrux's own words. A panel using a variable whose values couldn't be read, with nothing chosen, doesn't run at all: it says "$name couldn't load its values. Its menu above says why."

A panel's **ⓘ** shows its description when it has one. A failed panel draws no chart; it never shows the answer from an earlier run as if it were current.

If the dashboard itself can't be read again (for example when you come back to the window and the server doesn't answer), the page stays as it was, edits included, and says "Couldn't read this dashboard again, so it shows as last read." with the reason and **Try again**.

The panel types are **Time series** (**Lines**, **Area** or **Stacked**), **Stat**, **Gauge**, **Bar**, **Table** (click a column header to sort it) and **Logs** (one Loki query; press Enter on a line to show its labels).

### Edit a dashboard

Press **Edit** (or `e`). The header then says **Editing** and shows **Discard** and **Save dashboard**. Nothing is saved until you press **Save dashboard** (or Ctrl S, which works inside fields too). A save with no changes writes nothing: it just ends editing.

- **Add:** the dashed **Add panel** tile (or `a`) adds a time series panel in the first free spot.
- **Move and resize with the mouse:** drag a panel by its **⋮⋮** handle, and resize it from its corner. Other panels move out of the way, and Esc cancels a drag in progress.
- **Move and resize with the keys:** click a panel, or Tab to one. The arrow keys move between panels. Shift with an arrow moves the panel one step, and Ctrl Shift with an arrow makes it narrower, wider, shorter or taller. A message announces each change.
- **Remove:** Ctrl Del (Cmd Backspace on a Mac) removes the panel from the draft. **Discard** brings it back.
- **Settings:** click a panel or press Enter to open **Panel settings** beside the grid. Esc closes them; the next Esc goes to **Save dashboard**.

The settings have four tabs.

- **Query.** **Source** says where the queries run: on a project dashboard the project's first Prometheus-compatible or Loki source, or one specific linked source; on a group dashboard each project's own. Each query is code with a **Legend** (for example `{{pod}}`) and a **Hide** checkbox; **+ Add query** adds up to ten, and a logs panel has exactly one. A run follows 300 ms after you stop typing, or at once with Ctrl Enter. The line under the queries says what the last run returned: series, points and how long it took.
- **Chart.** The **Chart type** tiles, and what the type offers: **Style** for a time series, **Show** (last, mean, max, min or sum) and **Sparkline** for a stat, **Show** for a gauge, **Direction** for a bar, **Columns** for a table, and **Lines**, **Wrap long lines** and **Order** for logs. Changing the type keeps the queries, the title and the size.
- **Options.** **Title**, **Description**, **Unit**, **Decimals**, **Min** and **Max**, **Thresholds** (each a value and **Good**, **Warning** or **Bad**) and **Legend**, as each type offers them.
- **Alert.** Says alerts arrive in a later update, together with the Alerts page.

Charts redraw as you edit. A panel whose query you change morphs to the new data, a stat counts to its new number, and an edited panel's frame is highlighted briefly. If your system asks for reduced motion, none of that animates: charts jump, numbers change at once and nothing is highlighted.

### Drafts

While you edit, OmniKrux keeps your unsaved changes as a draft in this browser: half a second after each change, and straight away when the page is hidden or goes away. The draft is removed when you save or discard.

- Open the dashboard again (after a reload, after browser Back, or after **Keep draft and leave**) and a banner says "You have unsaved changes from …". **Restore draft** goes on editing from it, and **Discard draft** drops it. If the dashboard was saved again meanwhile, the banner says so, and saving your draft is then reviewed first (see below).
- Closing a tab, or going elsewhere in it, with unsaved changes (JSON text that doesn't apply yet counts too) asks **Leave "…" with unsaved changes?** with **Stay**, **Discard changes** and **Keep draft and leave**. The browser's own Back button is never held back, and neither is a reload while this browser keeps drafts: both rely on the draft. When the browser can't keep drafts, a reload or closing the window with unsaved changes makes the browser ask first (see below).
- Only one edit session per dashboard runs in a browser window. Pressing **Edit** while another tab is editing it says "This dashboard is being edited in another tab." with **Go to that tab**.
- If the same dashboard is edited in two browser windows, only one draft is stored: the one changed last wins.
- If this browser blocks storage, the edit bar says "This browser isn't keeping drafts, so a reload loses unsaved changes." and the browser asks before a reload or close that would lose them. Leaving through OmniKrux then says "This browser can't keep drafts, so leaving loses these changes."

### The JSON tab and Review changes

The **JSON** tab shows the dashboard as its document, and you can type in it. Typing applies after a short pause. While the JSON is valid the bar says "✓ Valid · applied live". When it has a problem the bar says what and where, "the dashboard keeps the last valid version", and **N more problems** lists the rest.

While the JSON text doesn't apply, **Save dashboard** is refused ("The JSON has a problem. Fix it or discard it before saving."), and so are edits in the grid and in **Panel settings** ("Fix the JSON first, or discard it."), because applying them would silently throw the text away. Fix the JSON, or press **Discard**.

**Review changes** (Ctrl Enter in the editor) shows the saved version beside your changes and saves from there. If someone saved the dashboard in the meantime, the save is refused with "This dashboard was saved somewhere else since you started (version N). Review the differences before saving." **Review differences** shows both, **Save over it** saves your draft on top, and **Keep editing** goes back.

A ready-made view's JSON is **Read-only**, with **Copy to edit** beside it.

### Versions

Every save makes a new version, and nothing is overwritten. The **Versions** tab lists them, newest first, marking the **Current** one and saying how each came about: **Created**, **Copied from …**, a save, or **Restored from version N**.

Tick two versions and press **Compare** to see what changed, or use **Compare with current** on one. **Restore…** asks first, then saves a new version with what the old one had; no version is deleted. Restoring is refused ("Save or discard your draft before restoring a version.") while the dashboard has a draft or is being edited.

### Ready-made views

A project with a Prometheus-compatible source gets ready-made views, listed under **Ready-made views** on its page. A Kubernetes project gets **Cluster health**, **Node health**, **Namespace health**, **Workload health** and **Pod health**; other kinds of project get **Node health**. They are generated from what the project's Prometheus holds, tagged **Ready-made**, and can't be changed or deleted.

Each says what its Prometheus lacks and what that leaves empty: kube-state-metrics, container usage from the kubelet (cAdvisor) or node-exporter. If OmniKrux can't read the metric names to tell, it says why and doesn't guess. Node health needs node-exporter; where it isn't running the view still opens, with a note.

**Copy to edit** (on the project's page, in the view's header, or on its **JSON** tab) copies the view into the project and opens the copy in edit mode. The copy is a normal dashboard with the view's title, without "(copy)". If the project already has a dashboard with that title, a number is added, for example "Pod health (2)".

### Create, copy and delete

- **New dashboard** is in the sidebar (also `N`, from anywhere in Monitoring) and on every project and group page. The **+** beside a project or group in the sidebar starts one for that owner. The dialog asks for a **Title** and **Goes to**, a project or a group, and **Create dashboard** opens the new, empty dashboard in edit mode with the keyboard on **Add panel**. A group dashboard runs each panel once per project in the group. The sidebar footer says where a new dashboard goes, and the button stays off until a project exists.
- **Copy dashboard…** is in the **More actions** menu (**⋯**). It makes a new dashboard with the same panels for any project or group. The dialog suggests "… (copy)" as the title; whatever title you give must be unused by that owner. Sources the new owner doesn't have are set to its own first source of that type.
- **Delete dashboard…** is in the same menu, and shows a review first: how many saved versions go with it, and your unsaved draft in this browser if there is one. If the dashboard was saved since you opened the review, it asks you to review again. If it was already deleted elsewhere, the delete simply goes through.
- When the tab you create or copy from holds unsaved edits, the new dashboard opens in a new tab, so those edits aren't left with a question.
- Deleting a project or a group deletes its dashboards and their versions with it; the review lists them first.

### Keyboard

These are the keys listed under **Monitoring** and **Dashboards** in the **?** sheet. Letters work only when you aren't typing in a field.

| Key | What it does |
| --- | --- |
| `/` | Find a project, group or source |
| `↑ ↓`, `← →`, `Enter` | In the sidebar: move, close or open a group, open the item |
| `N` | New dashboard |
| `e` | Edit the dashboard |
| `1`, `2`, `3` | Dashboard, JSON or Versions |
| `t` | Pick the time range |
| `r` | Refresh now |
| `Ctrl S` (`⌘ S`) | While editing, in fields too: save the dashboard |
| `← → ↑ ↓` | While editing: move between panels |
| `Shift` + arrows | While editing: move the panel one step |
| `Ctrl Shift` + arrows (`⌘ Shift`) | While editing: make the panel narrower, wider, shorter or taller |
| `Enter` | While editing: open the panel's settings |
| `a` | While editing: add a panel |
| `Ctrl Del` (`⌘ ⌫`) | While editing: remove the panel from the draft |
| `Esc` | Close the panel's settings, then go to **Save dashboard** |
| `Ctrl Enter` (`⌘ Enter`) | In a query: run it now. In the JSON: review the changes |
| `← →` | On a chart: move the crosshair; Esc hides it |
| `Enter` | On a table column: sort by it. On a log line: show its labels |

## Rename, unlink and delete

- Use **Rename** beside a project's or group's name to change it.
- **Unlink** removes a project's link to a source. The source stays on the Sources page.
- On the Sources page, each source has **Test**, **Edit** and **Delete**.

Deleting always shows a review first, and nothing is removed until you confirm.

- **Delete project…** lists the dashboards that go with it (each with its number of saved versions), the sources it created that go with it, the sources it created that other projects still use (these stay), the other sources that are only unlinked, and the groups it leaves. If something changes while the review is open, OmniKrux asks you to review again and changes nothing.
- **Delete source** lists the projects that lose it.
- **Delete group** says that its projects stay as they are, and names the group's dashboards, which go with it.

A source a project did not create, or that another project still uses, is never removed together with a project.

## Audit

Every change in Monitoring is written to the Audit log, marked as coming from Monitoring: **Added a source**, **Changed a source**, **Removed a source**, and the same for projects and groups. For dashboards the entries are **Added a dashboard** (a new one or a copy), **Saved a dashboard**, **Restored a dashboard version** and **Removed a dashboard**. An entry names what changed and whether it succeeded. A dashboard's entries say who owns it, which versions are involved and how many panels it has, never its queries. Details never include secrets: an entry says which kind of sign-in a source uses, not the password or token. Reading is not audited: testing a source, opening a project or running a query leaves no entry.

## What comes in later updates

- Importing existing Grafana dashboards, and alerts on a panel (the **Alert** tab says so).
- Explore: query as you type and browse metrics and logs.
- Alerts: rules, evaluation and notifications.
- Installing monitoring tools from OmniKrux, and discovery for Docker hosts and servers.
