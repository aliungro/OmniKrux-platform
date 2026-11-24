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
# Not in the plan's copy list: Helm stopped before it finished (killed, or OmniKrux stopped), and
# its record still says the change is under way, so Helm refuses any other.
BLOCK_RELEASE_PENDING = "Helm's record of {release} says an earlier change never finished ({status}), so Helm won't change it again. Uninstall the tools, then install them again."
# Not in the plan's copy list: Kubernetes never lets the installed Loki's volume claim change.
BLOCK_LOKI_VOLUME_SIZE = "Loki already keeps its data on a {size} volume, and its size can't change once Loki has it. Set Loki's storage back to {size}, or uninstall the tools and install them again."
BLOCK_LOKI_VOLUME_ADDED = "Loki already runs without a data volume, and one can't be added once Loki runs. Turn off Keep data on volumes, or uninstall the tools and install them again."
BLOCK_LOKI_VOLUME_REMOVED = "Loki already keeps its data on a {size} volume, which can't be taken away once Loki has it. Turn on Keep data on volumes with Loki at {size}, or uninstall the tools and install them again."

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
# HELM_TIMEOUT's `step` for an upgrade ("Helm didn't finish installing omnikrux-loki within ...").
HELM_INSTALLING_STEP = "installing {release}"

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

# The Monitoring tools page: what each Helm release holds, and reading it live (not in the plan's
# copy list: `READ_TOOLS_STEP` completes "Couldn't ...", the pipeline's words for a failed read).
RELEASE_LABELS = {
    "omnikrux-metrics": "Prometheus and Alertmanager",
    "omnikrux-loki": "Loki",
    "omnikrux-alloy": "Grafana Alloy",
}
READ_TOOLS_STEP = "read the monitoring tools in {namespace}"
# A release OmniKrux installed that Helm has no record of any more (its `status`).
RELEASE_MISSING = "missing"
NOT_INSTALLED = "OmniKrux hasn't installed anything in this cluster."

# The uninstall review.
UNINSTALL_TITLE = "Uninstall monitoring tools from {namespace}"
UNINSTALL_LABEL = "Uninstall"
SUMMARY_REMOVES_RELEASES = "Removes the Helm releases {names} from {cluster}."
# Not in the plan's copy list: one release left to remove.
SUMMARY_REMOVES_RELEASE = "Removes the Helm release {names} from {cluster}."
# Not in the plan's copy list: a release with OmniKrux's name that doesn't carry its mark (or
# whose Helm record can't be read) is left in place.
SUMMARY_KEEPS_RELEASE = "Keeps the Helm release {release} in {namespace}: it doesn't carry OmniKrux's mark, so OmniKrux leaves it as it is."
SUMMARY_REMOVES_CONTACTS = "Removes OmniKrux's contact-point settings from its Alertmanager (AlertmanagerConfig and Secret omnikrux-contact-points)."
# Not in the plan's copy list: the review didn't see them, but the job removes them anyway.
SUMMARY_REMOVES_CONTACTS_IF_THERE = "Removes OmniKrux's contact-point settings (AlertmanagerConfig omnikrux-contact-points and its Secret) if they're there."
SUMMARY_REMOVES_SOURCES = "Removes the sources {names}. These projects lose them: {projects}."
SUMMARY_REMOVES_SOURCES_UNUSED = "Removes the sources {names}. No project uses them."
# Not in the plan's copy list: one source (logs alone).
SUMMARY_REMOVES_SOURCE = "Removes the source {names}. These projects lose it: {projects}."
SUMMARY_REMOVES_SOURCE_UNUSED = "Removes the source {names}. No project uses it."
SUMMARY_KEEPS_DATA = (
    'Keeps the stored data ({n} volumes). Turn on "Also delete the stored data" to remove it.'
)
# Not in the plan's copy list: one volume (logs alone).
SUMMARY_KEEPS_DATA_ONE = (
    'Keeps the stored data (1 volume). Turn on "Also delete the stored data" to remove it.'
)
SUMMARY_DELETES_DATA = "Deletes the stored data: {names}. This can't be undone."
# Not in the plan's copy list: the TLS Secret the metrics chart's setup Job makes for its
# admission webhook (not a release object, so Helm leaves it).
SUMMARY_REMOVES_ADMISSION = "Removes the Secret {name} that the metrics chart's setup job made."
SUMMARY_KEEPS_NAMESPACE = "Keeps the namespace {namespace} and the monitoring.coreos.com resource definitions, so objects other tools made aren't touched."
BLOCK_RULES_IN_TOOLS = "Move or remove the alert rules that run in these tools first: {names}. Each opens its own review."

