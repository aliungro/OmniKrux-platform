"""The Monitoring tools page's read of a cluster: the install record, Helm's release records and
the workloads, read live each time with the moment they were read; a failed read says so in
words and shows no release; the tools the user runs elsewhere are listed apart."""

from datetime import UTC, datetime

from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.settings import InstallSettings
from tests.fakekube import service
from tests.monitoring.install_env import waiting_pod

NS = "monitoring"
PULL = 'ImagePullBackOff: Back-off pulling image "example.test/loki:x"'


def status_url(cluster_id: str) -> str:
    return f"/api/monitoring/install/clusters/{cluster_id}"


async def _status(http, cluster_id: str) -> dict:
    r = await http.get(status_url(cluster_id))
    assert r.status_code == 200, r.text
    return r.json()


async def test_status_reads_releases_and_workloads_live(
    installed_cluster, monitoring_app, fake_api
):
    http, app = monitoring_app
    cluster = installed_cluster.cluster_id
    loki = fake_api.objects["statefulsets.apps"][(NS, "omnikrux-loki")]
    loki["status"]["readyReplicas"] = 0
    labels = loki["spec"]["selector"]["matchLabels"]
    fake_api.pods[(NS, "omnikrux-loki-0")] = waiting_pod(
        NS,
        "omnikrux-loki-0",
        labels,
        "ImagePullBackOff",
        'Back-off pulling image "example.test/loki:x"',
    )
    before = datetime.now(UTC)
    out = await _status(http, cluster)

    assert out["cluster_id"] == cluster
    assert out["cluster_name"] == (await app.state.registry.get(cluster)).name
    assert out["problem"] is None
    assert datetime.fromisoformat(out["checked_at"]) >= before
    assert out["tools"]["available"] is True

    install = out["install"]
    assert (install["namespace"], install["state"]) == (NS, "installed")
    assert install["components"] == ["metrics", "logs"]
    assert install["update_available"] is False
    assert (
        install["charts"]
        == install["shipped"]
        == {key: CHARTS[key].version for key in ("kube-prometheus-stack", "loki", "alloy")}
    )
    assert {k: v["id"] for k, v in install["sources"].items()} == installed_cluster.sources
    assert install["contacts"] == {
        "state": "none",
        "message": None,
        "applied_at": None,
        "contact_points": 0,
        "rules": 0,
    }
    assert install["settings"]["namespace"] == NS

    releases = {r["release"]: r for r in out["releases"]}
    assert list(releases) == ["omnikrux-metrics", "omnikrux-loki", "omnikrux-alloy"]
    for name, chart in (
        ("omnikrux-metrics", "kube-prometheus-stack"),
        ("omnikrux-loki", "loki"),
        ("omnikrux-alloy", "alloy"),
    ):
        r = releases[name]
        assert (r["chart"], r["version"], r["status"], r["revision"]) == (
            chart,
            CHARTS[chart].version,
            "deployed",
            1,
        )
        assert datetime.fromisoformat(r["deployed_at"]) == datetime(2026, 11, 24, 10, tzinfo=UTC)
    assert releases["omnikrux-metrics"]["label"] == "Prometheus and Alertmanager"
    assert [w["name"] for w in releases["omnikrux-metrics"]["workloads"]] == [
        "omnikrux-metrics-operator",
        "omnikrux-metrics-kube-state-metrics",
        "omnikrux-metrics-prometheus-node-exporter",
        "prometheus-omnikrux-metrics-prometheus",
        "alertmanager-omnikrux-metrics-alertmanager",
    ]
    assert all(
        (w["ready"], w["desired"], w["why"]) == (1, 1, None)
        for w in releases["omnikrux-metrics"]["workloads"]
    )
    assert releases["omnikrux-loki"]["workloads"] == [
        {
            "kind": "StatefulSet",
            "name": "omnikrux-loki",
            "label": "Loki",
            "ready": 0,
            "desired": 1,
            "why": PULL,
        }
    ]

    # Read again: live, not remembered.
    del fake_api.objects["deployments.apps"][(NS, "omnikrux-alloy")]
    again = await _status(http, cluster)
    [alloy] = [r for r in again["releases"] if r["release"] == "omnikrux-alloy"]
    assert alloy["workloads"][0]["why"] == "Not created yet"
    assert again["checked_at"] >= out["checked_at"]


