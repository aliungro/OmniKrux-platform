from pathlib import Path

PRIVATE = (
    "Private API endpoint: the console can't reach it directly. "
    "Private clusters arrive with the in-cluster agent."
)
AKS_LOCAL_ACCOUNTS = (
    "This cluster uses local accounts, not Microsoft Entra ID. Omnikrux signs in to AKS only "
    "with short-lived Entra tokens: turn on Entra ID integration, or import its kubeconfig."
)
WORKLOAD = "Workload identity arrives with deployed mode."
UNKNOWN_ACCOUNT = "This cloud account is no longer connected. Refresh Cloud accounts and try again."
UNKNOWN_DISCOVERED = (
    "This cluster is no longer in the discovery list. Refresh the list and try again."
)
DISCOVERED_MISSING = (
    "The last check didn't find this cluster. Check the account again before adding it."
)
DISCOVERY_CHANGED = "The cluster discovery changed. Refresh the list and try adding it again."
ACCOUNT_SAVE_FAILED = "Couldn't save the cloud account in Omnikrux. Try again."
ACCOUNT_REMOVE_FAILED = "Couldn't remove the cloud account from Omnikrux. Try again."
CLUSTER_ADD_FAILED = "Couldn't add the cloud cluster to Omnikrux. Check the cluster and try again."
CHECK_FAILED = "Couldn't check the cloud account. Check the login, then try again."
CHECK_TIMED_OUT = "The cloud account check didn't finish within 60 s. Try again in a minute."
ACCOUNT_KINDS = {
    "azure": "Azure subscription",
    "aws": "AWS account",
    "gcp": "Google Cloud project",
    "oci": "Oracle Cloud tenancy",
}
ACCOUNT_REMOVED = (
    "The cloud account this cluster belonged to was removed. "
    "Remove the cluster too, or connect the account again."
)
CLOUD_CLUSTER_ENDPOINT_INVALID = (
    "The cloud cluster has an invalid API endpoint. Check that it uses HTTPS, then try again."
)
NOT_GCP_SERVICE_ACCOUNT_KEY = (
    "That isn't a Google service-account key: paste the JSON file you downloaded "
    "for the service account."
)
UNREADABLE_OCI_PRIVATE_KEY = (
    "That private key can't be read: check it is the PEM file for this API key, and its passphrase."
)


def gke_api_disabled(project: str) -> str:
    return (
        f"The Kubernetes Engine API isn't enabled in {project}, so there are no GKE clusters "
        "to list. Enable it in the Google Cloud console if you expected some."
    )


def missing_login(cli: str, path: Path, login: str) -> str:
    return (
        f"No {cli} login found at {path}. Sign in with `{login}` on this machine "
        "and mount the folder into the container (see the README), or enter credentials instead."
    )


def aws_missing_login(path: Path) -> str:
    return (
        f"No AWS CLI login found at {path}. Sign in with `aws configure` or `aws sso login` "
        "on this machine and mount the folder into the container (see the README), or enter "
        "credentials instead."
    )


def unreadable_login(path: Path) -> str:
    return (
        f"Found {path}, but the console can't read it (permission denied). "
        "Run the container as your own user, as the README shows."
    )


def expired_login(cli: str, login: str) -> str:
    return f"Your {cli} login has expired. Run `{login}` on this machine, then try again."


def windows_azure_cache() -> str:
    return (
        "Your Azure CLI login is encrypted for your Windows account, so the console's container "
        "can't read it. Connect with a service principal instead "
        "(Settings → Cloud accounts → Enter credentials)."
    )


def no_adc() -> str:
    return (
        "Found a gcloud login, but no application-default credentials. Run "
        "`gcloud auth application-default login` on this machine, then try again."
    )


def credential_process(profile: str) -> str:
    return (
        f"AWS profile {profile} gets its keys from a program (credential_process), "
        "which the console can't run. Use a profile with keys or SSO, or enter an access key."
    )


def oci_key_file(profile: str, path: str, basename: str) -> str:
    return (
        f"OCI profile {profile} points at the key file {path}, which isn't in the mounted folder. "
        f"Put {basename} next to the OCI config, then try again."
    )


def refused(cloud: str, action: str, reason: str) -> str:
    return (
        f"{cloud} refused access while trying to {action}: {reason}. "
        "Check the login's permissions, then try again."
    )


def not_found(cloud: str, action: str, reason: str, id_label: str) -> str:
    return (
        f"{cloud} says it doesn't exist while trying to {action}: {reason}. Check the {id_label}."
    )


def throttled(cloud: str, action: str) -> str:
    return (
        f"{cloud} is limiting requests while trying to {action}. "
        "Omnikrux tries again at the next check."
    )


def server_error(cloud: str, action: str, status: int) -> str:
    return f"{cloud} had a problem while trying to {action} ({status}). Try again in a minute."


def unreachable(cloud: str, action: str, os_error: str) -> str:
    return (
        f"Can't reach {cloud} while trying to {action}: {os_error}. "
        "Check the network, then try again."
    )


def timeout(cloud: str, action: str) -> str:
    return f"{cloud} didn't answer within 20 s while trying to {action}. Try again in a minute."


def region_problem(region: str, message: str) -> str:
    return f"Couldn't list clusters in {region}: {message}"


def missing_from_cloud(account: str) -> str:
    return (
        f"Not found in {account} any more: it may have been deleted. "
        "Remove it from Omnikrux under Settings."
    )


def already_connected(account_kind: str, name: str) -> str:
    return f"This {account_kind} is already connected as {name}."


def unsupported_exec(
    command: str, subcommand: str | None, supported: str, account_kind: str
) -> str:
    invocation = f"{command} {subcommand}" if subcommand else command
    return (
        f"This cluster signs in with '{invocation}', which the console can't run: "
        f"it only runs '{supported}'. Connect the {account_kind} under Settings instead."
    )


def unsupported_kubelogin(mode: str) -> str:
    return (
        f"This AKS cluster signs in with kubelogin's {mode} login, which needs a browser or the "
        "Azure CLI, and the console has neither. Connect the subscription under Settings, or "
        "convert the kubeconfig with `kubelogin convert-kubeconfig -l spn`."
    )


def failed_exec(command: str, reason: str) -> str:
    return f"This cluster signs in with '{command}', which failed: {reason}"
