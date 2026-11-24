"""The install job: a confirmed install review runs as a job (namespace, CRDs, one Helm release
at a time, readiness, the sources), with progress, a cancel that stops Helm, plain failures that
say what stays, and an install record and audit record finished on every ending."""

import asyncio
import itertools

import pytest

from omnikrux.actions.jobs import REMOVED
from omnikrux.monitoring.install import job as install_job
from omnikrux.monitoring.install.helm import HelmResult, timed_out
from omnikrux.monitoring.install.kubeconfig import LONGEST_HELM_CALL_SECONDS
from omnikrux.monitoring.install.readiness import is_ready
from omnikrux.monitoring.install.settings import InstallSettings
from omnikrux.monitoring.install.store import INTERRUPTED
from tests.fakekube import CRDS_KEY, TOKEN
from tests.monitoring.install_env import (
    CRD_NAMES,
    JOBS,
    apply,
    chart_crd,
    helm_writes_releases,
    install_plan,
    mark_all_ready,
    prepare_install,
    rolled_out,
    wait_job,
    wait_until,
    waiting_pod,
    write_release,
)

NS = "monitoring"
STALE = "The monitoring tools in monitoring changed since you reviewed this. Review it again."
PULL = 'ImagePullBackOff: Back-off pulling image "example.test/loki:x"'


@pytest.fixture
def env(monitoring_app, kube_cluster, fake_api, fake_helm, installed_backends, fast_install):
    http, app = monitoring_app
    prepare_install(fake_api, fake_helm)
    return http, app, kube_cluster, fake_api, fake_helm


