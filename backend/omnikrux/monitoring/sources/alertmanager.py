"""The connector for Alertmanager: a source that holds alerts and silences, never metrics or logs."""

from collections.abc import Sequence

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.series import QueryResult
from omnikrux.monitoring.sources.connector import (
    NOT_LIKE,
    AlertingCapability,
    CatalogLimits,
    ClusterProbe,
    ConnectorQuery,
    FieldCatalog,
    QueryRejected,
    SourceCatalog,
    TestResult,
    json_object,
    status_message,
)
from omnikrux.monitoring.sources.transport import SourceTransport, SourceUnreachable

PROBE_SECONDS = 10.0
WHAT = "an Alertmanager"
NOT_QUERYABLE = "{name} is an Alertmanager: it holds alerts and silences, not metrics or logs."
SENDS_ONLY = "An Alertmanager sends alerts; rules run in Prometheus, Loki or OmniKrux."


class AlertmanagerConnector:
    type = "alertmanager"
    label = "Alertmanager"
    language = "none"

    async def test(self, t: SourceTransport, name: str) -> TestResult:
        try:
            got = await t.request("GET", "/api/v2/status", timeout=PROBE_SECONDS)
        except SourceUnreachable as exc:
            return TestResult(False, None, exc.message)
        if got.status != 200:
            return TestResult(False, None, status_message(name, got.status))
        data = json_object(got.body)
        info = data.get("versionInfo") if data is not None else None
        if not isinstance(info, dict) or not isinstance(info.get("version"), str):
            return TestResult(False, None, NOT_LIKE.format(name=name, what=WHAT))
        return TestResult(True, info["version"], None)

    async def query(self, t: SourceTransport, q: ConnectorQuery, name: str) -> QueryResult:
        raise QueryRejected("bad_query", NOT_QUERYABLE.format(name=name), 400)

    async def describe_fields(
        self, t: SourceTransport, *, matchers: Sequence[Matcher], limit: int = 2000
    ) -> FieldCatalog:
        return FieldCatalog((), (), False)

    async def catalog(
        self,
        t: SourceTransport,
        *,
        matchers: Sequence[Matcher],
        now: float,
        limits: CatalogLimits = CatalogLimits(),  # noqa: B008 (frozen)
    ) -> SourceCatalog:
        return SourceCatalog((), (), (), ())

    async def label_values(
        self,
        t: SourceTransport,
        label: str,
        *,
        matchers: Sequence[Matcher],
        limit: int = 1000,
        selector: str | None = None,
        start: float | None = None,
        end: float | None = None,
    ) -> list[str]:
        return []

    async def alerting(
        self, t: SourceTransport, *, cluster: ClusterProbe | None
    ) -> AlertingCapability:
        return AlertingCapability(False, None, SENDS_ONLY)
