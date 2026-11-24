"""Uninstalling the monitoring tools: its own review (what goes, what stays, typed on production,
blocked while rules run in the tools or a job runs), then a job that removes the Helm releases,
waits for them to stop, removes the contact-point settings, the data when asked and the sources,
and finally the install record. The namespace and the CRDs stay."""

import asyncio
import itertools

import pytest

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.monitoring.alerts.store import RuleSpec, TargetSpec
from omnikrux.monitoring.alerts.types import Condition
from omnikrux.monitoring.install import uninstall as uninstall_job
from omnikrux.monitoring.install.kubeconfig import LONGEST_HELM_CALL_SECONDS
from omnikrux.monitoring.install.settings import InstallSettings
from omnikrux.monitoring.install.values import AMC_NAME
from tests.actions.clusters import kubeconfig_named
from tests.fakekube import CRDS_KEY, TOKEN
from tests.monitoring.install_env import (
    JOBS,
    apply,
    contact_settings,
    data_volume,
    helm_uninstall_removes,
    install_plan,
    wait_job,
    wait_until,
)

NS = "monitoring"
PRODUCTION = "This is a production cluster."
KEEPS_NAMESPACE = (
    "Keeps the namespace monitoring and the monitoring.coreos.com resource definitions, so "
    "objects other tools made aren't touched."
)
CONTACTS = (
    "Removes OmniKrux's contact-point settings from its Alertmanager (AlertmanagerConfig and "
    "Secret omnikrux-contact-points)."
)
VOLUMES = {
    "alertmanager-omnikrux-metrics-alertmanager-db-alertmanager-omnikrux-metrics-alertmanager-0": (
        "omnikrux-metrics-alertmanager"
    ),
    "prometheus-omnikrux-metrics-prometheus-db-prometheus-omnikrux-metrics-prometheus-0": (
        "omnikrux-metrics-prometheus"
    ),
    "storage-omnikrux-loki-0": "omnikrux-loki",
}


def plan_url(cluster_id: str) -> str:
    return f"/api/monitoring/install/clusters/{cluster_id}/uninstall/plan"


@pytest.fixture
async def env(installed_cluster, monitoring_app, fake_api, fake_helm):
    http, app = monitoring_app
    helm_uninstall_removes(fake_helm, fake_api)
    name = (await app.state.registry.get(installed_cluster.cluster_id)).name
    return http, app, installed_cluster, fake_api, fake_helm, name


