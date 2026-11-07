"""Edit: replace an object with the YAML the user edited.

The plan reads the YAML, checks it is still the same object (kind, name, namespace) at the
version the user opened (its `resourceVersion`), and asks the API server for a dry run of the
replace, so the diff shows what the server would store (defaults filled in, fields it drops
gone). The apply is the same PUT, carrying that `resourceVersion`: if the object moved on since,
the API server refuses with a 409 and the user reads the conflict copy. Secrets are never edited:
their YAML reaches the browser masked."""

import copy

import yaml
from kubernetes_asyncio.client import ApiClient

from omnikrux.actions.pipeline import (
    CONFLICT,
    CONFLICT_STATUS,
    SECRET_EDIT,
    ActionError,
    Applied,
    ApplyContext,
    Planned,
    Target,
)
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.resources.kinds import KindSpec
from omnikrux.resources.yaml_out import SERVER_FIELDS, is_secret_resource

IDENTITY = (
    "An edit can't change the kind, name or namespace. Create a new object with kubectl instead."
)
NOTHING_CHANGES = "Nothing changes: the edited YAML matches the cluster."
NOT_TEXT = "Send the edited YAML as text."
UNREADABLE = "The edited YAML can't be read: {problem}. Fix it and review again."
NOT_ONE_OBJECT = "The edited YAML must hold one object, a mapping such as the YAML tab shows."
NO_VERSION = (
    "The edited YAML has no metadata.resourceVersion, so Omnikrux can't tell whether it was "
    "made from the object as it is now. Open the YAML again and edit that."
)
NOT_UPDATABLE = "{kind} objects can't be edited on this cluster: it doesn't allow updates."


class _JsonLoader(yaml.SafeLoader):
    """YAML as Kubernetes reads it: a timestamp stays text, as JSON has no timestamps."""


_JsonLoader.yaml_implicit_resolvers = {
    first: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def _parse(text: object) -> dict:
    """The one object the YAML holds; ActionError (422) in plain words otherwise."""
    if not isinstance(text, str):
        raise ActionError(422, NOT_TEXT)
    try:
        documents = [d for d in yaml.load_all(text, Loader=_JsonLoader) if d is not None]
    except yaml.YAMLError as exc:
        raise ActionError(422, UNREADABLE.format(problem=_yaml_problem(exc))) from None
    if len(documents) != 1 or not isinstance(documents[0], dict):
        raise ActionError(422, NOT_ONE_OBJECT)
    return documents[0]


def _yaml_problem(exc: yaml.YAMLError) -> str:
    problem = getattr(exc, "problem", None) or "it isn't valid YAML"
    mark = getattr(exc, "problem_mark", None)
    if mark is None:
        return problem
    return f"{problem} (line {mark.line + 1}, column {mark.column + 1})"


def _reviewed(obj: dict) -> dict:
    """What the user reviews of an object: no status and none of the fields the server sets."""
    out = copy.deepcopy(obj)
    out.pop("status", None)
    metadata = out.get("metadata")
    if isinstance(metadata, dict):
        for name in SERVER_FIELDS:
            metadata.pop(name, None)
    return out


class EditAction:
    kinds = None  # any kind the cluster lets us update, but never a Secret

    async def plan(self, api: ApiClient, spec: KindSpec, target: Target, params: dict) -> Planned:
        if is_secret_resource(spec):
            raise ActionError(422, SECRET_EDIT)
        if "update" not in spec.verbs:
            raise ActionError(422, NOT_UPDATABLE.format(kind=spec.kind))
        body = _parse(params.get("yaml"))
        metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
        if (
            body.get("kind") != spec.kind
            or metadata.get("name") != target.name
            or (metadata.get("namespace") or None) != target.namespace
        ):
            raise ActionError(422, IDENTITY)
        path = spec.object_path(target.namespace, target.name)
        live = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
        version = metadata.get("resourceVersion")
        if version is None:
            raise ActionError(422, NO_VERSION)
        if str(version) != (live.get("metadata") or {}).get("resourceVersion"):
            raise ActionError(CONFLICT_STATUS, CONFLICT.format(kind=spec.kind, name=target.name))
        metadata["resourceVersion"] = str(version)  # typed unquoted, YAML reads a number
        dry_run = await call_json(
            api, "PUT", path, timeout=REQUEST_TIMEOUT, query=(("dryRun", "All"),), body=body
        )
        where = f"{target.namespace}/{target.name}" if target.namespace else target.name
        return Planned(
            title=f"Edit {spec.kind} {target.name}",
            summary=[f"Save the edited YAML of {spec.kind} {where}."],
            blocked=[NOTHING_CHANGES] if _reviewed(live) == _reviewed(dry_run) else [],
            before=live,
            after=dry_run,
            apply_label="Save",
            state={"body": body},
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        # The body carries the resourceVersion the plan checked: the API server refuses (409)
        # if the object changed since.
        path = spec.object_path(target.namespace, target.name)
        await call_json(ctx.api, "PUT", path, timeout=REQUEST_TIMEOUT, body=planned.state["body"])
        where = f"{target.namespace}/{target.name}" if target.namespace else target.name
        return Applied(f"Saved {spec.kind} {where}.")
