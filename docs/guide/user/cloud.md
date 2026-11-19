# Cloud accounts and clusters

OmniKrux can find the managed Kubernetes clusters of a cloud account and add them next to the clusters from your kubeconfig. It supports four providers:

| Provider | Account is a | Clusters |
| --- | --- | --- |
| Azure | Azure subscription | AKS |
| AWS | AWS account | EKS |
| Google Cloud | Google Cloud project | GKE |
| Oracle Cloud | Oracle Cloud tenancy | OKE |

Discovery only reads from your provider. OmniKrux reads account and cluster metadata and uses short-lived tokens to talk to clusters you add. Operations on Kubernetes objects use the usual [review flow](kubernetes.md#changing-things).

## Connect an account

Open Settings (`Alt 9`), go to **Cloud accounts** and choose **Connect an account**. Pick the provider, then how to sign in:

- **Use my CLI login.** Offered when OmniKrux finds that provider's CLI login folder. The folder must be mounted into the container (see below). Settings lists each login it found, did not find, or could not read.
- **Enter credentials.** Type the credentials in the dialog.

Fields by provider:

| Provider | Use my CLI login | Enter credentials |
| --- | --- | --- |
| Azure | Subscription (pick one) | Subscription ID, Tenant ID, Client ID, Client secret (a service principal) |
| AWS | Profile (pick one), Regions | Access key ID, Secret access key, Regions |
| Google Cloud | Project (pick one) | Project ID, Service account key JSON |
| Oracle Cloud | Profile (default `DEFAULT`), Regions | Tenancy OCID, User OCID, Fingerprint, Private key (PEM), Passphrase (optional), Regions |

Regions are comma-separated, for example `us-east-1, us-west-2` or `us-ashburn-1`. With an AWS CLI login the list may be empty if the profile names a default region; entered credentials always need regions. For a Google service account key or an OCI private key, choose the key file (it is read in the browser and never drawn on screen) or paste it into a masked field with **Show key**. Key files over 64 KB are refused.

OmniKrux checks the login before it connects the account. Entered credentials are encrypted with the console's key before they are stored and are never sent back to the browser. A workload-identity source is not available yet.

Connecting, removing and each cluster you add are written to the [audit log](audit-and-settings.md#audit).

### Mount an existing CLI login

Add the mounts for the providers you use to the usual run command. The destination folders are the image defaults, so keep them as shown.

Linux and macOS:

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -v ~/.kube:/kube:ro -v omnikrux-data:/data \
  -v ~/.azure:/cloud/azure:ro -v ~/.aws:/cloud/aws:ro \
  -v ~/.config/gcloud:/cloud/gcloud:ro -v ~/.oci:/cloud/oci:ro \
  omnikrux:dev
```

Windows PowerShell:

```powershell
docker run --rm -p 127.0.0.1:8080:8080 `
  --add-host=host.docker.internal:host-gateway `
  -v "${env:USERPROFILE}\.kube:/kube:ro" -v omnikrux-data:/data `
  -v "${env:USERPROFILE}\.aws:/cloud/aws:ro" `
  -v "${env:APPDATA}\gcloud:/cloud/gcloud:ro" `
  -v "${env:USERPROFILE}\.oci:/cloud/oci:ro" `
  omnikrux:dev
```

Provider notes:

- **Azure on Windows.** The Azure CLI encrypts its login cache for your Windows user, so the Linux container cannot read it. Use **Enter credentials** with a service principal (subscription ID, tenant ID, client ID and client secret).
- **Google Cloud.** Run `gcloud auth application-default login` on the host so the mounted folder holds Application Default Credentials.
- **Oracle Cloud.** Keep the API signing key and any session token file inside the mounted OCI folder.
- **AWS.** Sign in with `aws configure` or `aws sso login` on the host.
- **Permissions on Linux.** The container runs as uid 10001. If your login files are readable only by you, start the container with `--user "$(id -u):$(id -g)"` and a data directory you own for `/data`. Keep credential files private.
- **Expired logins.** If a login has expired, OmniKrux says which command to run on your machine; run it and use **Check now**.

## Discovered clusters

After an account is connected, OmniKrux checks it for clusters right away, then every 600 seconds by default. Change the interval with `-e OMNIKRUX_CLOUD_DISCOVERY_SECONDS=900` (a whole number of at least 60; OmniKrux refuses to start otherwise). **Check now** on an account in Settings checks it immediately. A check that does not finish within 60 seconds is reported as such.

Review what was found under **Discovered clusters** on Kubernetes Home. In Pods, a **New clusters found** notice links to the same list. Each account has its own group showing, for every cluster, the region, Kubernetes version, node pools, an environment label (Production or Development, when OmniKrux can tell from tags or the name) and its state:

| State | Meaning |
| --- | --- |
| New | Found and not added yet |
| In OmniKrux | Already added |
| Dismissed | You dismissed it |
| Can't add: ... | Not addable, with the reason (for example a private API endpoint, or an AKS cluster that uses local accounts instead of Microsoft Entra ID) |

Tick clusters (up to 50 at a time) and choose **Add N clusters**. Clusters that fail to add are listed with the reason; the rest are added. **Dismiss** hides new clusters you do not want. A cluster the last check no longer found says "Not found at the last check" and cannot be added until it is found again.

Private clusters (an API endpoint the console cannot reach directly) cannot be added yet.

## Remove accounts and clusters

In Settings:

- Removing a **cloud cluster** removes it from OmniKrux and dismisses its discovery entry. Nothing changes in the cloud.
- Removing a **cloud account** disconnects its clusters from OmniKrux too. Nothing changes in the cloud.

## Kubeconfigs that use cloud login plugins

The image includes `kubelogin` and `gke-gcloud-auth-plugin` for kubeconfigs that name those executables, and OmniKrux handles the token commands of `aws`, `aws-iam-authenticator` and `oci` itself when those CLIs are not installed. Importing a kubeconfig runs its `exec` command on every connection, so import only kubeconfigs you trust. The command never receives OmniKrux's own `OMNIKRUX_*` settings, such as the secret key.
