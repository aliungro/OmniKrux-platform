"""Which Prometheus resource runs a source's Service: the one answer the capability check (what
the rule form offers) and the PrometheusRule review (what is written) both read."""

import pytest

from omnikrux.monitoring.alerts.tool.prometheus_rule import KIND_KEY, wanted_mode
from omnikrux.monitoring.sources.discovery import PROBE_FORBIDDEN
from omnikrux.monitoring.sources.prometheus_operator import (
    NOT_SERVED,
    NOT_SERVED_OTHER,
    serving_prometheus,
)
from tests.fakekube import prometheus_operator, service

API = "/api/monitoring"
ALERTS = f"{API}/alerts"
PROMETHEUSES = "prometheuses.monitoring.coreos.com"
# The Service a plain Helm chart (prometheus-community/prometheus) puts in front of its server.
PLAIN_CHART = {
    "app.kubernetes.io/name": "prometheus",
    "app.kubernetes.io/instance": "prometheus",
    "app.kubernetes.io/component": "server",
}


def cr(name: str, *, namespace: str = "monitoring", pod_labels: dict | None = None) -> dict:
    spec: dict = {"ruleSelector": {"matchLabels": {"release": name}}}
    if pod_labels is not None:
        spec["podMetadata"] = {"labels": pod_labels}
    return {"metadata": {"name": name, "namespace": namespace}, "spec": spec}


def reader(services: dict[str, dict], prometheuses: list[dict]):
    async def read(path: str) -> dict | None:
        if path.endswith("/prometheuses"):
            return {"items": prometheuses}
        name = path.rsplit("/", 1)[1]
        if name not in services:
            return None
        return {"spec": {"selector": services[name]}}

    return read


async def test_a_plain_chart_prometheus_is_not_run_by_the_operator():
    read = reader({"prometheus-server": PLAIN_CHART}, [cr("kps")])
    assert await serving_prometheus(read, "monitoring", "prometheus-server") is None


async def test_the_operator_prometheus_is_found_by_its_service():
    kps = cr("kps")
    read = reader(
        {
            "kps-prometheus": {
                "app.kubernetes.io/name": "prometheus",
                "operator.prometheus.io/name": "kps",
            },
            "prometheus-operated": {"app.kubernetes.io/name": "prometheus"},
            "by-pod-labels": {"team": "ops", "app.kubernetes.io/instance": "kps"},
            "nothing-selected": {},
            "gone": {"operator.prometheus.io/name": "gone"},
        },
        [kps | {"spec": kps["spec"] | {"podMetadata": {"labels": {"team": "ops"}}}}],
    )
    assert (await serving_prometheus(read, "monitoring", "kps-prometheus"))["metadata"][
        "name"
    ] == "kps"
    assert (await serving_prometheus(read, "monitoring", "prometheus-operated")) is not None
    assert (await serving_prometheus(read, "monitoring", "by-pod-labels")) is not None
    # A Service selecting nothing, naming a resource that isn't there, or not there itself.
    assert await serving_prometheus(read, "monitoring", "nothing-selected") is None
    assert await serving_prometheus(read, "monitoring", "gone") is None
    assert await serving_prometheus(read, "monitoring", "missing") is None
    assert await serving_prometheus(read, None, "kps-prometheus") is None


async def test_two_prometheus_resources_in_one_namespace():
    read = reader(
        {
            "prometheus-operated": {"app.kubernetes.io/name": "prometheus"},
            "b-prometheus": {"app.kubernetes.io/name": "prometheus", "prometheus": "b"},
            "a-only": {"app.kubernetes.io/instance": "a"},
        },
        [cr("a"), cr("b")],
    )
    # A selector both resources' pods fit: OmniKrux can't tell which one answers.
    assert await serving_prometheus(read, "monitoring", "prometheus-operated") is None
    assert (await serving_prometheus(read, "monitoring", "b-prometheus"))["metadata"]["name"] == "b"
    assert (await serving_prometheus(read, "monitoring", "a-only"))["metadata"]["name"] == "a"


