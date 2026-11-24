# Monitoring

Monitoring is the second app in OmniKrux. It is in development. So far you can describe what you run, connect the tools that hold its metrics and logs, have OmniKrux check that it can reach them and query them safely, build dashboards on top of that, ask one-off questions of your metrics and logs in Explore, get alerts when something crosses a line, and install the tools a project is missing.

Open it from the left rail, or press `Alt 2`.

## The ideas

- A **source** is one monitoring tool OmniKrux can ask questions: a Prometheus-compatible metrics service (Prometheus, Thanos, VictoriaMetrics and the like) or a Loki log service. OmniKrux only reads from it.
- A **project** is one thing you run, such as a cluster, a Docker host, some servers or anything of your own. It links to the sources that hold its data, and it only ever sees its own part of them.
- A **label filter** is how a project sees only its part of a source. It is a list of label matchers, for example `cluster="prod-east"` or `namespace="shop", team!="infra"`. OmniKrux adds the filter to every query a project makes, so one shared Prometheus or Loki can serve several projects without any of them seeing another's data. Two projects can use the same source with different filters.
- A **group** combines projects you pick, so you can look at them together. The projects stay where they are, and a project can be in several groups.
- An **alert rule** watches a query and tells you when it crosses a line. See [Alerts](#alerts).
- A **dashboard** is a page of panels that run queries against a project's sources (or, for a group, against each of its projects). Every dashboard belongs to one project or one group, and its title is unique among that owner's dashboards. Dashboards are described in [Dashboards](#dashboards) below.

## Set up a project

Use **+** next to Projects in the sidebar, or **Set up a project** on Home. When no project exists yet, Home offers a button for each connected cluster that starts the setup for that cluster. The setup has four steps.

1. **What to monitor.** Choose **A Kubernetes cluster**, **A Docker host**, **Servers** or **Something of your own**. For a cluster, pick one of the clusters OmniKrux already knows. If none is connected, **Open Settings** takes you to where you add one.
2. **Sources.** For a cluster, OmniKrux looks inside it for Prometheus, Loki and Grafana and lists what it found. A tool shows as **Reachable** or **Missing**; Grafana only shows as **Found**, because importing its dashboards is not available yet. A tool OmniKrux installed carries **Installed by OmniKrux** and a **Monitoring tools** link. Tick the tools to use. A missing Prometheus or Loki has an **Install Prometheus…** or **Install Loki…** button: press it to install that tool once the project is created (the row then says **To install**; see [Installing the tools](#installing-the-tools)). Where OmniKrux can't install, the row says why ("Installing isn't available here: …"). A source you added earlier can be reused under **Use an existing source**. If nothing is found, or you want a tool that runs elsewhere, use **Add a source by hand**. **Look again** searches the cluster again. For **A Docker host** or **Servers**, this step can also write the files that run the tools there (see [Docker hosts and servers](#docker-hosts-and-servers)).
3. **Import.** Marked "Comes later". Importing dashboards arrives in a later update.
4. **Name and review.** Give the project a name (leave it empty to keep the suggested one), check the summary of sources, their filters and what will be installed, and press **Create project** (**Create project and review the install** when you asked for an install). The project, its new sources and all the links are created together, or not at all. The install review opens right after; nothing is installed until you confirm it there.

A setup you leave half way is kept in that Monitoring tab and comes back when you open setup there again, until you create the project or close the tab. Passwords, tokens and header values are never kept: a source that needed one comes back **Not in use**, with **Enter it again**.

## Add a source by hand

Use **Add a source by hand** in the setup, or **Add a source** on the **Sources** page. Fill in:

- **Type**: Prometheus-compatible, Loki or Alertmanager (see [Alertmanager sources and channels](#alertmanager-sources-and-channels)).
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

**Explore** in the sidebar opens [Explore](#explore). **Alerts** opens the [Alerts](#alerts) page.

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

- **Add:** the dashed **Add panel** tile (or `a`) opens a search where you type what you want to see; see [Adding panels](#adding-panels).
- **Move and resize with the mouse:** drag a panel by its **⋮⋮** handle, and resize it from its corner. Other panels move out of the way, and Esc cancels a drag in progress.
- **Move and resize with the keys:** click a panel, or Tab to one. The arrow keys move between panels. Shift with an arrow moves the panel one step, and Ctrl Shift with an arrow makes it narrower, wider, shorter or taller. A message announces each change.
- **Remove:** Ctrl Del (Cmd Backspace on a Mac) removes the panel from the draft. **Discard** brings it back.
- **Settings:** click a panel or press Enter to open **Panel settings** beside the grid. Esc closes them; the next Esc goes to **Save dashboard**.

At the top of the settings a one-line recommendation can appear (see [Recommendations](#recommendations)). Below it are four tabs.

- **Query.** **Source** says where the queries run: on a project dashboard the project's first Prometheus-compatible or Loki source, or one specific linked source; on a group dashboard each project's own. Each query is code with a **Legend** (for example `{{pod}}`) and a **Hide** checkbox; **+ Add query** adds up to ten, and a logs panel has exactly one. A run follows 300 ms after you stop typing, or at once with Ctrl Enter. The line under the queries says what the last run returned: series, points and how long it took.
- **Chart.** The **Chart type** tiles, and what the type offers: **Style** for a time series, **Show** (last, mean, max, min or sum) and **Sparkline** for a stat, **Show** for a gauge, **Direction** for a bar, **Columns** for a table, and **Lines**, **Wrap long lines** and **Order** for logs. Changing the type keeps the queries, the title and the size.
- **Options.** **Title**, **Description**, **Unit**, **Decimals**, **Min** and **Max**, **Thresholds** (each a value and **Good**, **Warning** or **Bad**) and **Legend**, as each type offers them.
- **Alert.** The panel's alert, if it has one; see [An alert on a panel](#an-alert-on-a-panel).

Charts redraw as you edit. A panel whose query you change morphs to the new data, a stat counts to its new number, and an edited panel's frame is highlighted briefly. If your system asks for reduced motion, none of that animates: charts jump, numbers change at once and nothing is highlighted.

### Adding panels

**Add panel** (the dashed tile, or `a`) opens a search over what the owner's sources hold. Type plain words, such as `errors by route`, `p99 latency`, `crashes` or `api logs`, and the matching panels are listed as cards, best first, up to six.

- **What it matches.** The words are matched against metric names, their help text and their labels, and against log label values. Filler words ("show me the") are ignored. Related words count as the same thing, so `errors`, `failures` and `5xx` find alike, as do `latency` and `duration`, `restarts` and `crashes`, or `logs` and `lines`. `by route` splits a panel by that label, and `p50`, `p90`, `p95` or `p99` picks a latency percentile. It is fixed rules over names, help text and labels: no AI and no paid service is involved, and your words are never sent anywhere.
- **What it writes.** A counter is shown as a rate per second, a histogram as a percentile and a gauge as it is. An error card for a request counter keeps the 5xx status codes, using the label that holds the status. Each card names its metric and kind, so you can see what it will run.
- **Previews.** The first few cards draw a small live preview of their query, run through the owner's label filter. Looking at a preview saves nothing.
- **Keys.** The keyboard stays in the field. `↑` and `↓` move the highlight, **Enter** adds the highlighted card (the first one until you move), and `Ctrl End` jumps to **Empty panel**. **Esc** clears the text, and a second **Esc** closes the search. With no text, it lists the suggestions for this owner.
- **Empty panel.** Always the last entry: a blank time series that you fill in yourself ("Write the query yourself.").
- **Refresh list.** The list of known metrics and log labels is read from the sources and kept for a few minutes, so a metric that appeared a minute ago may not be there yet. The footer says how old it is ("Known metrics from 2 min ago"). **Refresh list** reads the sources again. If reading fails, **Try again** does the same.

A card adds a panel to your draft like any other edit, so **Discard** takes it back.

### Suggestions on a new dashboard

When you start editing a dashboard that has no panels (a new one, or one you emptied), a rail beside the grid offers up to eight ready-made panels, headed "Suggested for _name_ · from what Prometheus and Loki have". It offers only what the sources hold: a request rate, an error rate, a p95 latency, pod restarts, CPU and memory by pod, node CPU busy, targets that are down, log volume (by level when there is a level label) and error log lines. Each card shows a live preview.

- Pick a card with the mouse or Enter. It flies to its place in the grid and the card reads **Added**. The keyboard stays in the rail on the next suggestion, so a dashboard can be built with Enter alone.
- `s` moves to the first suggestion not yet added.
- **Hide suggestions** closes the rail for this edit. Esc on a suggestion goes back to **Add panel**.
- When nothing in the sources fits, the rail says so and points to **Add panel**.

### Recommendations

In a panel's settings, and in Explore under the query, one recommendation at a time can appear, with a light bulb, an **Apply** button and a dismiss button (**✕**). There are three kinds:

- **A raw counter.** "… is a counter, so its raw value only goes up. Show it per second?" **Apply** wraps the query in a rate.
- **A noisy line.** When a line is jagged at its window, it suggests a wider window (at least five minutes, or four steps). **Apply** widens it.
- **Several rates.** Two to ten rates read better stacked. **Apply** changes the style to stacked area.

**Apply** is a normal edit of the draft, and **Discard** undoes it. If you changed the query since the suggestion was made, it says "That query changed. Review it and try again." and changes nothing. A dismissed recommendation does not come back for that dashboard (or, in Explore, for that project). Dismissals are kept in this browser only. On the Alert tab, a recommendation suggests a calmer threshold when the alert would have fired often.

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
| `a` | While editing: add a panel (type what you want to see) |
| `Ctrl Del` (`⌘ ⌫`) | While editing: remove the panel from the draft |
| `Esc` | Close the panel's settings, then go to **Save dashboard** |
| `↑ ↓`, `Enter` | In Add panel: pick a result and add it (`Ctrl End`: Empty panel; Esc clears, then closes) |
| `s` | While editing a new dashboard: go to the suggestions |
| `Ctrl Enter` (`⌘ Enter`) | In a query: run it now. In the JSON: review the changes |
| `← →` | On a chart: move the crosshair; Esc hides it |
| `Enter` | On a table column: sort by it. On a log line: show its labels |

## Explore

**Explore** (in the sidebar) asks a one-off question of a project's sources without building a dashboard, and redraws as you type.

### Where to look

- **Project** and **Source** pick what to read. Explore opens on the project you came from, else the one you opened last. The source is the project's first Prometheus-compatible one, else its first Loki one. Every query goes through the project's label filter, as everywhere else in Monitoring.
- The time button sets the range (the default is the last hour) and offers the same presets and **Custom range…** as a dashboard. `t` opens it.
- The page's state (project, source, query, logs query and range) belongs to the workspace tab. After a reload, or Back, it is as you left it.

### The query bar

Type a PromQL query (LogQL for a Loki source) in the **Query** field. It runs 300 ms after you stop typing, and **Ctrl Enter** runs it now. A line under it says how the last run ended, for example `✓ 4 series · 38 ms · Last 1 hour · updated 10:21:07`, and **Running…** shows beside it while a run is on.

- A query the tool refuses as unreadable (a syntax error, say) keeps the last result on screen, dimmed and labelled **Last good result** with the query that made it, so a typo while typing never blanks the chart. The line says what is wrong and "showing the last result".
- Text with an unclosed bracket or quote is refused on the spot with a message and is not sent.
- A tool that didn't answer (**Source unreachable**) or failed in any other way (**Query error**) draws no chart, never the old one as if it were current, and offers **Try again**.
- A slow answer to an older text never replaces a newer one.

### The trail

**Recent queries** keeps the project's last queries that answered (twenty kept, the newest eight shown). Pick one with the mouse or Enter, or move with `←` and `→`, to bring back its query and its source. **Clear** empties the trail. A query joins the trail when it answered and its text stayed for two seconds, when you press Ctrl Enter, or when you add it to a dashboard. The trail is kept in this browser, per project.

### Browsing

The list on the left shows **Metrics** for a Prometheus-compatible source, or **Log streams** for Loki, as they are under the project's filter. Type in **Filter** to narrow it, and `b` goes to the list. Letters typed on the list go into **Filter**. Pick a metric and Explore writes its query: a counter as a rate per second, a histogram as a percentile, a gauge as it is. Pick a log stream (`label = value`) and it writes the selector. The footer says how old the list is and has **Refresh list**. On a narrow window the list folds behind a **Metrics** or **Log streams** button.

Chips under the query shape it:

- **Split by** groups the result by one label.
- **Only** keeps one value of a label (`label=value`). It offers six labels: the ones Loki also has, then common labels such as `namespace`, `pod` and `container`, and chart labels such as `app_kubernetes_io_*` last. A label you chose a value of always stays, so you can turn it off, and choosing never moves a row. A label with more than eight values has a **more…** popover with a **Filter values** box. For logs the values come from the log streams.

Clicking a chip rewrites the query and runs it. If you edit the query by hand, Explore says "You edited the query by hand. Clicking a chip writes it again from the chips." and leaves your text alone until you click a chip. You can always write the query yourself; the list and chips are only a way to start.

### Logs on the same timeline

Under the chart, **Log lines** shows the lines of the same time range, newest first, up to 1000.

- With a metrics query, the lines come from the **Only** chips whose labels Loki also has, or from a LogQL selector you type in the **Logs query** field. Ticks along the chart mark the times of the lines, toned by level. A project with no Loki source has no lines.
- **Drag a window** across the chart, or press `Shift ←` or `Shift →` on the focused chart, and the lines narrow to exactly that window. With the keys the chart keeps the keyboard, so more `Shift ←` or `Shift →` presses widen or narrow the window. **Show all** (or Esc on the chart) goes back to the whole range.
- With a Loki source the query bar takes LogQL. Explore charts the log volume (split by the **Split by** chip) and lists the lines below it. A LogQL query that counts something, such as `rate({app="api"}[5m])`, is a metric query: it draws a chart and lists no lines.

### Add to dashboard

**Add to dashboard** (or `a`) turns the query into a panel. Pick a dashboard of the project, or of a group that holds it, or **New dashboard in …** with a **Title**. Then set the **Panel title** and the **Chart** (**Time series**, **Stat**, **Bar** or **Table**; a log query becomes a **Logs** panel) and press **Add panel**. The query text is added exactly as written. The page then says `Added to "…".` with **Open dashboard**.

If the dashboard has unsaved changes in this browser, the panel is saved to it now, and saving your draft later asks you to review the differences. The Audit log records a panel added to an existing dashboard as **Saved a dashboard**, and its details say it came from Explore and name the panel it added. A new dashboard is recorded as **Added a dashboard**, like any other new dashboard, without that note.

### Reduced motion and keys

If your system asks for reduced motion, Explore's charts jump instead of morphing, and a panel added from Add panel or the suggestions appears at once instead of flying in.

Keys in Explore, as in the `?` sheet (letters work only when you aren't typing in a field):

| Key | What it does |
| --- | --- |
| `q` | Go to the query |
| `b` | Go to the metric or log stream list |
| `l` | Go to the log lines |
| `t` | Pick the time range |
| `Ctrl Enter` (`⌘ Enter`) | In the query: run it now |
| `a` | Add the query to a dashboard |
| `Shift ← →` | On the chart: select a time window for the log lines |
| `Esc` | On the chart: show all log lines again |

## Alerts

An alert tells you when a number you care about crosses a line: errors above 5%, a pod that keeps restarting, free disk below 10 GB. **Alerts** in the sidebar opens the Alerts page, and a panel's **Alert** tab makes the same kind of rule from a chart.

### What a rule is

A **rule** says "alert when any series of this query is above (or below) a number, for this long, checked this often".

- A rule belongs to a **project** or to a **group**. A group's rule runs once in each of the group's projects, so it holds one rule per project, each reading that project's own source through that project's label filter. A rule never reads another project's data.
- A rule has a name, a severity (**Critical**, **Warning** or **Info**), a message, and the contact points to notify.
- A rule's state is its **worst state**: the badge on a rule that runs in several projects shows the most serious one, in this order: **Firing**, **Query error**, **Can't check**, **Not applied**, **Pending**, **Not checked yet**, **No data**, **OK**, **Paused**.

### Where a rule runs

When you make a rule you choose **Where it runs**.

- **Checked by OmniKrux.** OmniKrux asks the source the rule's query on the interval you picked, and tells the contact points itself. It works with any source, but only while OmniKrux is running. The Alerts page says so under its title.
- **In the tool.** The tool that holds the data checks the rule and keeps doing so when OmniKrux is off. For Prometheus this is a `PrometheusRule` in the cluster, which the Prometheus Operator loads, so only a Prometheus the Operator runs can take it (a Prometheus installed some other way, such as a plain Helm chart, says "isn't run by the Prometheus Operator"); for Loki it is a rule in Loki's ruler. Each project says what it can do: the choice is greyed out when no project of the rule has a tool that can run it, and a project whose tool can't take the rule is checked by OmniKrux instead, with the reason shown.
  - A `PrometheusRule` is a change to the cluster, so it is **reviewed like any cluster change**: the review shows what will be created, changed or removed, and nothing happens until you confirm it. The rule reads **Not applied** until you do.
  - A Loki ruler rule is written (and removed) at once, and **Audit** records each change before it is made.
  - The notifications of a rule that runs in the tool come from that tool's Alertmanager, not from OmniKrux. Pick its **Channel** (an Alertmanager route, with the labels the rule must carry to reach it), or leave **Wherever its Alertmanager sends it**. Where OmniKrux installed the tools, the rule notifies contact points instead, sent by OmniKrux's own Alertmanager (see [Contact points and OmniKrux's own Alertmanager](#contact-points-and-omnikruxs-own-alertmanager)).

A rule that runs in the tool and one OmniKrux checks look the same on the Alerts page, apart from the **Where** line (**checked by OmniKrux**, **in Prometheus** or **in Loki**).

### What the states mean

Every rule and every project it runs in shows one state word.

| State | What it means and what to do |
| --- | --- |
| **OK** | The query was checked and nothing crosses the line. |
| **Pending** | Something crosses the line, but not for the **For** time yet. |
| **Firing** | It has crossed the line for the whole **For** time. Contact points were told (once per series; see [Notifications](#notifications)). While a silence mutes it, it still reads **Firing**, with **silenced** after it (or how many of its series are silenced), and its row carries a **Silenced** tag. |
| **No data** | The query answered, but with no value to compare, for example because nothing matches its labels. Check the query in Explore. If a missing series should itself be an alert, alert on `absent(...)` or on a count instead. |
| **Can't check** | OmniKrux couldn't reach the source, so it doesn't know. Nothing is resolved and nothing new is claimed. Open the source on the **Sources** page and press **Test**, or see the reason on the rule. After three failed checks in a row OmniKrux sends one "can't check" message to the contact points. |
| **Query error** | The query can't run as written (a wrong query, no source of the right type in the project, or more series than OmniKrux can follow). The rule says why; fix the query or link the source on the project page. |
| **Not applied** | The rule should run in the tool but isn't there yet. **Review** opens the cluster change to confirm; **Retry** writes a Loki rule again. A rule that stays **Not applied** after the review is applied says why under its name. |
| **Not checked yet** | No check has run yet, so no state is known. A rule OmniKrux checks says when its first check runs ("Not checked yet: the first check runs within 1 min."). A rule in the tool says **Loading in Prometheus…** (or Loki) while the tool hasn't run it yet (Prometheus reloads its rules on a schedule); after ten minutes it turns into a **Query error** with the reason if the tool never loaded it. |
| **Paused** | You paused the rule. OmniKrux doesn't check it and tells nobody. Only a rule checked by OmniKrux can be paused; a rule in the tool keeps being checked there, so **Silence** it instead. |

If the page can't read the states for a moment, it keeps what it showed, says how old that is ("Couldn't refresh. Last known: Firing at 14:02:11.") and never shows an old state as current.

### The Alerts page

**Alerts** opens the page. Its header has the views **Rules**, **Silences** and **Contact points**, and **New alert rule**. Press `1`, `2` or `3` to change view. A note under the title says whether OmniKrux's own checks are on time ("Last check 14:02:11"), running late or turned off.

In **Rules**:

- The list on the left has what is firing pinned on top, then every rule under its project or group. `↑` and `↓` move through it and show the rule; `Enter` opens it on a narrow window.
- The details on the right show the rule's **State**, **Where** it runs, how often it is **Checked**, what it **Notifies**, its **Severity**, and its project or group. A rule made from a panel says **From panel** and has **Edit on its panel**; any other rule has **Edit rule**.
- A chart draws the rule's query with the threshold, and **Recent** lists what happened lately: **Started firing**, **Resolved**, **Can't check**, **Checking again**, **Query error**, **Applied**, **Couldn't apply** and **Removed**. OmniKrux keeps seven days of it.
- **Silence** (or `s`) opens a silence for the selected rule. **More actions** has **Pause** and **Resume**, **Attach to a panel…** (for a rule made on this page) and **Delete rule…**.

Rules are read again every 15 seconds.

### Make a rule on the page

**New alert rule** opens the form.

1. **Name**, and whether it is for a project or a group, and the source it reads (**Prometheus-compatible** or **Loki**; by default the project's first source of that type).
2. **Query.** Write the query as you would in Explore. Variables aren't available here, but the built-ins are: `$__interval` is the check interval, and `$__rate_interval` is four times the check interval but never under four minutes. A query that returns log lines can't be an alert; count them (`sum(count_over_time({...}[5m]))`).
3. **The sentence.** **Alert when** *any series* or *the total* is **above** or **below** a **threshold**, **For** how long (right away, or a time such as 5 min), **Checked every** 30 seconds, 1 minute or 5 minutes. "The total" adds the series up before comparing.
4. **Details.** **Severity**, **Message** (it can use `{{value}}` and `{{label}}`) and **Notify**, the contact points to tell. With none yet, **Add one on the Contact points tab**.
5. **Where it runs**, as above.

While you write, a line under the sentence says how often the rule would have fired over the last 6 hours on the real data (a dry run: nothing is stored and nobody is told). When it would have fired often, it offers a calmer threshold: "That's often. At 0.5 it would have fired once." with a button **Use 0.5**. **Save rule** (or `Ctrl Enter`) saves it. If someone else changed the rule meanwhile you are told to open it again.

For a group rule the dry run counts across the projects, and a project whose query fails says so on its own line instead of counting as "would not have fired".

### An alert on a panel

A time series, stat, gauge or bar panel has an **Alert** tab in the dashboard editor; other types say "A table panel can't have an alert. Use a time series, stat, gauge or bar panel." **Add an alert** starts one on the panel's own query.

- It uses the same sentence, the same dry run (its advice shows in the recommendation bar above the tabs) and the same **Where it runs** and **Notify** choices. On the chart, a dashed line and a shaded area show where the alert would fire. When the rule has a state, the tab says **Now: Firing for 4 min**.
- **Variables use their defaults.** An alert has nobody to choose values, so each variable takes its default (the tab says "Alerts use each variable's default: ..."), and the built-ins come from the alert's own interval.
- **The alert is part of the dashboard.** It is saved with the dashboard (the dashboard's new version holds it), its rule appears on the Alerts page marked **From panel**, with a link back to the panel. Edit it on the panel, not on the page.
- **Removing it.** **Remove alert** deletes the rule when you save the dashboard. Removing the panel does the same. If the dashboard is **deleted**, its rules stay on the Alerts page as ordinary rules without a panel (the delete dialog says so); **Attach to a panel…** on a rule's menu (for a rule made on the page) puts it on a panel of one of that project's or group's dashboards.
- **Copies drop alerts.** Copying a dashboard doesn't copy its alerts ("Alerts aren't copied; add them on the copy's panels.").
- Deleting a contact point removes it from the panels that name it, with a new version of each of those dashboards.

### Contact points

A **contact point** is where a message goes. Open **Contact points** (or `3`) and press **Add a contact point**. The type is chosen once and can't change after saving.

| Type | Fields |
| --- | --- |
| **Slack** | **Webhook address** (an incoming webhook). |
| **Teams** | **Webhook address** (a Microsoft Teams workflow or connector webhook). |
| **Email** | **Mail server**, **Port** (587 by default), **Security** (**STARTTLS**, **TLS** or **None**), **User name** and **Password** (optional), **From** and **To** (up to 20 addresses, separated by commas). A password is only sent over an encrypted connection. |
| **PagerDuty** | **Routing key** (32 letters and digits) and the **Events address** (the PagerDuty events API by default). |
| **Webhook** | **Webhook address**, and an optional **Bearer token**. OmniKrux posts JSON to it. |

Secrets (webhook addresses, tokens, passwords and routing keys) are stored encrypted and are never shown again: a saved one says "Saved. Leave empty to keep it." and a **Remove the saved ...** box takes an optional one away. Changing where a contact point sends to asks for its secret again.

**Send a test** sends a message that says "OmniKrux test message" to a saved contact point, and says what happened ("Sent. Check that the test message arrived." or the receiver's own refusal, without any address). Each contact point shows its last send, who uses it ("Used by 2 rules" or "Not used yet"), and deleting it first lists the rules that lose it.

### Notifications

OmniKrux tells the contact points of a rule it checks:

- **When a series starts firing**, one message per check and rule, listing the series that started (up to ten lines, then "And N more."). Series that fire together are in one message.
- **While it keeps firing**, again every 4 hours, so a long incident isn't forgotten and isn't repeated every minute.
- **When it resolves**, a **Resolved** message for each series somebody was told about.
- **When it can't check**, after three failed checks in a row, one **Can't check** message, repeated every 4 hours while it lasts, and **Checking again** when the first check works.

A failed send is tried again (right away, after 5 and after 30 seconds) and recorded; the contact point shows its last result. A rule that runs in the tool is not sent by OmniKrux at all: that tool's Alertmanager sends it, so its contact points are only used in the projects where OmniKrux checks it instead (a project whose tool can't take the rule).

### Silences

A **silence** mutes the notifications of what it matches; it never changes what the checks find (a silenced alert is still Firing, and its row says silenced). Open **Silences** (or `2`) and press **New silence**.

- **Where.** **OmniKrux** silences the rules OmniKrux checks. Each linked Alertmanager is a choice of its own (listed under its name) and silences what it sends, which is how you silence a rule that runs in the tool. A rule's **Silence** button picks the right one and fills in the matchers. The list shows them as **In OmniKrux** and **In Alertmanager**.
- **Matchers.** Written like `alertname="API latency high"` or `project="shop", team=~"web|api"`. Use `=`, `!=`, `=~` and `!~`; regular expressions must match the whole value. At least one matcher must name something. While you type, a line says how many alerts it silences now and names the first rules.
- **Lasts.** **1 h**, **2 h**, **4 h**, **1 day** or **Until…** (a date and time; a silence lasts at most 90 days), and a **Comment** so others know why.
- Ended silences stay listed for a day. **Expire silence** ends one now ("Its alerts notify again at their next check.").
- A silence or contact point you are writing isn't kept anywhere else, so going elsewhere (the sidebar, Back, another view), switching or closing the Monitoring tab, or reloading asks first: **Leave "…" with unsaved changes?** ("Leaving loses what you entered in this form.").

An Alertmanager that can't be read is listed under **Problems**; it never hides the others.

### Alertmanager sources and channels

Link a Prometheus you run to its Alertmanager by adding an **Alertmanager** source (for example `http://alertmanager.example:9093`) to the project, the same way as any other source. An Alertmanager holds alerts, not metrics, so queries can't run on it. OmniKrux uses it for the channels of a rule in the tool, to mark which alerts it has silenced, and to list and create silences. Only routes matched by equality can be a channel, because those are the labels OmniKrux can add to a rule.

### Home and the sidebar

Home shows a **Firing** section above the projects: a row for each rule that fires, with its project, how long and a summary, which opens the rule, plus **Silence**. With nothing firing it says "All quiet" and how many rules there are; a rule that can't be checked adds a line that opens the Alerts page. Project and group cards say "2 firing", and **Alerts** in the sidebar carries the count. If the alerts can't be read, Home says so rather than "All quiet".

### A rule that may read another cluster

If a Kubernetes project's source link has no label filter, because OmniKrux couldn't tell which label separates your clusters in a shared Prometheus or Loki, a rule there may fire on another cluster's data. The rule form, the rule's details, a panel's **Alert** tab and the project's link then warn: "…may include other clusters: OmniKrux couldn't tell which label separates them, so this rule may fire on another cluster's data. Add a filter on the project page." To fix it, open the project, add a [label filter](#label-filters) such as `cluster="prod-east"` to that link, and save; the rule's query then carries the filter and the warning goes.

### Deleting things that have rules

- **Delete rule…** says what goes with it. A rule that runs in a cluster needs its own review to remove its `PrometheusRule`, and stays in the list, "being removed", until that is done. A Loki rule is removed from the ruler first, and nothing is deleted if the ruler refuses.
- **Delete project…** and **Delete group…** list "Alert rules that go with it". When some of a project's rules still run in its cluster, the review says "Remove its rules that run in ... first" and gives each a **Review** button that removes the rule and then opens its removal in the cluster for you to confirm. The project is deleted after that.
- Deleting a contact point first lists the rules that lose it.

### Audit

The Audit log records **Added an alert rule**, **Changed an alert rule**, **Removed an alert rule**, **Added a contact point**, **Changed a contact point**, **Removed a contact point**, **Sent a test message**, **Added a silence**, **Expired a silence**, and for rules in a Loki ruler **Wrote a Loki rule** and **Removed a Loki rule**. A `PrometheusRule` goes through the normal cluster change record. An entry names the rule, contact point or silence and what changed, never a webhook address, token, password or routing key.

## Installing the tools

When a cluster has no Prometheus or Loki, OmniKrux can install them. Everything it installs goes through a review first, like any other change to a cluster, and is recorded in Audit.

### What OmniKrux installs

Into a Kubernetes cluster, in one namespace (`monitoring` unless you change it), with the Helm and the chart archives that ship inside OmniKrux:

| Component | What runs | Charts |
| --- | --- | --- |
| **Metrics** | Prometheus, Alertmanager, node-exporter and kube-state-metrics, run by the Prometheus Operator | kube-prometheus-stack 93.1.1 (Helm release `omnikrux-metrics`) |
| **Logs** | Loki in single-binary mode, and Grafana Alloy, which collects every Pod's logs and sends them to that Loki | loki 7.5.0 with Loki 3.6.16 (release `omnikrux-loki`), alloy 1.15.0 with Alloy 1.21.3 (release `omnikrux-alloy`) |

- The cluster pulls the container images itself, from their public registries. A first install can take several minutes while it does.
- Grafana isn't installed: OmniKrux draws the dashboards itself.
- For metrics, OmniKrux writes the Prometheus Operator's resource definitions (`monitoring.coreos.com`) itself before Helm runs, because Helm never updates them. A newer one the cluster already has is kept.
- The charts' own alert rules aren't added. Your alert rules are your own (see [Alerts](#alerts)).

### Where to start an install

- **Setup, step 2.** **Install Prometheus…** or **Install Loki…** on a missing tool. After **Create project and review the install**, the review opens, and what gets installed is added to the new project.
- **A Kubernetes project.** Its page has a **Monitoring tools** section that says what OmniKrux installed in the project's cluster ("Installed by OmniKrux in monitoring · Running", or "Something is missing", "Not healthy", or "OmniKrux hasn't installed anything in …"). **Install what's missing…** or **Open Monitoring tools** opens the cluster's Monitoring tools page.
- **Monitoring tools.** The page of one cluster, **Monitoring tools in** followed by the cluster's name. Open it from a project, from **Monitoring tools** beside a source marked **Installed by OmniKrux** on the Sources page, or from that mark in setup; `Ctrl` click (`⌘` click on macOS) opens it in a new Monitoring tab. With nothing installed, tick **Metrics**, **Logs** or both and press **Review install…**.

When the Helm and charts OmniKrux installs with aren't there (OmniKrux run outside its image without them), each of these says so instead ("Installing isn't available here: …") with what to do.

### The review

The review is the normal change review, built on the server from what the cluster has now. Its lines say:

- what it installs, into which cluster and namespace, and that the cluster pulls the images itself;
- that it creates the namespace, when it isn't there;
- how many of the Prometheus Operator's resource definitions it creates and updates;
- for each Helm release, the chart and its version and what it creates (for example "2 Deployments, 1 DaemonSet, 6 Services, … and 4 other objects");
- where the data is kept: "Keeps data for 7 days on volumes: …" with the sizes and the storage class, or "Keeps data for 7 days, only until the Pods restart." without volumes;
- which tools OmniKrux connects as sources afterwards, and the project it adds them to.

**Settings** opens the settings, with a one-line summary beside it:

| Setting | Default |
| --- | --- |
| **Namespace** | `monitoring` (not `default` or a `kube-` namespace) |
| **Keep data for** | 7 days (1 to 90) |
| **Keep data on volumes** | On: Prometheus 20Gi, Loki 10Gi, Alertmanager 1Gi |
| **Resources** (**CPU request**, **Memory request**, **Memory limit**) | Prometheus 200m, 512Mi, 2Gi; Alertmanager 10m, 32Mi, 128Mi; Loki 100m, 256Mi, 1Gi; Grafana Alloy 50m, 128Mi, 512Mi |

A value that doesn't fit says so under its field ("Use a size like 10Gi.", "Use memory like 256Mi or 1Gi.", "The limit can't be below the request (512Mi)."). **Update review** builds the review again with your changes; until you press it, the dialog says "Not in this review yet. Update review to use them." In a cluster without a default storage class the data can't be kept on volumes: the box is off, and the review says the tools keep their data only until their Pods restart.

The review is **blocked**, in words, when installing would clash with what is there: a Prometheus Operator OmniKrux didn't install ("Connect the Prometheus it runs instead."), a Helm release with one of OmniKrux's release names that OmniKrux didn't make, tools OmniKrux already installed in another namespace of the cluster, an install or uninstall already running there, a change to the volume of a Loki that is already installed (Kubernetes never lets it change: keep Loki's storage as it is, or uninstall and install again), or a chart that refuses the cluster (in the chart's own words). On a production cluster the review says so and asks you to type the namespace name before **Install**.

### Progress, cancelling and failures

After you confirm, the install runs on its own, step by step: "Creating the namespace monitoring…", "Updating the Prometheus Operator's resource definitions…", "Installing omnikrux-metrics with Helm…" (and the other releases), "Waiting for Prometheus to be ready…" with what holds each tool up (for example a Pod still pulling its image), then "Connecting the sources…". You can close the dialog: the install carries on, and the Monitoring tools page follows it.

- **Cancel install** asks "Stop the install? What Helm already applied stays." **Stop install** stops Helm, which can take up to about 20 seconds ("Stopping the install…"). The message then names the step it stopped in and says that what was applied stays as Helm left it.
- A failure says what failed, in Helm's or the cluster's words, and what stays. OmniKrux never rolls anything back and never deletes what a failed install made. A tool that isn't ready after 10 minutes stops the wait, with the reason.
- **Install again…** on the Monitoring tools page finishes a failed or cancelled install from where it is.
- If Helm was stopped before it could record how its change ended, Helm won't touch that release again. The review then says so ("Helm's record of omnikrux-metrics says an earlier change never finished (pending-install), …"): use **Uninstall monitoring tools…**, then install again.
- If OmniKrux stops while an install runs, the install says so when OmniKrux starts again ("OmniKrux stopped during the install. …"). Open Monitoring tools to see what's there, then run it again.

### What gets connected

Once everything is ready, OmniKrux adds each installed tool as a source (Prometheus, Alertmanager and Loki, reached through the cluster) marked **Installed by OmniKrux**. A source that already reaches the same tool is reused, never added twice. When the install was started from a project or from setup, the sources are added to that project. OmniKrux waits until each source answers before it says the tools are running ("Installed in monitoring: … are running. Connected 3 sources.").

### The Monitoring tools page

The page reads Helm's own records and the cluster each time, and says when ("Read …", with **Refresh**). If the read fails it says so and shows nothing old as current. It shows:

- the state ("Installed by OmniKrux in monitoring", "Installing…", "The last install failed", "The last install was cancelled" or "Uninstalling…") and the last message;
- **Metrics** and **Logs**, each **Installed**, **Not installed**, **Not healthy** or **Working**;
- each Helm release with its chart, its status in Helm and its revision, and its workloads with their ready and wanted Pods (and why one isn't ready);
- the **Sources** it connected, and the state of the **Contact points** (see below);
- a Prometheus, Loki or Alertmanager the cluster already runs elsewhere ("You can connect it instead of installing another."), with **Use it in a project**.

### Updating to the shipped versions

When a newer OmniKrux ships newer charts than the ones installed, the page offers **Update to the shipped versions…**: the same review, titled "Update monitoring tools in monitoring", with your settings kept. **Install what's missing…** adds a component you didn't install yet (for example **Logs** next to **Metrics**); that review covers what is installed too, so nothing is removed.

### Contact points and OmniKrux's own Alertmanager

When OmniKrux installed the tools, their Alertmanager is OmniKrux's own, so a rule that runs in that Prometheus can notify OmniKrux's [contact points](#contact-points). The rule form then shows **Notify** with the contact points ("These contact points are sent from the Alertmanager OmniKrux installed; saving asks you to review that change."). A rule whose projects use both kinds of tools shows both the contact points and a **Channel** for the Prometheus you run.

- Saving such a rule, or changing or deleting a contact point it uses, opens a review of the contact points in that Alertmanager, for example "Send alerts to 2 contact points from monitoring's Alertmanager" (or an update, or a removal when nothing is left to send). It names each contact point and the rules that use it, and says that the secret values are held in a Secret and never shown. Nothing changes in the cluster until you confirm.
- The Monitoring tools page shows **Contact points**: "Up to date · 2 contact points for 3 rules", or "Changed since the last review" with **Review** (for example after you cancelled a review), or "Couldn't be updated: …" with **Try again**.
- Webhook addresses, tokens, passwords and routing keys are written only into an Alertmanager OmniKrux installed, in its own Secret. They never appear in the review, in Audit, on the page or in a log. OmniKrux never writes secrets into a Prometheus or Alertmanager you run yourself: rules there use a **Channel** of your Alertmanager instead.
- Alertmanager sends email with direct TLS only on port 465. An email contact point set to **TLS** on another port is left out, and the review says why.

### Uninstalling

**Uninstall monitoring tools…** opens its own review, which opens with the focus on **Cancel**. It says:

- which Helm releases it removes from the cluster (Grafana Alloy, Loki, then the metrics stack, whose Prometheus and Alertmanager go first);
- that the Secret `omnikrux-metrics-admission`, which the metrics chart's setup job made, goes too;
- that OmniKrux's contact-point settings are removed from its Alertmanager;
- which sources go, and which projects lose them;
- what happens to the stored data: kept unless you tick **Also delete the stored data (metrics, logs and alerts history on the volumes)**, which can't be undone;
- that the namespace and the `monitoring.coreos.com` resource definitions stay, so objects other tools made aren't touched.

The review is blocked while alert rules still run in these tools: "Move or remove the alert rules that run in these tools first: …". Each of those rules has its own review. On a production cluster you type the namespace name. Cancelling an uninstall leaves what was already removed removed; **Uninstall monitoring tools…** again finishes it.

**Deleting a project never uninstalls anything.** The project's delete review says "Monitoring tools OmniKrux installed in … stay. Uninstall them from Monitoring tools."

### Docker hosts and servers

OmniKrux doesn't install on a Docker host or on servers itself, and never asks for SSH keys or the Docker socket. It writes a file that installs the same tools (Prometheus, Alertmanager, node-exporter, Loki and Grafana Alloy, at the same versions), and you run it. Find it in setup step 2 for **A Docker host** or **Servers**, and in the **Monitoring tools** section of such a project.

1. Fill in **Address OmniKrux will reach them at** (a host name or IP address, without `http://` or a port) and **Keep data for**; for servers also **Servers to watch** (one `host` or `host:port` per line; node-exporter is read on port 9100 unless you give one).
2. Press **Write the file** (a `docker-compose.yml`) or **Write the script** (`omnikrux-monitoring.sh`), then **Copy** it, or download it with the **Download** button that names the file.
3. Run it. On a Docker host, copy the file there and run `docker compose up -d` in its folder. On servers, run `sudo bash omnikrux-monitoring.sh --role central` on the server that keeps the data, and `sudo bash omnikrux-monitoring.sh --role agent --central <address>` on every other one. The script checks every download against its pinned checksum before it installs anything, and runs the tools as systemd services.
4. Make sure the ports the instructions name (Prometheus 9090, Alertmanager 9093, Loki 3100) are reachable from OmniKrux, and from nowhere else: **the tools have no sign-in**.
5. OmniKrux waits for the tools to answer ("Waiting for the tools to answer…", each tool **Answering** or **Not answering yet**; **Stop waiting** and **Wait again**). Once they answer, they become sources of the project.

To remove them, run the script with `--uninstall` (add `--purge` to delete the data too), or `docker compose down` on the Docker host (add `-v` to delete the data too).

### Audit

An install is recorded as **Installed** and an uninstall as **Uninstalled**, with the cluster, the namespace and how it ended. The sources OmniKrux connects or removes are recorded as **Added a source** and **Removed a source**, and the contact-point review as a change to the `AlertmanagerConfig` `omnikrux-contact-points`. No entry holds a secret.

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

Every change in Monitoring is written to the Audit log, marked as coming from Monitoring: **Added a source**, **Changed a source**, **Removed a source**, and the same for projects and groups. For dashboards the entries are **Added a dashboard** (a new one or a copy), **Saved a dashboard**, **Restored a dashboard version** and **Removed a dashboard**. An entry names what changed and whether it succeeded. A dashboard's entries say who owns it, which versions are involved and how many panels it has, never its queries. A panel added from Explore to an existing dashboard is recorded as **Saved a dashboard**, with a note that it came from Explore and the title of the panel added. Details never include secrets: an entry says which kind of sign-in a source uses, not the password or token. Reading is not audited: testing a source, opening a project or running a query leaves no entry.

## What comes in later updates

- Importing existing Grafana dashboards.
- Finding the tools that already run on a Docker host or servers by itself (today OmniKrux checks only the addresses you give it).
