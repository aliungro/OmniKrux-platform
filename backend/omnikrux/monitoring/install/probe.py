"""Whether the tools at the addresses a user gives answer. The same transport and test the
sources use (a direct address, never following a redirect); nothing is stored."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.health import run_test
from omnikrux.monitoring.sources.transport import validate_url
from omnikrux.monitoring.sources.types import SourceConfig, SourceSecrets

PROBE_SECONDS = 5.0
TOOL_NAMES = {"prometheus": "Prometheus", "alertmanager": "Alertmanager", "loki": "Loki"}


class ProbeToolIn(BaseModel):
    type: Literal["prometheus", "alertmanager", "loki"]
    url: str = Field(max_length=2048)


class ProbeIn(BaseModel):
    """The addresses are checked by `check` (not by pydantic), so a problem comes back in words."""

    tools: list[ProbeToolIn] = Field(min_length=1, max_length=3)


class ProbeResultOut(BaseModel):
    type: Literal["prometheus", "alertmanager", "loki"]
    url: str
    ok: bool
    version: str | None
    message: str | None


class ProbeOut(BaseModel):
    results: list[ProbeResultOut]


def check(body: ProbeIn) -> None:
    """ValueError with the words when an address can't be a tool's."""
    for tool in body.tools:
        validate_url(tool.url)


def _config(tool: ProbeToolIn) -> SourceConfig:
    now = datetime.now(UTC)
    return SourceConfig(
        id="",
        name=TOOL_NAMES[tool.type],
        type=tool.type,
        reach="url",
        url=tool.url,
        cluster=None,
        path_prefix="",
        auth_type="none",
        username=None,
        header_name=None,
        client_cert_pem=None,
        ca_pem=None,
        header_names=(),
        secrets=SourceSecrets(),
        created_by_project_id=None,
        created_at=now,
        updated_at=now,
        check=None,
    )


async def _probe_one(services: MonitoringServices, tool: ProbeToolIn) -> ProbeResultOut:
    config = _config(tool)
    result = await run_test(
        services.connectors.get(tool.type),
        services.transports.for_source(config),
        config.name,
        PROBE_SECONDS,
    )
    return ProbeResultOut(
        type=tool.type, url=tool.url, ok=result.ok, version=result.version, message=result.message
    )


async def probe(services: MonitoringServices, body: ProbeIn) -> ProbeOut:
    results = await asyncio.gather(*(_probe_one(services, tool) for tool in body.tools))
    return ProbeOut(results=list(results))