# The uninstall job (each step shown while it runs) and how it ends.
UNINSTALL_STARTED = "Uninstalling the monitoring tools from {namespace}…"
UNINSTALL_NO_JOBS = "OmniKrux is shutting down; nothing was uninstalled."
# Not in the plan's copy list: the record couldn't be marked before the job started.
UNINSTALL_NOT_SAVED = (
    "OmniKrux couldn't save the install record, so nothing was uninstalled. Try again."
)
STEP_HELM_REMOVE = "Removing {release} with Helm…"
STEP_STOP = "Waiting for {label} to stop…"
STEP_REMOVE_CONTACTS = "Removing the contact-point settings…"
STEP_DELETE_DATA = "Deleting the stored data…"
STEP_REMOVE_SOURCES = "Removing the sources…"
UNINSTALLED = "Uninstalled from {namespace}. {kept}"
UNINSTALLED_KEPT = "The stored data stays."
UNINSTALLED_DELETED = "The stored data was deleted."
UNINSTALL_HELM_FAILED = (
    "{helm_words} What Helm removed stays removed. Check {namespace}, then uninstall again."
)
UNINSTALL_CANCELLED = "Uninstall cancelled while {step}. What was already removed stays removed. Uninstall again to finish."
# HELM_FAILED's / HELM_TIMEOUT's `step` for an uninstall.
HELM_UNINSTALL_STEP = "uninstall {release}"
HELM_UNINSTALLING_STEP = "uninstalling {release}"
# Not in the plan's copy list: what can stop the uninstall after Helm ran.
HELM_NOT_STARTED_UNINSTALL = "OmniKrux couldn't run Helm to uninstall {release}."
UNINSTALL_NOT_STOPPED = "{label} was still there after 5 minutes: {why}. What was already removed stays removed. Check {namespace}, then uninstall again."
STILL_STOPPING = "Kubernetes is still removing it"
# Not in the plan's copy list: the Operator's own resources go first, while it still runs; one
# held by a finalizer is named with what it waits for (never removed by force).
STEP_OPERATOR_RESOURCES = "Removing the Prometheus and Alertmanager resources…"
UNINSTALL_STUCK = "The {kind} {name} was still being deleted after 5 minutes; it waits for {waits}. OmniKrux never removes that by force. What was already removed stays removed. Check it in {namespace}, then uninstall again."
NOTHING_NAMED = "nothing it names"
UNINSTALL_STEP_FAILED = (
    "{words} What was already removed stays removed. Check the cluster, then uninstall again."
)
DELETE_OBJECT_STEP = "delete the {kind} {name}"
REMOVE_SOURCE_STEP = "The source {name} couldn't be removed. What was already removed stays removed. Uninstall again to finish."

# Contact points in OmniKrux's own Alertmanager (an AlertmanagerConfig and its Secret, through a
# review).
CONTACTS_CREATE_TITLE = "Send alerts to {n} contact points from {namespace}'s Alertmanager"
# Not in the plan's copy list: one contact point.
CONTACTS_CREATE_TITLE_ONE = "Send alerts to 1 contact point from {namespace}'s Alertmanager"
CONTACTS_UPDATE_TITLE = "Update the contact points in {namespace}'s Alertmanager"
CONTACTS_DELETE_TITLE = "Remove the contact points from {namespace}'s Alertmanager"
CONTACTS_SUMMARY = "Routes alerts from rules that run in Prometheus in {cluster} to OmniKrux's contact points, through the Alertmanager OmniKrux installed."
CONTACTS_LINE = "{name} ({type}) for {rules}"
CONTACTS_SECRET_LINE = (
    "Secret omnikrux-contact-points holds {k} values; they are hidden here and never shown again."
)
# Not in the plan's copy list: one value.
CONTACTS_SECRET_LINE_ONE = (
    "Secret omnikrux-contact-points holds 1 value; it is hidden here and never shown again."
)


def contacts_secret_line(k: int) -> str:
    """The review's line about the Secret's values, in the singular for one."""
    return CONTACTS_SECRET_LINE_ONE if k == 1 else CONTACTS_SECRET_LINE.format(k=k)