async def _project(http, name: str = "Shop") -> str:
    r = await http.post(
        "/api/monitoring/setup", json={"name": name, "kind": "custom", "sources": []}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _audit(http) -> list[dict]:
    return (await http.get("/api/audit")).json()["records"]


def _upgrades(fake_helm) -> list:
    return [c for c in fake_helm.calls if c.args[0] == "upgrade"]


def _loki_pulling(fake_api) -> None:
    labels = {
        "app.kubernetes.io/instance": "omnikrux-loki",
        "app.kubernetes.io/name": "omnikrux-loki",
    }
    fake_api.pods[(NS, "omnikrux-loki-0")] = waiting_pod(
        NS,
        "omnikrux-loki-0",
        labels,
        "ImagePullBackOff",
        'Back-off pulling image "example.test/loki:x"',
    )


async def test_install_runs_in_order_and_connects(env):
    http, app, cluster, fake_api, fake_helm = env
    pid = await _project(http)
    plan = await install_plan(http, cluster, ["metrics", "logs"], project_id=pid)
    out = await apply(http, plan)
    assert out["outcome"] == "started"
    assert out["message"] == "Installing the monitoring tools in monitoring…"
    mark_all_ready(fake_api, NS)
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    assert job["message"] == (
        "Installed in monitoring: Prometheus, Alertmanager, Loki and Grafana Alloy are running. "
        "Connected 3 sources to Shop."
    )
    assert job["total"] == 1 + 1 + 3 + 7 + 1 and job["done"] == job["total"]
    assert job["blocked"] == []

    upgrades = _upgrades(fake_helm)
    assert [c.args[2] for c in upgrades] == ["omnikrux-metrics", "omnikrux-loki", "omnikrux-alloy"]
    for call in upgrades:
        assert call.args[:2] == ["upgrade", "--install"]
        assert "--wait" not in call.args and "--atomic" not in call.args
        assert call.args[call.args.index("--timeout") + 1] == "600s"
        assert call.args[call.args.index("--namespace") + 1] == NS
        assert call.timeout is not None and call.timeout <= LONGEST_HELM_CALL_SECONDS
        assert call.kubeconfig_text is not None and TOKEN in call.kubeconfig_text
        assert all(TOKEN not in a for a in call.args)

    # The namespace, then the five CRDs, written before Helm ran.
    created = [(o["kind"], o["metadata"]["name"]) for o in fake_api.created_objects]
    assert created[0] == ("Namespace", NS)
    assert sorted(n for k, n in created if k == "CustomResourceDefinition") == sorted(CRD_NAMES)
    assert all("status" not in o for o in fake_api.created_objects)

    sources = (await http.get("/api/monitoring/sources")).json()
    ours = [s for s in sources if s["installed_by_omnikrux"]]
    assert {s["name"].split(" · ")[0] for s in ours} == {"Prometheus", "Alertmanager", "Loki"}
    assert {(s["type"], s["service"], s["port"], s["reach"]) for s in ours} == {
        ("prometheus", "omnikrux-metrics-prometheus", "9090", "cluster"),
        ("alertmanager", "omnikrux-metrics-alertmanager", "9093", "cluster"),
        ("loki", "omnikrux-loki", "3100", "cluster"),
    }
    assert all(s["created_by_project_id"] is None for s in ours)
    links = (await http.get(f"/api/monitoring/projects/{pid}")).json()["links"]
    assert {link["source_name"] for link in links} >= {s["name"] for s in ours}
    assert all(link["filter"] == "" and link["filter_origin"] == "auto" for link in links)

    audit = await _audit(http)
    assert any(
        r["action"] == "install"
        and r["kind"] == "namespaces"
        and r["name"] == NS
        and r["outcome"] == "succeeded"
        and r["message"] == job["message"]
        for r in audit
    )
    assert sorted(r["name"] for r in audit if r["action"] == "source_add") == sorted(
        s["name"] for s in ours
    )
    changes = [r for r in audit if r["action"] == "project_change"]
    assert len(changes) == 3 and all(r["outcome"] == "succeeded" for r in changes)

    record = await app.state.monitoring.installs.get(cluster)
    assert record.state == "installed" and record.message == job["message"]
    assert record.components == ("metrics", "logs") and record.project_id == pid
    by_type = {s["type"]: s["id"] for s in ours}
    assert (record.prometheus_source_id, record.alertmanager_source_id, record.loki_source_id) == (
        by_type["prometheus"],
        by_type["alertmanager"],
        by_type["loki"],
    )


async def test_installing_logs_alone_connects_one_source(env):
    http, _, cluster, fake_api, fake_helm = env
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    assert job["message"] == (
        "Installed in monitoring: Loki and Grafana Alloy are running. Connected 1 source."
    )
    assert [c.args[2] for c in _upgrades(fake_helm)] == ["omnikrux-loki", "omnikrux-alloy"]
    # No metrics: no CRDs are read or written.
    assert not any(o["kind"] == "CustomResourceDefinition" for o in fake_api.created_objects)
    assert job["total"] == 1 + 2 + 2 + 1


async def test_crds_already_there_are_replaced_with_their_version(env):
    http, _, cluster, fake_api, _ = env
    old = chart_crd("prometheuses.monitoring.coreos.com", "0.70.0")
    old["metadata"]["resourceVersion"] = "7"
    fake_api.objects[CRDS_KEY][("", "prometheuses.monitoring.coreos.com")] = old
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["metrics"]))
    assert (await wait_job(http, out["job_id"]))["state"] == "succeeded"
    [put] = [w for w in fake_api.writes if w["method"] == "PUT"]
    assert put["path"].endswith("/customresourcedefinitions/prometheuses.monitoring.coreos.com")
    assert put["body"]["metadata"]["resourceVersion"] == "7"
    assert put["body"]["metadata"]["annotations"] == {"operator.prometheus.io/version": "0.95.1"}


async def test_progress_names_what_holds_it_up(env):
    http, _, cluster, fake_api, _ = env
    mark_all_ready(fake_api, NS, except_=("omnikrux-loki",))
    _loki_pulling(fake_api)
    out = await apply(http, await install_plan(http, cluster, ["metrics", "logs"]))
    job_id = out["job_id"]

    async def blocked() -> dict:
        while True:
            job = (await http.get(f"{JOBS}/{job_id}")).json()
            if job["blocked"]:
                return job
            assert job["state"] == "running", job
            await asyncio.sleep(0.01)

    job = await blocked()
    assert job["blocked"] == [
        {"namespace": NS, "name": "StatefulSet omnikrux-loki", "message": PULL}
    ]
    assert job["message"] == "Waiting for Loki to be ready (0 of 1)…"
    assert job["done"] < job["total"]
    mark_all_ready(fake_api, NS)
    done = await wait_job(http, job_id)
    assert done["state"] == "succeeded" and done["blocked"] == []


