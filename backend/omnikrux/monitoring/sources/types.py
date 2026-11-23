"""What a Monitoring source is, inside the backend.

`SourceConfig` carries decrypted secrets and never leaves the backend: API responses are built
from it field by field and only ever say whether a secret is set."""

import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

SourceType = Literal["prometheus", "loki", "alertmanager"]
Reach = Literal["url", "cluster"]
AuthType = Literal["none", "basic", "bearer", "api_key", "mtls"]
ProjectKind = Literal["kubernetes", "docker", "servers", "custom"]
FilterOrigin = Literal["auto", "user", "none"]

MAX_NAME = 80
NAME_RULE = "Names are 1 to 80 characters, without line breaks."


class NameTaken(Exception):
    """A source, project or group of that name already exists."""

    def __init__(self, kind: str, name: str) -> None:
        super().__init__(f'A {kind} named "{name}" already exists. Pick another name.')
        self.kind = kind
        self.name = name


def clean_name(name: str) -> str:
    """The name trimmed; ValueError when it is empty, too long or holds control characters."""
    name = name.strip()
    if not 1 <= len(name) <= MAX_NAME or any(unicodedata.category(c) == "Cc" for c in name):
        raise ValueError(NAME_RULE)
    return name


@dataclass(frozen=True)
class ClusterTarget:
    """A tool inside a known cluster, reached through that cluster's service proxy."""

    cluster_id: str
    namespace: str
    service: str
    port: str
    scheme: Literal["http", "https"]


@dataclass(frozen=True)
class SourceSecrets:
    """Decrypted secret values. Never printed: every field is left out of the repr."""

    password: str | None = field(default=None, repr=False)
    token: str | None = field(default=None, repr=False)
    api_key: str | None = field(default=None, repr=False)
    client_key_pem: str | None = field(default=None, repr=False)
    headers: Mapping[str, str] = field(default_factory=dict, repr=False)  # name -> value


# The secret each authentication type uses; any other is dropped when the type changes.
AUTH_SECRET: dict[str, str | None] = {
    "none": None,
    "basic": "password",
    "bearer": "token",
    "api_key": "api_key",
    "mtls": "client_key_pem",
}


@dataclass(frozen=True)
class SourceCheck:
    ok: bool
    message: str | None
    version: str | None
    checked_at: datetime


@dataclass(frozen=True)
class SourceConfig:
    id: str
    name: str
    type: SourceType
    reach: Reach
    url: str | None
    cluster: ClusterTarget | None
    path_prefix: str
    auth_type: AuthType
    username: str | None
    header_name: str | None
    client_cert_pem: str | None
    ca_pem: str | None
    header_names: tuple[str, ...]
    secrets: SourceSecrets
    created_by_project_id: str | None
    created_at: datetime
    updated_at: datetime
    check: SourceCheck | None
    # The stored secrets can't be decrypted (the key changed): `secrets` is empty and the user
    # has to enter them again.
    secrets_unreadable: bool = False
    # OmniKrux installed this tool itself (M5); only then may contact-point secrets go into it.
    installed_by_omnikrux: bool = False
