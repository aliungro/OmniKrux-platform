"""The one way an object becomes YAML text, and the one place Secret values are masked.

Every YAML Omnikrux shows or stores (the YAML tab, a plan's before/after, the audit diff) goes
through `dump_yaml`, which masks any core v1 Secret: each `data` and `stringData` value becomes
`•••••• ({n} bytes)` and the `last-applied-configuration` annotation (which holds the values) is
dropped. Callers that know they hold a Secret without `kind`/`apiVersion` pass `secret=True`;
`is_secret_resource` says so for a kind spec (helm-releases are Secrets too)."""

import base64
import binascii
import copy
import difflib
from typing import Any

import yaml

from omnikrux.resources.kinds import KindSpec

MASK = "•••••• ({n} bytes)"
LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration"
DIFF_LIMIT = 64 * 1024  # bytes of unified diff kept in a plan or an audit record
DIFF_CUT = "… (diff cut at 64 KB)"
# Set by the API server, so not part of what a user reviews or edits.
SERVER_FIELDS = ("managedFields", "resourceVersion", "generation", "uid", "creationTimestamp")


def is_secret_resource(spec: KindSpec) -> bool:
    """Whether the kind's objects are core Secrets, whatever its key (`secrets`, helm-releases)."""
    return spec.group == "" and spec.plural == "secrets"


def is_secret_object(obj: Any) -> bool:
    return isinstance(obj, dict) and obj.get("kind") == "Secret" and obj.get("apiVersion") == "v1"


def value_size(value: Any, *, encoded: bool) -> int:
    """How many bytes a Secret value holds: `data` values are base64, `stringData` plain text."""
    if not isinstance(value, str):
        return 0
    if encoded:
        try:
            return len(base64.b64decode(value, validate=True))
        except (binascii.Error, ValueError):
            pass
    return len(value.encode())


def mask_secret(obj: dict) -> dict:
    """A copy with every `data` and `stringData` value masked and last-applied dropped."""
    out = copy.deepcopy(obj)
    for field, encoded in (("data", True), ("stringData", False)):
        values = out.get(field)
        if isinstance(values, dict):
            out[field] = {
                key: MASK.format(n=value_size(value, encoded=encoded))
                for key, value in values.items()
            }
        elif values is not None:
            out[field] = MASK.format(n=0)
    metadata = out.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("annotations"), dict):
        metadata["annotations"].pop(LAST_APPLIED, None)
        if not metadata["annotations"]:
            del metadata["annotations"]
    return out


def dump_yaml(obj: Any, *, secret: bool = False) -> str:
    """The one YAML dump: keys in the object's order, non-ASCII text as it is, and a Secret
    (`secret=True`, or any object that says it is one) masked."""
    if isinstance(obj, dict) and (secret or is_secret_object(obj)):
        obj = mask_secret(obj)
    return yaml.safe_dump(obj, sort_keys=False, allow_unicode=True)


def to_yaml(obj: dict, *, secret: bool = False) -> str:
    """The object as a user reviews it: without status and the fields the server sets."""
    out = copy.deepcopy(obj)
    out.pop("status", None)
    metadata = out.get("metadata")
    if isinstance(metadata, dict):
        for name in SERVER_FIELDS:
            metadata.pop(name, None)
    return dump_yaml(out, secret=secret)


def diff_text(before: str, after: str) -> str:
    """A unified diff, cut at a line boundary once it passes 64 KB. Build both sides with
    `to_yaml`/`dump_yaml`, so a Secret's values never reach it."""
    text = "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile="before",
            tofile="after",
        )
    )
    data = text.encode()
    if len(data) <= DIFF_LIMIT:
        return text
    kept = data[:DIFF_LIMIT].decode("utf-8", "ignore")
    return kept[: kept.rfind("\n") + 1] + DIFF_CUT
