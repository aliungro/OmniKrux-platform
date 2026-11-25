"""Loki label discovery: which label set (OpenTelemetry or classic) a Loki's streams carry, which
labels name a line's level and group its streams, and how a project's labels are read: under its
filter, over the last 7 days, saying why when they can't be."""

from omnikrux.monitoring.dashboards.loki_labels import (
    CLASSIC,
    GROUP_FALLBACK,
    LEVEL_LABELS,
    OTEL,
    LokiFacts,
    group_label,
    level_label,
    pick_label_set,
    read_loki_facts,
)
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.sources.connector import LOKI_LABEL_WINDOW
from omnikrux.monitoring.sources.loki import LokiConnector

API = "/api/monitoring"
NOW = 1_800_000_000.0
NS = 1_000_000_000


def labels(*names: str) -> frozenset[str]:
    return frozenset(names)


def test_label_set_needs_both_labels():
    # The test cluster: `namespace` only on old lines, the full OpenTelemetry set on new ones.
    assert pick_label_set(labels("namespace", "k8s_namespace_name", "k8s_pod_name")) == OTEL
    assert pick_label_set(labels("namespace", "job")) is None
    assert pick_label_set(labels("namespace", "pod")) == CLASSIC
    both = labels("namespace", "pod", "k8s_namespace_name", "k8s_pod_name")
    assert pick_label_set(both) == OTEL
    assert pick_label_set(labels("k8s_namespace_name", "pod")) is None
    assert pick_label_set(labels()) is None
    assert OTEL.style == "otel" and OTEL.container == "k8s_container_name"
    assert OTEL.app == "service_name"
    assert (CLASSIC.style, CLASSIC.namespace, CLASSIC.pod) == ("classic", "namespace", "pod")
    assert (CLASSIC.container, CLASSIC.app) == ("container", "app")


def test_level_and_group_labels():
    assert LEVEL_LABELS == ("level", "detected_level", "severity")
    assert level_label(labels("severity", "level", "job")) == "level"
    assert level_label(labels("severity", "detected_level")) == "detected_level"
    assert level_label(labels("severity")) == "severity"
    assert level_label(labels("job", "namespace")) is None

    assert GROUP_FALLBACK == ("service_name", "app", "job", "container", "k8s_container_name")
    every = labels(*GROUP_FALLBACK)
    for name in GROUP_FALLBACK:
        assert group_label(every) == name
        every = every - {name}
    # None of them: the first label by name that isn't Loki's own (`__…`).
    assert group_label(labels("__stream_shard__", "zone", "host")) == "host"
    assert group_label(labels("__stream_shard__")) is None
    assert group_label(labels()) is None


async def loki_project(http, loki_url: str, filter: str | None = 'cluster="a"') -> str:
    source = await http.post(
        f"{API}/sources",
        json={"type": "loki", "reach": "url", "url": loki_url, "name": "Shop logs"},
    )
    assert source.status_code == 201, source.text
    sources = [{"source_id": source.json()["id"], "filter": filter or ""}]
    project = await http.post(
        f"{API}/setup", json={"name": "Shop web", "kind": "custom", "sources": sources}
    )
    assert project.status_code == 201, project.text
    return project.json()["id"]


async def facts_of(app, pid: str) -> LokiFacts | None:
    services = app.state.monitoring
    project = await services.projects.get(pid)
    configs = [await services.sources.get(link.source_id) for link in project.links]
    return await read_loki_facts(services, project, configs, NOW)


async def test_read_facts_uses_the_filter_and_the_window(monitoring_app, fake_loki):
    http, app = monitoring_app
    pid = await loki_project(http, fake_loki.url)
    fake_loki.series = [
        {"k8s_namespace_name": "shop", "k8s_pod_name": "api-1", "level": "info"},
        {"namespace": "shop", "job": "shop/api", "__stream_shard__": "1"},
    ]
    fake_loki.requests.clear()
    facts = await facts_of(app, pid)
    assert facts == LokiFacts(
        labels("job", "k8s_namespace_name", "k8s_pod_name", "level", "namespace"), None
    )
    [series] = fake_loki.requests
    assert series.path == "/loki/api/v1/series"
    assert series.params["match[]"] == ['{cluster="a"}']
    assert LOKI_LABEL_WINDOW == 604800
    assert int(series.params["start"][0]) == int((NOW - 604800) * NS)
    assert int(series.params["end"][0]) == int(NOW * NS)


async def test_read_facts_without_a_filter_lists_the_labels(monitoring_app, fake_loki):
    http, app = monitoring_app
    pid = await loki_project(http, fake_loki.url, filter=None)
    fake_loki.labels = ["__name__", "pod", "namespace"]
    fake_loki.requests.clear()
    facts = await facts_of(app, pid)
    assert facts == LokiFacts(labels("namespace", "pod"), None)
    [listed] = fake_loki.requests
    assert listed.path == "/loki/api/v1/labels" and "match[]" not in listed.params
    assert int(listed.params["start"][0]) == int((NOW - 604800) * NS)


async def test_read_facts_reports_an_unreachable_loki(monitoring_app):
    http, app = monitoring_app
    pid = await loki_project(http, "http://127.0.0.1:1")
    facts = await facts_of(app, pid)
    assert facts is not None and facts.labels is None
    assert facts.message is not None and facts.message.startswith("Can't reach Shop logs")


async def test_read_facts_reports_a_refusal_and_is_none_without_loki(
    monitoring_app, fake_loki, linked_project
):
    http, app = monitoring_app
    pid = await loki_project(http, fake_loki.url)
    fake_loki.fail_paths["/loki/api/v1/series"] = 500
    facts = await facts_of(app, pid)
    assert facts == LokiFacts(None, "The source answered HTTP 500. Try again, or check the tool.")
    # A project with no Loki has no Loki facts at all.
    assert await facts_of(app, linked_project.project_id) is None


async def test_label_names_drop_lokis_own_labels(fake_loki, direct):
    fake_loki.series = [{"b": "1", "__stream_shard__": "2"}, {"a": "1"}]
    found = await LokiConnector().label_names(
        direct(fake_loki.url, type="loki"),
        matchers=(Matcher("cluster", "=", "a"),),
        start=NOW - 60,
        end=NOW,
    )
    assert found == ["a", "b"]