async def test_a_workload_not_made_yet_says_so(env):
    http, _, cluster, fake_api, _ = env
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    job_id = out["job_id"]
    while True:
        job = (await http.get(f"{JOBS}/{job_id}")).json()
        if job["blocked"]:
            break
        assert job["state"] == "running", job
        await asyncio.sleep(0.01)
    assert job["blocked"] == [
        {"namespace": NS, "name": "StatefulSet omnikrux-loki", "message": "Not created yet"}
    ]
    mark_all_ready(fake_api, NS)
    assert (await wait_job(http, job_id))["state"] == "succeeded"


async def test_helm_failure_says_what_stays(env):
    http, app, cluster, fake_api, fake_helm = env
    helm_writes_releases(
        fake_helm, fake_api, fail={"omnikrux-loki": "Error: UPGRADE FAILED: the chart said no\n"}
    )
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["metrics", "logs"]))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "failed"
    assert job["message"] == (
        "Helm couldn't install omnikrux-loki: UPGRADE FAILED: the chart said no. What Helm "
        "applied stays as Helm left it (failed). Check the Pods in monitoring, then install "
        "again, or uninstall the tools."
    )
    assert [c.args[2] for c in _upgrades(fake_helm)] == ["omnikrux-metrics", "omnikrux-loki"]
    record = await app.state.monitoring.installs.get(cluster)
    assert (record.state, record.message) == ("failed", job["message"])
    # Nothing is rolled back or removed.
    assert ("monitoring", "sh.helm.release.v1.omnikrux-metrics.v1") in fake_api.objects["secrets"]
    assert not any(c.args[0] in ("uninstall", "rollback") for c in fake_helm.calls)
    [install] = [r for r in await _audit(http) if r["action"] == "install"]
    assert (install["outcome"], install["message"]) == ("failed", job["message"])


async def test_helm_words_never_carry_the_token_or_status_when_unknown(env):
    http, _, cluster, _, fake_helm = env

    async def refuses(args):
        return HelmResult(1, "", f"Error: UPGRADE FAILED: Authorization: Bearer {TOKEN} refused\n")

    fake_helm.script["upgrade"] = refuses
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "failed"
    assert TOKEN not in job["message"]
    assert job["message"].startswith(
        "Helm couldn't install omnikrux-loki: UPGRADE FAILED: Authorization: Bearer ••• refused."
    )
    assert "(unknown)" in job["message"]
    assert TOKEN not in (await http.get("/api/audit")).text


async def test_not_ready_after_ten_minutes(env, monkeypatch):
    http, app, cluster, fake_api, _ = env
    ticks = itertools.count(0, 400)
    monkeypatch.setattr(install_job, "CLOCK", lambda: next(ticks))
    mark_all_ready(fake_api, NS, except_=("omnikrux-loki",))
    _loki_pulling(fake_api)
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "failed"
    assert job["message"] == (
        f"Loki wasn't ready after 10 minutes: {PULL}. What Helm applied stays. Check the Pods "
        "in monitoring, then install again, or uninstall the tools."
    )
    assert job["blocked"] == []
    assert (await app.state.monitoring.installs.get(cluster)).state == "failed"


async def test_cancel_terminates_helm_and_says_what_stays(env):
    http, app, cluster, _, fake_helm = env
    fake_helm.hang = {"upgrade"}
    out = await apply(http, await install_plan(http, cluster, ["metrics", "logs"]))
    await wait_until(lambda: bool(_upgrades(fake_helm)))
    r = await http.post(f"{JOBS}/{out['job_id']}/cancel")
    assert r.status_code == 200, r.text
    job = r.json()
    message = (
        "Install cancelled while installing omnikrux-metrics with Helm. What was already applied "
        "stays as Helm left it. Install again to finish, or uninstall the tools."
    )
    assert (job["state"], job["message"]) == ("cancelled", message)
    record = await app.state.monitoring.installs.get(cluster)
    assert (record.state, record.message) == ("cancelled", message)
    [install] = [r for r in await _audit(http) if r["action"] == "install"]
    assert (install["outcome"], install["message"]) == ("failed", message)
    [call] = _upgrades(fake_helm)
    assert call.kubeconfig is not None and not call.kubeconfig.parent.exists()


