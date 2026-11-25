"""Filter suggestions: whether a source holds several clusters, and which label keeps this one."""

import socket
from datetime import UTC, datetime

import pytest
import yaml

from omnikrux.clusters.models import Environment, Provider
from omnikrux.clusters.registry import SOURCE_UPLOAD, ClusterInfo
from omnikrux.monitoring.query.filters import render_matchers
from omnikrux.monitoring.query.suggest import CANDIDATE_LABELS, suggest_filter
from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.sources.api import ONE_SOURCE, SOURCE_GONE
from omnikrux.monitoring.sources.connector import default_connectors
from omnikrux.monitoring.sources.discovery import CLUSTER_GONE
from omnikrux.monitoring.sources.types import SourceConfig, SourceSecrets
from tests.fakekube import kubeconfig_for

URL = "/api/monitoring/suggest-filter"
KIND = "kind-omnikrux-dev"


@pytest.fixture
async def kind_cluster(fake_api, monitoring_app) -> str:
    """The fake Kubernetes API registered under the name `kind-omnikrux-dev`."""
    _, app = monitoring_app
    kubeconfig = kubeconfig_for(fake_api)
    kubeconfig["contexts"][0]["name"] = KIND
    kubeconfig["current-context"] = KIND
    [info] = await app.state.registry.upsert_from_kubeconfig(
        yaml.safe_dump(kubeconfig), rewrite_loopback=False, source=SOURCE_UPLOAD
    )
    assert info.name == KIND
    return info.id


def by_url(url: str) -> dict:
    return {"type": "prometheus", "reach": "url", "url": url}


async def suggest(http, **body) -> dict:
    response = await http.post(URL, json={"kind": "kubernetes"} | body)
    assert response.status_code == 200, response.text
    return response.json()


def test_candidate_labels():
    assert CANDIDATE_LABELS == ("cluster", "cluster_name", "k8s_cluster_name", "kubernetes_cluster")


