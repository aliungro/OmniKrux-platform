"""What OmniKrux says when it can't reach a source. `{name}` is the source's name and `{cluster}`
the name of the cluster it is reached through. None of these ever carries a secret, a response
body or (for cloud clusters) the cluster's endpoint."""

REFUSED = "Can't reach {name}: the connection was refused. Check the address and that the tool is running."
NO_HOST = "Can't reach {name}: its host name doesn't resolve. Check the address."
TIMEOUT = (
    "{name} didn't answer within {seconds} seconds. Check that the tool is running and reachable."
)
TLS = "Can't open a secure connection to {name}: {reason}. Check the certificate settings."
REJECTED = "{name} rejected the credentials (HTTP {status}). Check the source's authentication."
REDIRECT = "{name} answered with a redirect. Use the address it redirects to."
TOO_LARGE = "{name} sent more than 32 MB. Narrow the query or the time range."
NO_ENDPOINTS = "{name} has no running Pods behind its service in {cluster}. Check the tool's Pods."
FORBIDDEN = "Not allowed to reach {name} through {cluster}: the cluster login needs permission to proxy services."
UNKNOWN_CLUSTER = "{name} runs in a cluster OmniKrux no longer knows. Connect the cluster again or remove the source."

# Not in the copy list of the plan; needed for failures none of the above describes.
DROPPED = "Can't reach {name}: the connection broke before it answered. Check the address and that the tool is running."
BAD_ADDRESS = (
    "{name} has a service, port or path prefix OmniKrux can't use. Check the source's address."
)
BAD_HEADER = "{name} has a header OmniKrux can't send. Check the source's custom headers."
CLUSTER_AUTH = "{name} is reached through a cluster, which can't send credentials or custom headers. Set Authentication to None and remove the headers."