@pytest.mark.parametrize("ending", ["succeeded", "failed", "cancelled"])
async def test_kubeconfig_is_removed_on_every_ending(env, ending):
    http, _, cluster, fake_api, fake_helm = env
    if ending == "failed":
        helm_writes_releases(fake_helm, fake_api, fail={"omnikrux-alloy": "Error: nope\n"})
    if ending == "cancelled":
        fake_helm.hang = {"upgrade"}
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["metrics", "logs"]))
    if ending == "cancelled":
        await wait_until(lambda: bool(_upgrades(fake_helm)))
        await http.post(f"{JOBS}/{out['job_id']}/cancel")
    job = await wait_job(http, out["job_id"])
    assert job["state"] == ending
    calls = [c for c in fake_helm.calls if c.kubeconfig is not None]
    assert calls and calls == _upgrades(fake_helm)
    assert all(c.kubeconfig_text for c in calls)
    # A fresh folder per Helm call, each gone once the call ended.
    assert len({c.kubeconfig.parent for c in calls}) == len(calls)
    assert not any(c.kubeconfig.parent.exists() for c in calls)


async def test_existing_sources_are_reused(env):
    http, _, cluster, fake_api, _ = env
    added = await http.post(
        "/api/monitoring/sources",
        json={
            "name": "Our Prometheus",
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": cluster,
            "namespace": NS,
            "service": "omnikrux-metrics-prometheus",
            "port": "9090",
        },
    )
    assert added.status_code == 201, added.text
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["metrics"]))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    sources = (await http.get("/api/monitoring/sources")).json()
    prometheus = [s for s in sources if s["type"] == "prometheus"]
    assert [(s["id"], s["installed_by_omnikrux"]) for s in prometheus] == [
        (added.json()["id"], True)
    ]
    flagged = [r for r in await _audit(http) if r["action"] == "source_change"]
    assert [(r["name"], r["details"], r["outcome"]) for r in flagged] == [
        ("Our Prometheus", {"installed_by_omnikrux": True}, "succeeded")
    ]
    added_names = [r["name"] for r in await _audit(http) if r["action"] == "source_add"]
    assert "Our Prometheus" in added_names  # the user's own add
    assert sum(n.startswith("Alertmanager · ") for n in added_names) == 1
    assert not any(n.startswith("Prometheus · ") for n in added_names)


async def test_a_source_that_never_answers(env):
    http, app, cluster, fake_api, _ = env
    del fake_api.service_backends[(NS, "omnikrux-loki:3100")]
    pid = await _project(http)
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["metrics", "logs"], project_id=pid))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "failed"
    assert job["message"].startswith("The tools are running, but OmniKrux couldn't connect Loki: ")
    assert job["message"].endswith(" Add it from Sources, or install again to try once more.")
    sources = (await http.get("/api/monitoring/sources")).json()
    ours = {s["type"]: s for s in sources if s["installed_by_omnikrux"]}
    assert set(ours) == {"prometheus", "alertmanager", "loki"}
    linked = {
        link["source_id"]
        for link in (await http.get(f"/api/monitoring/projects/{pid}")).json()["links"]
    }
    assert linked == {ours["prometheus"]["id"], ours["alertmanager"]["id"]}
    record = await app.state.monitoring.installs.get(cluster)
    assert record.state == "failed" and record.loki_source_id == ours["loki"]["id"]
    assert record.prometheus_source_id == ours["prometheus"]["id"]


async def test_release_changed_since_review_is_refused(env):
    http, app, cluster, fake_api, fake_helm = env
    plan = await install_plan(http, cluster, ["metrics", "logs"])
    write_release(fake_api, NS, "omnikrux-metrics", 1, "deployed")
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (409, STALE)
    assert fake_api.created_objects == [] and fake_api.writes == []
    assert _upgrades(fake_helm) == []
    assert await app.state.monitoring.installs.get(cluster) is None
    [install] = [r for r in await _audit(http) if r["action"] == "install"]
    assert (install["outcome"], install["message"]) == ("failed", STALE)