async def test_rule_1_not_a_kubernetes_project_or_no_cluster(
    monitoring_app, kind_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_prometheus.label_values["cluster"] = [KIND, "prod-east"]
    for body in (
        {"kind": "docker", "cluster_id": kind_cluster},
        {"kind": "kubernetes", "cluster_id": None},
    ):
        answer = await suggest(http, source=by_url(fake_prometheus.url), **body)
        assert answer == {"filter": "", "origin": "none", "reason": None}
    assert fake_prometheus.requests == []


async def test_rule_2_several_clusters_and_this_one_is_there(
    monitoring_app, kind_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_prometheus.label_values["cluster"] = [KIND, "prod-east"]

    answer = await suggest(http, cluster_id=kind_cluster, source=by_url(fake_prometheus.url))

    assert answer == {
        "filter": 'cluster="kind-omnikrux-dev"',
        "origin": "auto",
        "reason": "This source holds several clusters; the filter keeps kind-omnikrux-dev.",
    }


async def test_rule_2_takes_the_first_candidate_label(
    monitoring_app, kind_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_prometheus.label_values["cluster"] = ["only-one"]
    fake_prometheus.label_values["k8s_cluster_name"] = ["a", KIND]
    fake_prometheus.label_values["kubernetes_cluster"] = ["b", KIND]

    answer = await suggest(http, cluster_id=kind_cluster, source=by_url(fake_prometheus.url))

    assert answer["filter"] == 'k8s_cluster_name="kind-omnikrux-dev"'
    assert answer["origin"] == "auto"


async def test_rule_3_a_source_inside_the_same_cluster(
    monitoring_app, fake_api, kind_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    created = await http.post(
        "/api/monitoring/sources",
        json={
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": kind_cluster,
            "namespace": "monitoring",
            "service": "prometheus-server",
            "port": "80",
        },
    )

    answer = await suggest(http, cluster_id=kind_cluster, source_id=created.json()["id"])

    assert answer == {
        "filter": "",
        "origin": "auto",
        "reason": "This source runs inside the cluster, so it holds only its data.",
    }


async def test_rule_4_several_clusters_but_not_this_one(
    monitoring_app, kind_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_prometheus.label_values["cluster_name"] = ["prod-east", "prod-west"]

    answer = await suggest(http, cluster_id=kind_cluster, source=by_url(fake_prometheus.url))

    assert answer == {
        "filter": "",
        "origin": "none",
        "reason": (
            "This source holds several clusters, and none is named kind-omnikrux-dev. "
            "Set the filter yourself."
        ),
    }


async def test_rule_5_cant_tell(monitoring_app, kind_cluster, fake_prometheus):
    http, _ = monitoring_app
    fake_prometheus.label_values["cluster"] = [KIND]  # one value: not several clusters

    answer = await suggest(http, cluster_id=kind_cluster, source=by_url(fake_prometheus.url))

    assert answer == {
        "filter": "",
        "origin": "none",
        "reason": "OmniKrux couldn't tell whether a filter is needed.",
    }


async def test_rule_6_the_source_cant_be_reached(monitoring_app, kind_cluster):
    http, _ = monitoring_app
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    answer = await suggest(http, cluster_id=kind_cluster, source=by_url(f"http://127.0.0.1:{port}"))

    assert answer == {
        "filter": "",
        "origin": "none",
        "reason": messages.REFUSED.format(name="Prometheus · 127.0.0.1"),
    }


async def test_suggest_takes_exactly_one_source(monitoring_app, kind_cluster, fake_prometheus):
    http, _ = monitoring_app
    both = {"kind": "kubernetes", "source_id": "x", "source": by_url(fake_prometheus.url)}
    for body in (both, {"kind": "kubernetes"}):
        response = await http.post(URL, json=body)
        assert (response.status_code, response.json()) == (422, {"detail": ONE_SOURCE})
    assert ONE_SOURCE == "Give a saved source or a new one, but not both."


async def test_suggest_for_an_unknown_cluster_or_source(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    response = await http.post(
        URL,
        json={"kind": "kubernetes", "cluster_id": "gone", "source": by_url(fake_prometheus.url)},
    )
    assert (response.status_code, response.json()) == (404, {"detail": CLUSTER_GONE})
    response = await http.post(URL, json={"kind": "kubernetes", "source_id": "gone"})
    assert (response.status_code, response.json()) == (404, {"detail": SOURCE_GONE})


async def test_the_context_name_matches_too(fake_prometheus, direct):
    now = datetime.now(UTC)
    cluster = ClusterInfo(
        id="c-1",
        name="Development",
        context_name=KIND,
        server="https://127.0.0.1:6443",
        original_server=None,
        provider=Provider.KIND,
        region=None,
        environment=Environment.DEVELOPMENT,
    )
    fake_prometheus.label_values["cluster"] = [KIND, "prod-east"]
    source = SourceConfig(
        id="",
        name="Prometheus · test",
        type="prometheus",
        reach="url",
        url=fake_prometheus.url,
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

    suggestion = await suggest_filter(
        kind="kubernetes",
        cluster=cluster,
        source=source,
        connector=default_connectors().get("prometheus"),
        transport=direct(fake_prometheus.url),
    )

    assert render_matchers(suggestion.matchers) == 'cluster="kind-omnikrux-dev"'
    assert suggestion.origin == "auto"
    assert suggestion.reason == (
        "This source holds several clusters; the filter keeps kind-omnikrux-dev."
    )


async def test_rule_6_the_tools_own_refusal_keeps_the_prefix(
    monitoring_app, kind_cluster, fake_prometheus
):
    http, _ = monitoring_app
    for label in CANDIDATE_LABELS:
        fake_prometheus.fail_paths[f"/api/v1/label/{label}/values"] = 400

    answer = await suggest(http, cluster_id=kind_cluster, source=by_url(fake_prometheus.url))

    assert answer["reason"] == "Couldn't check the source: refused"