async def _source(http, cluster_id: str, service_name: str, port: str, name: str) -> dict:
    r = await http.post(
        f"{API}/sources",
        json={
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": cluster_id,
            "namespace": "monitoring",
            "service": service_name,
            "port": port,
            "name": name,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
async def two_prometheuses(monitoring_app, fake_api, kube_cluster, fake_prometheus):
    """One namespace with the Operator's Prometheus `kps` behind `kps-prometheus` and a plain
    chart's `prometheus-server`; a project "Apps" linking both."""
    http, _ = monitoring_app
    prometheus_operator(fake_api)
    fake_api.objects["services"][("monitoring", "prometheus-server")] = service(
        "monitoring",
        "prometheus-server",
        ports=[{"name": "http", "port": 80}],
        selector=PLAIN_CHART,
    )
    fake_api.service_backends[("monitoring", "kps-prometheus:9090")] = fake_prometheus.url
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    operator = await _source(http, kube_cluster, "kps-prometheus", "9090", "Operator Prometheus")
    plain = await _source(http, kube_cluster, "prometheus-server", "80", "Chart Prometheus")
    project = await http.post(
        f"{API}/setup",
        json={
            "name": "Apps",
            "kind": "custom",
            "sources": [
                {"source_id": operator["id"], "filter": 'cluster="c"'},
                {"source_id": plain["id"], "filter": 'cluster="c"'},
            ],
        },
    )
    assert project.status_code == 201, project.text
    return {"operator": operator, "plain": plain, "project": project.json()["id"]}


async def _capability(http, project_id: str, source_id: str) -> tuple:
    r = await http.get(
        f"{ALERTS}/capabilities",
        params={
            "scope_kind": "project",
            "scope_id": project_id,
            "source_type": "prometheus",
            "source_id": source_id,
        },
    )
    assert r.status_code == 200, r.text
    [one] = r.json()
    return one["tool"], one["reason"]


async def test_only_the_operator_prometheus_can_run_rules(monitoring_app, two_prometheuses):
    http, _ = monitoring_app
    ids = two_prometheuses
    assert await _capability(http, ids["project"], ids["operator"]["id"]) == (
        "prometheus_rule",
        None,
    )
    assert await _capability(http, ids["project"], ids["plain"]["id"]) == (
        None,
        (
            "Chart Prometheus isn't run by the Prometheus Operator, so OmniKrux can't add rules "
            "to it. Run the rule in OmniKrux, or use Operator Prometheus."
        ),
    )
    assert (
        NOT_SERVED_OTHER.format(source="Chart Prometheus", other="Operator Prometheus")
        == (await _capability(http, ids["project"], ids["plain"]["id"]))[1]
    )
    # The source's own check (no other source to name).
    alerting = await http.get(f"{API}/sources/{ids['plain']['id']}/alerting")
    assert alerting.json()["reason"] == NOT_SERVED.format(source="Chart Prometheus")

    # A rule on the plain chart's source runs in OmniKrux and says why.
    r = await http.post(
        f"{ALERTS}/rules",
        json={
            "name": "API latency high",
            "scope": {"kind": "project", "id": ids["project"]},
            "source": {"type": "prometheus", "id": ids["plain"]["id"]},
            "expr": "rate(x[5m])",
            "condition": {"op": "above", "threshold": 0.3, "for": "5m", "every": "1m"},
            "engine": "tool",
        },
    )
    assert r.status_code == 201, r.text
    [target] = r.json()["rule"]["targets"]
    assert target["engine"] == "omnikrux" and target["tool"] is None
    assert target["engine_note"] == NOT_SERVED.format(source="Chart Prometheus")


async def test_the_operator_prometheus_with_no_rule_selector_says_so(
    monitoring_app, two_prometheuses, fake_api
):
    http, _ = monitoring_app
    ids = two_prometheuses
    del fake_api.objects[PROMETHEUSES][("monitoring", "kps")]["spec"]["ruleSelector"]
    tool, reason = await _capability(http, ids["project"], ids["operator"]["id"])
    assert tool is None and "its ruleSelector is empty" in reason


async def test_a_rule_left_in_a_prometheus_the_operator_no_longer_runs_moves_out(
    monitoring_app, two_prometheuses, fake_api
):
    """A tool rule whose Service turns out not to be run by the Operator falls back to OmniKrux,
    and its PrometheusRule is offered for removal (the `tool_copy` bar's review)."""
    http, app = monitoring_app
    services = app.state.monitoring
    ids = two_prometheuses
    r = await http.post(
        f"{ALERTS}/rules",
        json={
            "name": "API latency high",
            "scope": {"kind": "project", "id": ids["project"]},
            "source": {"type": "prometheus", "id": ids["operator"]["id"]},
            "expr": "rate(x[5m])",
            "condition": {"op": "above", "threshold": 0.3, "for": "5m", "every": "1m"},
            "engine": "tool",
        },
    )
    assert r.status_code == 201, r.text
    rule = r.json()["rule"]
    [target] = rule["targets"]
    assert target["engine"] == "tool"
    plan = (await http.post(f"{ALERTS}/targets/{target['id']}/sync")).json()["plan"]
    applied = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert applied.status_code == 200, applied.text
    assert len(fake_api.objects[KIND_KEY]) == 1

    # The Service now fronts a plain chart's pods.
    fake_api.objects["services"][("monitoring", "kps-prometheus")]["spec"]["selector"] = dict(
        PLAIN_CHART
    )
    services.capabilities.forget(ids["operator"]["id"])
    await services.alert_sync.reconcile_rule(rule["id"])
    [record] = await services.alerts.targets(rule_id=rule["id"])
    assert record.engine == "omnikrux" and wanted_mode(record) == "delete"
    shown = (await http.get(f"{ALERTS}/rules/{rule['id']}")).json()
    [t] = shown["targets"]
    assert t["engine"] == "omnikrux" and t["tool_copy"] == "prometheus_rule"
    assert t["engine_note"] == NOT_SERVED.format(source="Operator Prometheus")
    removal = (await http.post(f"{ALERTS}/targets/{t['id']}/sync")).json()
    assert removal["kind"] == "review" and removal["plan"]["action"] == "delete"


async def test_a_login_not_allowed_to_read_the_operator_says_so(
    monitoring_app, two_prometheuses, fake_api
):
    http, app = monitoring_app
    ids = two_prometheuses
    fake_api.forbidden_kinds.add(PROMETHEUSES)
    app.state.monitoring.capabilities.forget(ids["operator"]["id"])
    cluster = (await app.state.registry.list())[0].name
    tool, reason = await _capability(http, ids["project"], ids["operator"]["id"])
    assert tool is None
    assert reason.endswith(PROBE_FORBIDDEN.format(name=cluster))
    assert "Try again" not in reason