async def test_status_says_when_the_cluster_cant_be_read(
    installed_cluster, monitoring_app, fake_api
):
    http, _ = monitoring_app
    fake_api.mode = "forbidden"
    out = await _status(http, installed_cluster.cluster_id)
    assert out["releases"] == []
    assert out["others"] == []
    assert out["problem"] is not None
    assert out["problem"].startswith("Not allowed to read the monitoring tools in monitoring: ")
    assert out["install"]["state"] == "installed"  # what OmniKrux recorded, not a live read


async def test_status_lists_tools_the_user_runs(
    installed_cluster, monitoring_app, fake_api, fake_prometheus
):
    http, _ = monitoring_app
    fake_api.objects["services"][("observability", "prometheus-server")] = service(
        "observability",
        "prometheus-server",
        labels={"app.kubernetes.io/name": "prometheus"},
        ports=[{"name": "http", "port": 9090, "protocol": "TCP"}],
    )
    fake_api.service_backends[("observability", "prometheus-server:9090")] = fake_prometheus.url
    # OmniKrux's own Prometheus Service is not one of the user's tools.
    fake_api.objects["services"][(NS, "omnikrux-metrics-prometheus")] = service(
        NS,
        "omnikrux-metrics-prometheus",
        labels={"app.kubernetes.io/name": "prometheus"},
        ports=[{"name": "http-web", "port": 9090, "protocol": "TCP"}],
    )
    out = await _status(http, installed_cluster.cluster_id)
    assert [(t["type"], t["namespace"], t["service"]) for t in out["others"]] == [
        ("prometheus", "observability", "prometheus-server")
    ]
    assert out["others"][0]["state"] == "reachable"


async def test_update_available_after_a_chart_bump(installed_cluster, monitoring_app):
    http, app = monitoring_app
    cluster = installed_cluster.cluster_id
    installs = app.state.monitoring.installs
    record = await installs.get(cluster)
    older = {**record.charts, "loki": "6.0.0"}
    await installs.begin(
        cluster, NS, record.components, record.settings, older, job_id="old", project_id=None
    )
    await installs.finish(cluster, "installed", "done", job_id="old")
    install = (await _status(http, cluster))["install"]
    assert install["update_available"] is True
    assert install["charts"]["loki"] == "6.0.0"
    assert install["shipped"]["loki"] == CHARTS["loki"].version


async def test_status_without_an_install(monitoring_app, kube_cluster, fake_helm):
    http, _ = monitoring_app
    out = await _status(http, kube_cluster)
    assert out["install"] is None and out["releases"] == [] and out["problem"] is None
    gone = await http.get(status_url("nope"))
    assert (gone.status_code, gone.json()["detail"]) == (
        404,
        "That cluster isn't connected to OmniKrux any more.",
    )


async def test_a_release_helm_lost_reads_as_missing(installed_cluster, monitoring_app, fake_api):
    http, _ = monitoring_app
    del fake_api.objects["secrets"][(NS, "sh.helm.release.v1.omnikrux-alloy.v1")]
    out = await _status(http, installed_cluster.cluster_id)
    [alloy] = [r for r in out["releases"] if r["release"] == "omnikrux-alloy"]
    assert (alloy["status"], alloy["revision"], alloy["version"], alloy["deployed_at"]) == (
        "missing",
        None,
        None,
        None,
    )


async def test_settings_round_trip(monitoring_app, kube_cluster, fake_helm):
    """A record made with other settings shows them (nothing is read from the defaults)."""
    http, app = monitoring_app
    installs = app.state.monitoring.installs
    settings = InstallSettings(namespace="observe", retention_days=3, persist=False)
    await installs.begin(
        kube_cluster, "observe", ("logs",), settings, {}, job_id="j", project_id=None
    )
    await installs.finish(kube_cluster, "failed", "Helm said no.", job_id="j")
    install = (await _status(http, kube_cluster))["install"]
    assert (install["state"], install["message"]) == ("failed", "Helm said no.")
    assert (install["settings"]["retention_days"], install["settings"]["persist"]) == (3, False)
    assert install["sources"] == {"prometheus": None, "alertmanager": None, "loki": None}
