"""The connector registry."""

import pytest

from omnikrux.monitoring.sources.connector import (
    ConnectorRegistry,
    UnknownSourceType,
    default_connectors,
)
from omnikrux.monitoring.sources.prometheus import PrometheusConnector


def test_registry_rejects_duplicates_and_unknown_types():
    registry = default_connectors()
    assert registry.types() == ["prometheus", "loki", "alertmanager"]
    assert registry.get("loki").label == "Loki"
    assert registry.get("prometheus").language == "promql"
    with pytest.raises(ValueError):
        registry.register(PrometheusConnector())
    with pytest.raises(UnknownSourceType) as caught:
        registry.get("graphite")
    assert caught.value.message == 'There\'s no connector for "graphite" sources.'


def test_an_empty_registry_has_no_types():
    assert ConnectorRegistry().types() == []


async def test_services_carry_the_connectors(monitoring_app):
    _, app = monitoring_app
    assert app.state.monitoring.connectors.types() == ["prometheus", "loki", "alertmanager"]