async def uninstall_plan(http, cluster_id: str, **body) -> dict:
    r = await http.post(plan_url(cluster_id), json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def _project(http, name: str, source_ids: list[str]) -> str:
    r = await http.post(
        "/api/monitoring/setup",
        json={
            "name": name,
            "kind": "custom",
            "sources": [{"source_id": s} for s in source_ids],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _seed_volumes(fake_api) -> None:
    for name, instance in VOLUMES.items():
        data_volume(fake_api, NS, name, instance)
    data_volume(fake_api, NS, "someone-elses-data", "grafana")


def _uninstalls(fake_helm) -> list:
    return [c for c in fake_helm.calls if c.args[0] == "uninstall"]


async def _audit(http) -> list[dict]:
    return (await http.get("/api/audit")).json()["records"]


async def _names(http, ids) -> list[str]:
    by_id = {s["id"]: s["name"] for s in (await http.get("/api/monitoring/sources")).json()}
    return [by_id[i] for i in ids]


async def test_uninstall_review_lists_what_goes(env):
    http, _, installed, fake_api, fake_helm, cluster = env
    _seed_volumes(fake_api)
    sources = installed.sources
    await _project(http, "Shop", [sources["prometheus"], sources["loki"]])
    names = await _names(http, [sources["prometheus"], sources["alertmanager"], sources["loki"]])

    plan = await uninstall_plan(http, installed.cluster_id)
    assert plan["title"] == "Uninstall monitoring tools from monitoring"
    assert plan["apply_label"] == "Uninstall"
    assert plan["blocked"] == [] and plan["warnings"] == []
    assert plan["summary"] == [
        (
            "Removes the Helm releases omnikrux-alloy, omnikrux-loki and omnikrux-metrics from "
            f"{cluster}."
        ),
        CONTACTS,
        (
            f"Removes the sources {names[0]}, {names[1]} and {names[2]}. These projects lose "
            "them: Shop."
        ),
        'Keeps the stored data (3 volumes). Turn on "Also delete the stored data" to remove it.',
        KEEPS_NAMESPACE,
    ]
    assert plan["diff"]["after"] == ""
    before = plan["diff"]["before"]
    for release in ("omnikrux-metrics", "omnikrux-loki", "omnikrux-alloy"):
        assert release in before
    assert all(name in before for name in VOLUMES) and "someone-elses-data" not in before

    deleting = await uninstall_plan(http, installed.cluster_id, delete_data=True)
    pvcs = sorted(VOLUMES)
    assert deleting["summary"][3] == (
        f"Deletes the stored data: {pvcs[0]}, {pvcs[1]} and {pvcs[2]}. This can't be undone."
    )
    # A review writes nothing and runs no Helm.
    assert _uninstalls(fake_helm) == [] and fake_api.deletes == []


async def test_uninstall_review_of_logs_alone(
    monitoring_app, kube_cluster, fake_api, fake_helm, installed_backends, fast_install
):
    from tests.monitoring.install_env import mark_all_ready, prepare_install

    http, app = monitoring_app
    prepare_install(fake_api, fake_helm)
    mark_all_ready(fake_api, NS)
    job = await wait_job(
        http, (await apply(http, await install_plan(http, kube_cluster, ["logs"])))["job_id"]
    )
    assert job["state"] == "succeeded", job
    cluster = (await app.state.registry.get(kube_cluster)).name
    data_volume(fake_api, NS, "storage-omnikrux-loki-0", "omnikrux-loki")
    [loki] = await _names(
        http, [(await app.state.monitoring.installs.get(kube_cluster)).loki_source_id]
    )
    plan = await uninstall_plan(http, kube_cluster)
    assert plan["summary"] == [
        f"Removes the Helm releases omnikrux-alloy and omnikrux-loki from {cluster}.",
        f"Removes the source {loki}. No project uses it.",
        'Keeps the stored data (1 volume). Turn on "Also delete the stored data" to remove it.',
        KEEPS_NAMESPACE,
    ]


async def test_uninstall_without_an_install_is_404(monitoring_app, kube_cluster, fake_helm):
    http, _ = monitoring_app
    r = await http.post(plan_url(kube_cluster), json={})
    assert (r.status_code, r.json()["detail"]) == (
        404,
        "OmniKrux hasn't installed anything in this cluster.",
    )
    gone = await http.post(plan_url("nope"), json={})
    assert gone.status_code == 404


async def _tool_rule(app, project_id: str, source_id: str, name: str, *, leaving=False) -> str:
    alerts = app.state.monitoring.alerts
    rule = await alerts.create_rule(
        RuleSpec(
            name=name,
            scope_kind="project",
            scope_id=project_id,
            source_type="prometheus",
            source_id=source_id,
            expr="up == 0",
            condition=Condition(
                of="each", op="above", threshold=0, for_seconds=60, every_seconds=60
            ),
            engine="tool",
        )
    )
    await alerts.put_targets(
        rule.id,
        [
            TargetSpec(
                project_id=project_id,
                engine="tool",
                engine_note=None,
                source_id=source_id,
                eval_expr="up == 0",
                rule_text="up == 0",
                tool_kind="prometheus_rule",
            )
        ],
    )
    if leaving:
        await alerts.put_targets(rule.id, [])
    return rule.id


async def test_uninstall_waits_for_rules_that_run_in_the_tools(env):
    http, app, installed, _, fake_helm, _ = env
    pid = await _project(http, "Shop", [installed.sources["prometheus"]])
    await _tool_rule(app, pid, installed.sources["prometheus"], "Node down")
    await _tool_rule(app, pid, installed.sources["prometheus"], "Gone soon", leaving=True)
    plan = await uninstall_plan(http, installed.cluster_id)
    assert plan["blocked"] == [
        (
            "Move or remove the alert rules that run in these tools first: Node down. Each "
            "opens its own review."
        )
    ]
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert r.status_code == 422
    assert _uninstalls(fake_helm) == []


async def test_uninstall_waits_for_a_running_install(env):
    http, app, installed, _, fake_helm, cluster = env
    raced = await uninstall_plan(http, installed.cluster_id)
    fake_helm.hang = {"upgrade"}
    upgrades = sum(c.args[0] == "upgrade" for c in fake_helm.calls)
    out = await apply(http, await install_plan(http, installed.cluster_id, ["metrics", "logs"]))
    await wait_until(lambda: sum(c.args[0] == "upgrade" for c in fake_helm.calls) > upgrades)
    busy = f"OmniKrux is installing in {cluster} right now. Wait for it to finish, or cancel it."
    plan = await uninstall_plan(http, installed.cluster_id)
    assert busy in plan["blocked"]
    r = await http.post(f"/api/actions/{raced['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (409, busy)
    assert _uninstalls(fake_helm) == []
    record = await app.state.monitoring.installs.get(installed.cluster_id)
    assert (record.state, record.job_id) == ("installing", out["job_id"])
    [refused] = [x for x in await _audit(http) if x["action"] == "uninstall"]
    assert (refused["outcome"], refused["message"]) == ("failed", busy)
    await http.post(f"{JOBS}/{out['job_id']}/cancel")


async def test_uninstall_removes_releases_settings_and_sources(env):
    http, app, installed, fake_api, fake_helm, _ = env
    contact_settings(fake_api, NS)
    sources = installed.sources
    pid = await _project(http, "Shop", [sources["prometheus"]])
    names = await _names(http, [sources["prometheus"], sources["alertmanager"], sources["loki"]])
    plan = await uninstall_plan(http, installed.cluster_id)
    out = await apply(http, plan)
    assert out["outcome"] == "started"
    assert out["message"] == "Uninstalling the monitoring tools from monitoring…"
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    assert job["message"] == "Uninstalled from monitoring. The stored data stays."
    assert job["done"] == job["total"] == 3 + 7 + 1 + 1
    assert job["blocked"] == []

    calls = _uninstalls(fake_helm)
    assert [c.args[1] for c in calls] == ["omnikrux-alloy", "omnikrux-loki", "omnikrux-metrics"]
    for call in calls:
        assert call.args[call.args.index("--namespace") + 1] == NS
        assert call.timeout is not None and call.timeout <= LONGEST_HELM_CALL_SECONDS
        assert call.kubeconfig_text is not None and TOKEN in call.kubeconfig_text
        assert all(TOKEN not in a for a in call.args)
    assert len({c.kubeconfig.parent for c in calls}) == 3
    assert not any(c.kubeconfig.parent.exists() for c in calls)

    deleted = [d["path"] for d in fake_api.deletes]
    assert deleted == [
        f"/apis/monitoring.coreos.com/v1alpha1/namespaces/{NS}/alertmanagerconfigs/{AMC_NAME}",
        f"/api/v1/namespaces/{NS}/secrets/{AMC_NAME}",
    ]
    assert [d["body"]["preconditions"] for d in fake_api.deletes] == [
        {"uid": "u-amc"},
        {"uid": "u-amc-secret"},
    ]
    # The namespace and the CRDs stay.
    assert ("", NS) in fake_api.objects["namespaces"] or any(
        o["kind"] == "Namespace" for o in fake_api.created_objects
    )
    assert not any(
        "/namespaces/monitoring" == p or "customresourcedefinitions" in p for p in deleted
    )
    assert len([k for k in fake_api.objects[CRDS_KEY] if "monitoring.coreos.com" in k[1]]) == 5

    left = (await http.get("/api/monitoring/sources")).json()
    assert not any(s["installed_by_omnikrux"] for s in left)
    assert (await http.get(f"/api/monitoring/projects/{pid}")).json()["links"] == []
    audit = await _audit(http)
    removes = [r for r in audit if r["action"] == "source_remove"]
    assert sorted(r["name"] for r in removes) == sorted(names)
    assert all(r["outcome"] == "succeeded" for r in removes)
    [record] = [r for r in audit if r["action"] == "uninstall"]
    assert (record["outcome"], record["message"]) == ("succeeded", job["message"])
    assert (record["kind"], record["name"]) == ("namespaces", NS)
    assert await app.state.monitoring.installs.get(installed.cluster_id) is None


@pytest.mark.parametrize("delete_data", [False, True])
async def test_uninstall_keeps_data_unless_asked(env, delete_data):
    http, _, installed, fake_api, _, _ = env
    _seed_volumes(fake_api)
    out = await apply(
        http, await uninstall_plan(http, installed.cluster_id, delete_data=delete_data)
    )
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    left = {k[1] for k in fake_api.objects["persistentvolumeclaims"] if k[0] == NS}
    if delete_data:
        assert job["message"] == "Uninstalled from monitoring. The stored data was deleted."
        assert left == {"someone-elses-data"}
        pvc_deletes = [d for d in fake_api.deletes if "persistentvolumeclaims" in d["path"]]
        assert sorted(d["body"]["preconditions"]["uid"] for d in pvc_deletes) == sorted(
            f"u-pvc-{n}" for n in VOLUMES
        )
    else:
        assert job["message"] == "Uninstalled from monitoring. The stored data stays."
        assert left == {*VOLUMES, "someone-elses-data"}
        assert not any("persistentvolumeclaims" in d["path"] for d in fake_api.deletes)


async def test_uninstall_on_production_asks_for_the_namespace(monitoring_app, fake_api, fake_helm):
    http, app = monitoring_app
    [info] = await app.state.registry.upsert_from_kubeconfig(
        kubeconfig_named(fake_api, "prod-east"), rewrite_loopback=False, source=SOURCE_UPLOAD
    )
    assert info.environment.value == "production"
    installs = app.state.monitoring.installs
    await installs.begin(info.id, NS, ("logs",), InstallSettings(), {}, job_id="j", project_id=None)
    await installs.finish(info.id, "installed", "done", job_id="j")
    plan = await uninstall_plan(http, info.id)
    assert plan["confirm_text"] == NS
    assert plan["warnings"][0] == PRODUCTION
    wrong = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={"confirm_text": "x"})
    assert (wrong.status_code, wrong.json()["detail"]) == (422, "Type monitoring to confirm")
    assert [c for c in fake_helm.calls if c.args[0] == "uninstall"] == []


async def test_uninstall_review_opens_on_cancel_shape(env):
    http, _, installed, *_ = env
    plan = await uninstall_plan(http, installed.cluster_id)
    assert plan["action"] == "uninstall"
    assert plan["apply_label"] == "Uninstall"
    assert plan["target"] == {
        "cluster_id": installed.cluster_id,
        "kind_key": "namespaces",
        "namespace": None,
        "name": NS,
    }
    # Not production: nothing to type; the dialog opens on Cancel (a destructive action).
    assert plan["confirm_text"] is None


async def test_a_release_already_gone_counts_as_removed(env):
    http, app, installed, fake_api, fake_helm, _ = env
    del fake_api.objects["secrets"][(NS, "sh.helm.release.v1.omnikrux-loki.v1")]
    for name in ("omnikrux-loki",):
        fake_api.objects["statefulsets.apps"].pop((NS, name), None)
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    assert [c.args[1] for c in _uninstalls(fake_helm)] == [
        "omnikrux-alloy",
        "omnikrux-loki",
        "omnikrux-metrics",
    ]
    assert await app.state.monitoring.installs.get(installed.cluster_id) is None


async def test_helm_failure_says_what_stays_removed(env):
    http, app, installed, fake_api, fake_helm, _ = env
    helm_uninstall_removes(
        fake_helm, fake_api, fail={"omnikrux-loki": f"Error: uninstall: Bearer {TOKEN} refused\n"}
    )
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "failed"
    assert job["message"] == (
        "Helm couldn't uninstall omnikrux-loki: uninstall: Bearer ••• refused. What Helm removed "
        "stays removed. Check monitoring, then uninstall again."
    )
    assert TOKEN not in (await http.get("/api/audit")).text
    assert [c.args[1] for c in _uninstalls(fake_helm)] == ["omnikrux-alloy", "omnikrux-loki"]
    record = await app.state.monitoring.installs.get(installed.cluster_id)
    assert (record.state, record.message) == ("failed", job["message"])
    # The sources stay until everything else went.
    assert (
        len(
            [
                s
                for s in (await http.get("/api/monitoring/sources")).json()
                if s["installed_by_omnikrux"]
            ]
        )
        == 3
    )

    helm_uninstall_removes(fake_helm, fake_api)
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    assert (await wait_job(http, out["job_id"]))["state"] == "succeeded"
    assert await app.state.monitoring.installs.get(installed.cluster_id) is None


async def test_cancel_says_what_stays_removed(env):
    http, app, installed, _, fake_helm, _ = env
    fake_helm.hang = {"uninstall"}
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    await wait_until(lambda: bool(_uninstalls(fake_helm)))
    job = (await http.post(f"{JOBS}/{out['job_id']}/cancel")).json()
    message = (
        "Uninstall cancelled while removing omnikrux-alloy with Helm. What was already removed "
        "stays removed. Uninstall again to finish."
    )
    assert (job["state"], job["message"]) == ("cancelled", message)
    record = await app.state.monitoring.installs.get(installed.cluster_id)
    assert (record.state, record.message) == ("cancelled", message)
    [audit] = [r for r in await _audit(http) if r["action"] == "uninstall"]
    assert (audit["outcome"], audit["message"]) == ("failed", message)
    [call] = _uninstalls(fake_helm)
    assert not call.kubeconfig.parent.exists()


async def test_uninstall_waits_for_workloads_to_stop(env):
    http, _, installed, fake_api, fake_helm, _ = env
    stays = fake_api.objects["deployments.apps"][(NS, "omnikrux-alloy")]
    removes = fake_helm.script["uninstall"]

    async def leaves_alloy(args):
        result = await removes(args)
        if args[1] == "omnikrux-alloy":
            fake_api.objects["deployments.apps"][(NS, "omnikrux-alloy")] = stays
        return result

    fake_helm.script["uninstall"] = leaves_alloy
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    job_id = out["job_id"]
    while not (job := (await http.get(f"{JOBS}/{job_id}")).json())["blocked"]:
        assert job["state"] == "running", job
        await asyncio.sleep(0.01)
    assert job["message"] == "Waiting for Grafana Alloy to stop…"
    assert job["blocked"] == [
        {
            "namespace": NS,
            "name": "Deployment omnikrux-alloy",
            "message": "Kubernetes is still removing it",
        }
    ]
    del fake_api.objects["deployments.apps"][(NS, "omnikrux-alloy")]
    assert (await wait_job(http, job_id))["state"] == "succeeded"


async def test_workloads_that_never_stop(env, monkeypatch):
    http, app, installed, fake_api, fake_helm, _ = env
    ticks = itertools.count(0, 200)
    monkeypatch.setattr(uninstall_job, "CLOCK", lambda: next(ticks))
    stays = fake_api.objects["statefulsets.apps"][(NS, "omnikrux-loki")]
    removes = fake_helm.script["uninstall"]

    async def leaves_loki(args):
        result = await removes(args)
        fake_api.objects["statefulsets.apps"][(NS, "omnikrux-loki")] = stays
        return result

    fake_helm.script["uninstall"] = leaves_loki
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "failed"
    assert job["message"] == (
        "Loki was still there after 5 minutes: Kubernetes is still removing it. What was already "
        "removed stays removed. Check monitoring, then uninstall again."
    )
    record = await app.state.monitoring.installs.get(installed.cluster_id)
    assert record.state == "failed"


async def test_contact_settings_someone_else_made_stay(env):
    http, _, installed, fake_api, _, _ = env
    contact_settings(fake_api, NS, ours=False)
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    assert (await wait_job(http, out["job_id"]))["state"] == "succeeded"
    assert fake_api.deletes == []
    assert (NS, AMC_NAME) in fake_api.objects["secrets"]


async def test_stale_review_is_refused(env):
    http, app, installed, fake_api, fake_helm, _ = env
    plan = await uninstall_plan(http, installed.cluster_id)
    data_volume(fake_api, NS, "storage-omnikrux-loki-0", "omnikrux-loki")
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (
        409,
        "The monitoring tools in monitoring changed since you reviewed this. Review it again.",
    )
    assert _uninstalls(fake_helm) == []
    record = await app.state.monitoring.installs.get(installed.cluster_id)
    assert record.state == "installed"


async def test_a_stop_says_what_stays(env):
    http, app, installed, _, fake_helm, _ = env
    fake_helm.hang = {"uninstall"}
    await apply(http, await uninstall_plan(http, installed.cluster_id))
    await wait_until(lambda: bool(_uninstalls(fake_helm)))
    await app.state.jobs.close()
    record = await app.state.monitoring.installs.get(installed.cluster_id)
    assert (record.state, record.message) == (
        "failed",
        (
            "OmniKrux stopped during the uninstall. What Helm applied stays as Helm left it. "
            "Open Monitoring tools to see what's there, then run it again."
        ),
    )