async def test_crds_changed_since_review_are_refused(env):
    http, _, cluster, fake_api, fake_helm = env
    for name in CRD_NAMES:  # at the chart's version: nothing to write
        fake_api.objects[CRDS_KEY][("", name)] = chart_crd(name)
    plan = await install_plan(http, cluster, ["metrics"])
    del fake_api.objects[CRDS_KEY][("", CRD_NAMES[0])]
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (409, STALE)
    assert fake_api.created_objects == [] and _upgrades(fake_helm) == []


async def test_settings_changed_since_review_are_refused(env):
    http, _, cluster, fake_api, fake_helm = env
    plan = await install_plan(http, cluster, ["logs"])
    del fake_api.objects["storageclasses.storage.k8s.io"][("", "standard")]
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (409, STALE)
    assert fake_api.created_objects == [] and _upgrades(fake_helm) == []


async def test_one_job_per_cluster(env):
    http, app, cluster, _, fake_helm = env
    fake_helm.hang = {"upgrade"}
    first = await install_plan(http, cluster, ["metrics"])
    raced = await install_plan(http, cluster, ["metrics"])
    out = await apply(http, first)
    await wait_until(lambda: bool(_upgrades(fake_helm)))
    name = (await app.state.registry.get(cluster)).name
    busy = f"OmniKrux is installing in {name} right now. Wait for it to finish, or cancel it."
    again = await install_plan(http, cluster, ["metrics"])
    assert busy in again["blocked"]
    r = await http.post(f"/api/actions/{raced['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (409, busy)
    assert len(_upgrades(fake_helm)) == 1
    await http.post(f"{JOBS}/{out['job_id']}/cancel")


async def test_a_raced_apply_that_loses_the_record_is_busy(env, monkeypatch, caplog):
    """Both applies pass the early check; the record says which job runs, and the other apply
    is refused with the busy words before any job starts (its audit record finished once, as
    failed), writing nothing."""
    http, app, cluster, _, fake_helm = env
    fake_helm.hang = {"upgrade"}
    first = await install_plan(http, cluster, ["logs"])
    raced = await install_plan(http, cluster, ["logs"])
    out = await apply(http, first)
    await wait_until(lambda: bool(_upgrades(fake_helm)))
    installs = app.state.monitoring.installs

    async def nothing_yet(cluster_id):
        return None

    monkeypatch.setattr(installs, "get", nothing_yet)
    r = await http.post(f"/api/actions/{raced['plan_id']}/apply", json={})
    name = (await app.state.registry.get(cluster)).name
    busy = f"OmniKrux is installing in {name} right now. Wait for it to finish, or cancel it."
    assert (r.status_code, r.json()["detail"]) == (409, busy)
    monkeypatch.undo()
    record = await installs.get(cluster)
    assert (record.state, record.job_id) == ("installing", out["job_id"])
    installs_audit = [r for r in await _audit(http) if r["action"] == "install"]
    assert [(r["outcome"], r["message"]) for r in installs_audit if r["outcome"] != "started"] == [
        ("failed", busy)
    ]
    assert "isn't open" not in caplog.text  # finished once
    assert len(_upgrades(fake_helm)) == 1
    await http.post(f"{JOBS}/{out['job_id']}/cancel")


async def test_a_stale_job_never_finishes_a_newer_record(env):
    _, app, cluster, _, _ = env
    installs = app.state.monitoring.installs
    args = (cluster, NS, ("metrics",), InstallSettings(), {})
    await installs.begin(*args, job_id="old", project_id=None)
    assert await installs.finish(cluster, "failed", "x", job_id="old") is not None
    await installs.begin(*args, job_id="new", project_id=None)
    assert await installs.finish(cluster, "cancelled", "late", job_id="old") is None
    record = await installs.get(cluster)
    assert (record.state, record.job_id) == ("installing", "new")


async def test_reinstall_after_failure_upgrades(env):
    http, app, cluster, fake_api, fake_helm = env
    helm_writes_releases(fake_helm, fake_api, fail={"omnikrux-loki": "Error: UPGRADE FAILED: no\n"})
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["metrics", "logs"]))
    assert (await wait_job(http, out["job_id"]))["state"] == "failed"

    helm_writes_releases(fake_helm, fake_api)
    plan = await install_plan(http, cluster, ["metrics", "logs"])
    assert plan["title"] == "Update monitoring tools in monitoring" and plan["blocked"] == []
    out = await apply(http, plan)
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    assert [c.args[2] for c in _upgrades(fake_helm)] == [
        "omnikrux-metrics",
        "omnikrux-loki",
        "omnikrux-metrics",
        "omnikrux-loki",
        "omnikrux-alloy",
    ]
    record = await app.state.monitoring.installs.get(cluster)
    assert record.state == "installed" and record.job_id == out["job_id"]
    # The second run reused the sources of the first: still one of each.
    ours = [
        s for s in (await http.get("/api/monitoring/sources")).json() if s["installed_by_omnikrux"]
    ]
    assert sorted(s["type"] for s in ours) == ["alertmanager", "loki", "prometheus"]


