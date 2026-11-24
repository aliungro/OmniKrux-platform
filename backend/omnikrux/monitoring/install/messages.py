"""What OmniKrux says when the tools it installs with are missing or aren't the pinned ones."""

# `where` is " at {path}" when a path was configured, or empty when Helm was looked up on PATH.
TOOLS_NO_HELM = "Installing needs Helm, which ships in the OmniKrux image. It wasn't found{where}. Run OmniKrux from its image, or run scripts/dev-monitoring-tools.sh."
TOOLS_WRONG_HELM = "Installing needs Helm {expected}, and {path} is {found}. Rebuild the image, or run scripts/dev-monitoring-tools.sh."
TOOLS_NO_CHARTS_DIR = "Installing needs the chart archives that ship in the OmniKrux image, and OMNIKRUX_CHARTS_DIR isn't set. Run OmniKrux from its image, or run scripts/dev-monitoring-tools.sh."
TOOLS_BAD_CHART = "The {chart} chart archive in {dir} is missing or isn't the pinned {version}. Rebuild the image, or run scripts/dev-monitoring-tools.sh."

# Not in the plan's copy list: TOOLS_WRONG_HELM's `found` when the file doesn't answer
# `helm version` (it can't run, fails, or takes longer than 5 seconds).
TOOLS_HELM_NO_ANSWER = "a program that didn't report a Helm version"

# Helm's own words when it fails, with every secret and (for cloud clusters) address taken out.
HELM_FAILED = "Helm couldn't {step}: {reason}"
HELM_FAILED_CLOUD = "Helm couldn't {step}: the cluster refused or didn't answer. Check the cloud login and the network, then try again."
HELM_TIMEOUT = "Helm didn't finish {step} within {minutes} minutes."
# Not in the plan's copy list: HELM_FAILED's `reason` when Helm wrote nothing to stderr.
HELM_NO_REASON = "it stopped with exit code {code} and gave no reason"

# Install settings (a problem is shown beside its field) and what changes when the cluster
# can't keep data.
SETTING_NAMESPACE = "Use a namespace name: lower-case letters, digits and -, up to 63 characters."
SETTING_NAMESPACE_RESERVED = "OmniKrux doesn't install into {namespace}. Pick another namespace."
SETTING_RETENTION = "Keep data for 1 to 90 days."
SETTING_STORAGE = "Use a size like 10Gi."
SETTING_CPU = "Use CPU like 100m or 0.5."
SETTING_MEMORY = "Use memory like 256Mi or 1Gi."
SETTING_LIMIT_BELOW_REQUEST = "The limit can't be below the request ({request})."
NO_STORAGE_CLASS = "This cluster has no default storage class, so the tools keep their data only until their Pods restart."

# Reading what a chart creates (not in the plan's copy list; `step` completes "Helm couldn't ...").
RENDER_STEP = "read the {chart} chart with these settings"
CRDS_STEP = "read the {chart} chart's CustomResourceDefinitions"
RENDER_TOO_LONG = "Helm's answer when it tried to {step} was too long to read in full, so OmniKrux used none of it. Try again."
RENDER_UNREADABLE = "Helm's answer when it tried to {step} couldn't be read. Try again."

# The install review (a server-built plan through the action pipeline).
INSTALL_TITLE = "Install monitoring tools in {namespace}"
UPDATE_TITLE = "Update monitoring tools in {namespace}"
INSTALL_LABEL = "Install"
UPDATE_LABEL = "Update"
SUMMARY_INSTALLS = "Installs {what} into {cluster}, namespace {namespace}. The cluster pulls the container images itself."
WHAT_METRICS = "Prometheus, Alertmanager, node-exporter and kube-state-metrics (kube-prometheus-stack {version})"
WHAT_LOGS = "Loki {loki} in single-binary mode and Grafana Alloy {alloy} to collect Pod logs"
WHAT_BOTH = "{metrics}, and {logs}"
SUMMARY_RELEASE = "Helm release {release}: chart {chart} {version}; creates {objects}."
SUMMARY_NAMESPACE = "Creates the namespace {namespace}."
SUMMARY_CRDS = "Creates {created} and updates {updated} CustomResourceDefinitions of the Prometheus Operator (monitoring.coreos.com)."
SUMMARY_VOLUMES = (
    "Keeps data for {days} days on volumes: {volumes} ({storage_class} storage class)."
)
# A CustomResourceDefinition the cluster has at a newer operator version than the chart's.
SUMMARY_NEWER_CRD = "Keeps the newer {crd} the cluster already has ({version})."
SUMMARY_MEMORY = "Keeps data for {days} days, only until the Pods restart."
# `tools` lists what this install connects (Prometheus, Alertmanager, Loki); the plan's wording
# is for all three, and these read right for one ("Loki as a source ... adds it").
SUMMARY_CONNECT = "Then OmniKrux connects {tools} as sources{project}."
SUMMARY_CONNECT_ONE = "Then OmniKrux connects {tools} as a source{project}."
SUMMARY_CONNECT_PROJECT = " and adds them to the project {project}"
SUMMARY_CONNECT_PROJECT_ONE = " and adds it to the project {project}"
BLOCK_FOREIGN_OPERATOR = "This cluster already runs a Prometheus Operator ({where}) that OmniKrux didn't install. A second one would fight over the same objects. Connect the Prometheus it runs instead."
BLOCK_FOREIGN_RELEASE = "A Helm release named {release} already exists in {namespace}, and OmniKrux didn't install it. Pick another namespace."
BLOCK_OTHER_NAMESPACE = "OmniKrux already installed its tools in {namespace} in this cluster. Update them there, or uninstall them first."
BLOCK_BUSY = "OmniKrux is {doing} in {cluster} right now. Wait for it to finish, or cancel it."