# Not in the plan's copy list: the summary of a removal (nothing is left to route).
CONTACTS_DELETE_SUMMARY = "No rule that runs in the tools OmniKrux installed in {cluster} notifies a contact point now, so the AlertmanagerConfig and Secret omnikrux-contact-points are removed."
CONTACTS_SKIPPED = "{name} can't be sent from Alertmanager: {reason}"
EMAIL_TLS_PORT = "Alertmanager uses direct TLS only on port 465. Change the port, or use STARTTLS."
CONTACTS_APPLY_LABEL = "Apply"
CONTACTS_UPDATE_LABEL = "Update"
CONTACTS_REMOVE_LABEL = "Remove"
CONTACTS_STALE = "The contact points or rules changed since you reviewed this. Review it again."
CONTACTS_UPDATED = "Updated the contact points in {namespace}'s Alertmanager."
NO_ALERTMANAGER = "OmniKrux didn't install an Alertmanager in this cluster, so it has nowhere to send contact points."
# Not in the plan's copy list: an object with OmniKrux's name it didn't make, the settings moving
# while the review read them, the change a rule or contact-point save reports, and a contact
# point or source that went while the settings were worked out.
CONTACTS_NOT_OURS = "{kind} {namespace}/omnikrux-contact-points wasn't made by OmniKrux, so OmniKrux won't change or remove it. Remove or rename it with kubectl, then review again."
CONTACTS_RACED = (
    "The contact-point settings in {namespace} changed while OmniKrux read them. Try again."
)
CONTACTS_NEED_REVIEW = "The contact points in {namespace}'s Alertmanager need a review."
CONTACTS_UNKNOWN = "A contact point or source changed while OmniKrux worked out what to send to {namespace}'s Alertmanager. Try again."
CONTACTS_WRITE_SECRET_STEP = "write the Secret {namespace}/omnikrux-contact-points"
CONTACTS_DELETE_SECRET_STEP = "remove the Secret {namespace}/omnikrux-contact-points"
# Fix round 1: a sync only while the tools are installed (not during an install or uninstall, nor
# after one that didn't finish), and only where no other Alertmanager would read the settings.
CONTACTS_UNINSTALLING = "The monitoring tools in {namespace} are being uninstalled, so OmniKrux sends no contact points there."
CONTACTS_INSTALLING = "The monitoring tools in {namespace} are still being installed. Sync the contact points once the install has finished."
CONTACTS_NOT_INSTALLED = "The monitoring tools in {namespace} didn't finish installing. Install again, then sync the contact points."
CONTACTS_OTHER_ALERTMANAGER = "Alertmanager {where} would also read OmniKrux's contact points: its alertmanagerConfigSelector and alertmanagerConfigNamespaceSelector select {namespace}/omnikrux-contact-points, so the addresses and keys would reach it. Narrow those selectors, then review again."
CONTACTS_ALERTMANAGERS_UNCHECKED = "OmniKrux sends contact points only where no other Alertmanager can read them, and it couldn't check that: {words}. Try again."
CONTACTS_LIST_ALERTMANAGERS_STEP = "list the Alertmanagers in the cluster"

# Generated files for Docker hosts and servers: what a field must be, and what the install
# script says when it stops. `$tool` and `$file` are filled in by the script itself.
GENERATE_ADDRESS = "Use a host name or IP address, without http:// or a port."
GENERATE_SERVERS = "Use one host or host:port per line."
SCRIPT_MISSING_TOOL = "Missing $tool. Install it, then run this again."
SCRIPT_ARCH = "This script supports amd64 and arm64 servers."
SCRIPT_CHECKSUM = "Checksum mismatch for $file. Nothing was installed."
# Not in the plan's copy list: the script's other stops.
SCRIPT_NOT_ROOT = "Run this as root, for example with sudo."
SCRIPT_DOWNLOAD = "Couldn't download $file. Check the network, then run this again."
SCRIPT_USAGE = "Usage: $0 --role central|agent [--central ADDRESS] | --uninstall [--purge]"
SCRIPT_NO_SIGN_IN = "These ports have no sign-in: 9090 (Prometheus), 9093 (Alertmanager), 3100 (Loki) and 9100 (node exporter). Keep them on a private network or behind a firewall."
COMPOSE_NO_SIGN_IN = "The published ports (9090, 9093, 3100) have no sign-in. Keep them on a private network or behind a firewall."
SCRIPT_PURGE = "--purge only works together with --uninstall."