async def test_cluster_removed_during_install(env):
    http, app, cluster, _, fake_helm = env
    fake_helm.hang = {"upgrade"}
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    await wait_until(lambda: bool(_upgrades(fake_helm)))
    assert (await http.delete(f"/api/clusters/{cluster}")).status_code == 204
    message = REMOVED.format(action="install")
    assert message == "The cluster was removed from OmniKrux, so the install stopped."
    job = app.state.jobs.get(out["job_id"])
    assert (job.state, job.message) == ("failed", message)
    record = await app.state.monitoring.installs.get(cluster)
    assert (record.state, record.message) == ("failed", message)
    [call] = _upgrades(fake_helm)
    assert not call.kubeconfig.parent.exists()


async def test_apply_while_shutting_down_installs_nothing(env):
    http, app, cluster, fake_api, fake_helm = env
    plan = await install_plan(http, cluster, ["logs"])
    await app.state.jobs.close()
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (
        503,
        "OmniKrux is shutting down; nothing was installed.",
    )
    assert fake_api.created_objects == [] and _upgrades(fake_helm) == []


async def test_the_kinds_are_read_again_after_the_install(env):
    """The cluster's kinds are discovered again after the CRDs are written, so a review right
    after the install sees the new kinds (no "not served" for five minutes)."""
    http, _, cluster, fake_api, _ = env
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["metrics"]))
    assert (await wait_job(http, out["job_id"]))["state"] == "succeeded"
    before = fake_api.paths.count("/apis")
    await install_plan(http, cluster, ["metrics"])
    assert fake_api.paths.count("/apis") > before


async def test_installed_cluster_fixture(installed_cluster, monitoring_app):
    _, app = monitoring_app
    assert set(installed_cluster.sources) == {"prometheus", "alertmanager", "loki"}
    record = await app.state.monitoring.installs.get(installed_cluster.cluster_id)
    assert record.state == "installed"


async def test_a_stop_says_what_stays(env):
    """OmniKrux stopping mid-install (a graceful shutdown) leaves the record with the words a
    restart gives: what stays, and the next step."""
    http, app, cluster, _, fake_helm = env
    fake_helm.hang = {"upgrade"}
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    await wait_until(lambda: bool(_upgrades(fake_helm)))
    await app.state.jobs.close()
    record = await app.state.monitoring.installs.get(cluster)
    message = INTERRUPTED.format(what="install")
    assert message == (
        "OmniKrux stopped during the install. What Helm applied stays as Helm left it. "
        "Open Monitoring tools to see what's there, then run it again."
    )
    assert (record.state, record.message) == ("failed", message)
    assert app.state.jobs.get(out["job_id"]).state == "failed"
    [call] = _upgrades(fake_helm)
    assert not call.kubeconfig.parent.exists()


async def test_helm_timeout_reads_naturally(env):
    http, _, cluster, _, fake_helm = env

    async def too_long(args):
        return timed_out("", "", 720.0)

    fake_helm.script["upgrade"] = too_long
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    job = await wait_job(http, out["job_id"])
    assert job["message"] == (
        "Helm didn't finish installing omnikrux-loki within 12 minutes. What Helm applied stays "
        "as Helm left it (unknown). Check the Pods in monitoring, then install again, or "
        "uninstall the tools."
    )


