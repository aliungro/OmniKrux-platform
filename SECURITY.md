# Security

## Reporting a problem

Please report security problems privately: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for them.

Say what you found, how to reproduce it, and which version or commit you used. You will get an answer as soon as possible, and a fix or a plan before anything is made public.

## Supported versions

OmniKrux is in early alpha. Fixes go into `main` and the next release of each app; older alpha tags are not patched.

## Known limits (by design, for now)

- OmniKrux has no login yet. Anyone who can reach its port can see and change every cluster in the mounted kubeconfig, so the documented commands publish it on `127.0.0.1` only. Exposing it to a network is not supported.
- Importing a kubeconfig runs its `exec` credential command on every connection. Import only kubeconfigs you trust.
- A node shell starts a privileged pod on the node you choose.

Reports about these limits are still welcome when you find a way around the protections that are in place: the `127.0.0.1` binding and the host check, the refusal of changes from other web origins, the review before every change, secret masking, and the audit log.