# Applying a reviewed install, and the install job's steps (each shown while it runs).
INSTALL_STALE = (
    "The monitoring tools in {namespace} changed since you reviewed this. Review it again."
)
INSTALL_NO_JOBS = "OmniKrux is shutting down; nothing was installed."
# Not in the plan's copy list: the install record couldn't be written before the job started.
INSTALL_NOT_SAVED = (
    "OmniKrux couldn't save the install record, so nothing was installed. Try again."
)
INSTALL_STARTED = "Installing the monitoring tools in {namespace}…"
STEP_NAMESPACE = "Creating the namespace {namespace}…"
STEP_CRDS = "Updating the Prometheus Operator's resource definitions…"
STEP_HELM = "Installing {release} with Helm…"
STEP_WAIT = "Waiting for {label} to be ready ({ready} of {total})…"
# The waiting step as INSTALL_CANCELLED names it (without the count, which changes as it runs).
STEP_WAIT_WORDS = "Waiting for {label} to be ready…"
STEP_CONNECT = "Connecting the sources…"
# HELM_FAILED's `step` for an upgrade ("Helm couldn't install omnikrux-loki: ...").
HELM_INSTALL_STEP = "install {release}"

# How the install job ends. `tools` e.g. "Prometheus, Alertmanager, Loki and Grafana Alloy";
# `project` is " to {project name}" when the sources were added to a project, else empty.
INSTALLED = "Installed in {namespace}: {tools} are running. Connected {n} sources{project}."
# Not in the plan's copy list: INSTALLED when one source was connected (logs alone).
INSTALLED_ONE = "Installed in {namespace}: {tools} are running. Connected 1 source{project}."
INSTALLED_PROJECT = " to {project}"
# `status` is the release's Helm status read after the failure (e.g. failed), or unknown.
INSTALL_HELM_FAILED = "{helm_words} What Helm applied stays as Helm left it ({status}). Check the Pods in {namespace}, then install again, or uninstall the tools."
INSTALL_NOT_READY = "{label} wasn't ready after 10 minutes: {why}. What Helm applied stays. Check the Pods in {namespace}, then install again, or uninstall the tools."
INSTALL_CONNECT_FAILED = "The tools are running, but OmniKrux couldn't connect {tool}: {message} Add it from Sources, or install again to try once more."
# `step` is the current step's words in lower case without the ellipsis.
INSTALL_CANCELLED = "Install cancelled while {step}. What was already applied stays as Helm left it. Install again to finish, or uninstall the tools."
# Not in the plan's copy list: creating the namespace or writing a CustomResourceDefinition
# failed (`words` is the cluster's refusal in plain words, cloud privacy kept).
INSTALL_STEP_FAILED = (
    "{words} Nothing after this step was installed. Check the cluster, then install again."
)
CREATE_NAMESPACE_STEP = "create the namespace {namespace}"
WRITE_CRD_STEP = "write the CustomResourceDefinition {crd}"
# Not in the plan's copy list: Helm couldn't be started for a release (no kubeconfig could be
# made for it, or the program couldn't run), and Helm's error answer was too long to read.
HELM_NOT_STARTED = "OmniKrux couldn't run Helm to install {release}."
HELM_ANSWER_TOO_LONG = "Helm couldn't {step}, and its answer was too long to read in full."
# Not in the plan's copy list: the CRDs the review counted couldn't be read from the chart again.
CRDS_GONE = "OmniKrux couldn't read the Prometheus Operator's resource definitions from the chart again. Install again."

# Why a workload isn't ready (the job's `blocked` list and INSTALL_NOT_READY's `why`).
NOT_CREATED = "Not created yet"
NOT_READY_YET = "Its Pods aren't ready yet"
READ_REFUSED = "OmniKrux couldn't read it (the cluster answered {status})"
READ_NO_ANSWER = "OmniKrux couldn't read it: the cluster didn't answer"
