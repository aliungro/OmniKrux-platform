# Releasing

OmniKrux ships as one Docker image. Each app is versioned on its own, with a git tag named after the app.

## Versions and tags

| App | Tag pattern | Current |
| --- | --- | --- |
| Kubernetes | `kubernetes-v<version>` | `kubernetes-v0.1.0-alpha.1` |
| Monitoring | `monitoring-v<version>` | Not released; in development |

A tag marks the commit that is that app's release. The matching image is tagged the same way, for example `omnikrux:kubernetes-v0.1.0-alpha.1`. A change to one app does not move another app's tag. The version fields inside `backend/pyproject.toml` (`0.1.0`) and `frontend/package.json` (`0.0.0`) are not what the release is called; the git tag is.

## Before you tag

1. Be on the commit you mean to release, with a clean working tree.
2. Run every gate in [Testing](testing.md): the backend suite, ruff check and format check, `npm test` and `npm run build`.
3. Build the image from that commit (below) and run it at least once against a real kubeconfig.
4. If the cloud adapters changed, consider the optional `cloud_live` checks.

## Build the image

From the repository root:

```bash
docker build -t omnikrux:kubernetes-v0.1.0-alpha.1 .
```

The build installs and builds the frontend (`npm ci`, `npm run build`, which includes the startup budget check), downloads and checksum-verifies the `kubelogin` and `gke-gcloud-auth-plugin` binaries for the target architecture, and installs the backend with `uv sync --frozen --no-dev`. The final image runs as uid 10001 and starts `uvicorn omnikrux.main:app` on port 8080.

Run it with the commands in [Getting started](../user/getting-started.md), replacing `omnikrux:dev` with the tag you built.

## Tag and push

The existing tag is annotated. Create new ones the same way, on the release commit:

```bash
git tag -a kubernetes-v0.1.0-alpha.2 -m "Kubernetes app 0.1.0-alpha.2"
git push origin kubernetes-v0.1.0-alpha.2
```

(`kubernetes-v0.1.0-alpha.2` is only an example of the next name.) Push the branch the release commit lives on in the same way, as `git push origin <branch>`.

## Where it goes

The remote `origin` is the private repository `aliungro/omnikrux-platform` (`https://github.com/aliungro/omnikrux-platform.git`). Releases are tags in that repository; the build above is a local image, and nothing in the repository publishes it to a registry.

## Merging into main

Merges into `main` are the owner's decision. Work happens on branches (and git worktrees under `.superpowers/worktrees/`); open or push the branch, say what it contains, and leave the merge to the owner. Do not tag from a branch that has not been merged unless the owner asks for it.