async def test_cancel_while_waiting_keeps_the_names(env):
    http, _, cluster, fake_api, _ = env
    mark_all_ready(fake_api, NS, except_=("omnikrux-loki",))
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    job_id = out["job_id"]
    while not (await http.get(f"{JOBS}/{job_id}")).json()["blocked"]:
        await asyncio.sleep(0.01)
    job = (await http.post(f"{JOBS}/{job_id}/cancel")).json()
    assert job["state"] == "cancelled"
    assert job["message"].startswith("Install cancelled while waiting for Loki to be ready. ")


def _sized(generation: int, status: dict) -> dict:
    return {"metadata": {"generation": generation}, "spec": {"replicas": 1}, "status": status}


def _upgrade_status(**status) -> dict:
    return {"observedGeneration": 2, "replicas": 1, "readyReplicas": 1, **status}


@pytest.mark.parametrize(
    ("kind", "obj", "ready"),
    [
        ("Deployment", _sized(1, rolled_out("Deployment", ready=True)), True),
        # The controller hasn't seen the new spec yet: the old version's status says nothing.
        ("Deployment", _sized(2, rolled_out("Deployment", ready=True)), False),
        # A 1-replica upgrade: the old Pod still ready, the new one not (2 replicas, 1 updated).
        (
            "Deployment",
            _sized(2, _upgrade_status(replicas=2, updatedReplicas=1, availableReplicas=1)),
            False,
        ),
        ("Deployment", _sized(2, _upgrade_status(availableReplicas=1)), False),
        ("StatefulSet", _sized(1, rolled_out("StatefulSet", ready=True)), True),
        (
            "StatefulSet",
            _sized(2, _upgrade_status(updatedReplicas=0, currentRevision="a", updateRevision="b")),
            False,
        ),
        (
            "StatefulSet",
            _sized(2, _upgrade_status(updatedReplicas=1, currentRevision="a", updateRevision="b")),
            False,
        ),
        (
            "DaemonSet",
            {"metadata": {"generation": 1}, "status": rolled_out("DaemonSet", ready=True)},
            True,
        ),
        (
            "DaemonSet",
            {
                "metadata": {"generation": 2},
                "status": {
                    "observedGeneration": 2,
                    "desiredNumberScheduled": 1,
                    "updatedNumberScheduled": 0,
                    "numberReady": 1,
                    "numberAvailable": 1,
                },
            },
            False,
        ),
        ("DaemonSet", {"status": {"desiredNumberScheduled": 0}}, False),
    ],
)
def test_ready_means_the_new_version_is_rolled_out(kind, obj, ready):
    assert is_ready(kind, obj) is ready


async def test_an_upgrade_whose_new_pods_fail_is_not_ready(env):
    """Install again: the new Alloy version's Pod can't pull its image while the old one still
    runs. The job waits, names why, and never says the tools are running."""
    http, _, cluster, fake_api, _ = env
    mark_all_ready(fake_api, NS)
    out = await apply(http, await install_plan(http, cluster, ["logs"]))
    assert (await wait_job(http, out["job_id"]))["state"] == "succeeded"

    plan = await install_plan(http, cluster, ["logs"])
    alloy = fake_api.objects["deployments.apps"][(NS, "omnikrux-alloy")]
    alloy["metadata"]["generation"] = 2  # what Helm's upgrade does to the spec
    alloy["status"] = _upgrade_status(replicas=2, updatedReplicas=1, availableReplicas=1)
    labels = alloy["spec"]["selector"]["matchLabels"]
    fake_api.pods[(NS, "omnikrux-alloy-new")] = waiting_pod(
        NS, "omnikrux-alloy-new", labels, "ImagePullBackOff", "Back-off pulling image"
    )
    out = await apply(http, plan)
    job_id = out["job_id"]
    while True:
        job = (await http.get(f"{JOBS}/{job_id}")).json()
        assert job["state"] == "running", job
        if job["blocked"] and job["blocked"][0]["name"] == "Deployment omnikrux-alloy":
            break
        await asyncio.sleep(0.01)
    assert job["blocked"] == [
        {
            "namespace": NS,
            "name": "Deployment omnikrux-alloy",
            "message": "ImagePullBackOff: Back-off pulling image",
        }
    ]
    assert job["message"] == "Waiting for Grafana Alloy to be ready (0 of 1)…"
    alloy["status"] = rolled_out("Deployment", ready=True, generation=2)
    assert (await wait_job(http, job_id))["state"] == "succeeded"
