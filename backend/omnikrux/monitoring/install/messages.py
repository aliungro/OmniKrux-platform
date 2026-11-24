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
# Until Task 6 adds the install job, a reviewed install can't be applied.
APPLY_NOT_YET = (
    "This version of OmniKrux can review an install but not run it yet. Nothing was installed."
)
