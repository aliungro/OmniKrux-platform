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
