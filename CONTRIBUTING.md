# Contributing to OmniKrux

Thanks for helping. Issues, ideas and pull requests are all welcome.

## How work gets in

Anyone can open an issue or send a pull request from their own fork. Only the maintainers can merge into `main`, and every pull request is reviewed before it is merged.

1. **Start with an issue** for anything bigger than a small fix, so we can agree on the approach before you write code.
2. **Fork the repository** and create a branch for your change.
3. **Make the change** with tests. [Developer setup](docs/guide/developer/setup.md) gets you running, and [testing](docs/guide/developer/testing.md) lists the checks a change must pass.
4. **Open a pull request** that says what changed and why, and links the issue.
5. **Sign the Contributor License Agreement** when the bot asks on your first pull request (see below).
6. A maintainer reviews it. Expect questions; small, focused pull requests are reviewed fastest.

## Reporting bugs and asking for features

Open an issue with what you did, what you expected and what happened instead, plus your OmniKrux version or commit, how you run it (Docker, OS) and the kind of cluster. Leave out secrets, kubeconfigs and anything private.

Security problems are different: report them privately as described in [SECURITY.md](SECURITY.md), never in a public issue. Questions and ideas that are not yet a clear request go to [Discussions](https://github.com/omnikrux/omnikrux/discussions).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Guidelines

- Keep a pull request to one change. Refactors go in their own pull request.
- Follow the style of the code around you; the [architecture guide](docs/guide/developer/architecture.md) explains how the parts fit together.
- Every change that alters what people see needs tests, and user-facing changes need the matching [guide](docs/guide/README.md) updated.
- Write user-facing text in plain words. The product name is OmniKrux in text and `omnikrux` in code.
- Never commit credentials, kubeconfigs, real cluster names or personal data, also not in tests.

## Licensing of contributions

OmniKrux is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

Before your first contribution can be merged, you sign the [Contributor License Agreement](CLA.md). You keep the copyright in your work. The agreement lets the project use your contribution under the AGPL and also under other terms, for example a commercial license, which keeps the project able to fund its development. It also promises that your contribution stays available under an open-source license as part of OmniKrux.

Signing takes one comment on your pull request when the bot asks for it.
