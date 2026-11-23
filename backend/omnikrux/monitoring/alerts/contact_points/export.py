"""The one way a contact point's secrets leave OmniKrux: into an Alertmanager that OmniKrux
installed itself (M5 writes them into its receivers). Every other tool is refused. No route calls
this in M4."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from omnikrux.monitoring.alerts.contact_points.types import ContactPointType, SecretsUnreadable

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

SECRET_RULE = (
    "Contact-point secrets go only into tools OmniKrux installed. "
    "{source} wasn't installed by OmniKrux."
)


class SecretRuleRefused(Exception):
    """The tool wasn't installed by OmniKrux (or isn't an Alertmanager); nothing was read."""

    def __init__(self, source: str) -> None:
        super().__init__(SECRET_RULE.format(source=source))
        self.message = SECRET_RULE.format(source=source)


@dataclass(frozen=True)
class ReceiverExport:
    contact_point_id: str
    name: str
    type: ContactPointType
    settings: Mapping[str, object]
    secrets: Mapping[str, str] = field(repr=False)


async def export_receivers(
    services: MonitoringServices,
    *,
    alertmanager_source_id: str,
    contact_point_ids: Sequence[str],
) -> list[ReceiverExport]:
    """The contact points with their secrets, for the Alertmanager source OmniKrux installed.
    SecretRuleRefused for any other source (checked before any contact point is read);
    KeyError for an unknown source; UnknownContactPoint for an unknown id; SecretsUnreadable for
    a contact point whose secrets can't be decrypted."""
    source = await services.sources.get(alertmanager_source_id)
    if source.type != "alertmanager" or not source.installed_by_omnikrux:
        raise SecretRuleRefused(source.name)
    exports: list[ReceiverExport] = []
    for id in contact_point_ids:
        cp = await services.contact_points.get(id)
        if cp.secrets_unreadable:
            raise SecretsUnreadable(cp.name)
        exports.append(
            ReceiverExport(
                contact_point_id=cp.id,
                name=cp.name,
                type=cp.type,
                settings=dict(cp.settings),
                secrets=dict(cp.secrets),
            )
        )
    return exports
