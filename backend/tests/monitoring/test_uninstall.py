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
from tests.fakekube import CRDS_KEY, TOKEN, FakeResource, PodStore, helm_release_secret
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
ADMISSION = "Removes the Secret omnikrux-metrics-admission that the metrics chart's setup job made."
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
    contact_settings(fake_api, NS)
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
        ADMISSION,
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
    assert deleting["summary"][4] == (
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
    # 3 releases + 7 workloads + the Operator's resources + contact settings + sources.
    assert job["done"] == job["total"] == 3 + 7 + 1 + 1 + 1
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
    assert ("", NS) in fake_api.objects["namespaces"]
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
    http, app, installed, fake_api, fake_helm, cluster = env
    del fake_api.objects["secrets"][(NS, "sh.helm.release.v1.omnikrux-loki.v1")]
    fake_api.objects["statefulsets.apps"].pop((NS, "omnikrux-loki"), None)
    plan = await uninstall_plan(http, installed.cluster_id)
    assert plan["summary"][0] == (
        f"Removes the Helm releases omnikrux-alloy and omnikrux-metrics from {cluster}."
    )
    job = await wait_job(http, (await apply(http, plan))["job_id"])
    assert job["state"] == "succeeded", job
    assert [c.args[1] for c in _uninstalls(fake_helm)] == ["omnikrux-alloy", "omnikrux-metrics"]
    assert await app.state.monitoring.installs.get(installed.cluster_id) is None


def _unmark(fake_api, release: str) -> None:
    """The release's record without OmniKrux's mark (a `helm upgrade` without --reuse-values)."""
    chart = {"omnikrux-loki": "loki", "omnikrux-alloy": "alloy"}.get(release, "kps")
    fake_api.objects["secrets"][(NS, f"sh.helm.release.v1.{release}.v1")] = helm_release_secret(
        NS, release, 1, "deployed", chart=chart, version="1.0.0", managed_by_omnikrux=False
    )


async def test_a_release_without_our_mark_is_never_removed(env):
    http, _, installed, fake_api, fake_helm, cluster = env
    _unmark(fake_api, "omnikrux-loki")
    plan = await uninstall_plan(http, installed.cluster_id)
    assert plan["summary"][:2] == [
        f"Removes the Helm releases omnikrux-alloy and omnikrux-metrics from {cluster}.",
        (
            "Keeps the Helm release omnikrux-loki in monitoring: it doesn't carry OmniKrux's "
            "mark, so OmniKrux leaves it as it is."
        ),
    ]
    before = plan["diff"]["before"]
    assert "\n  omnikrux-alloy:" in before and "\n  omnikrux-loki:" not in before
    job = await wait_job(http, (await apply(http, plan))["job_id"])
    assert job["state"] == "succeeded", job
    assert [c.args[1] for c in _uninstalls(fake_helm)] == ["omnikrux-alloy", "omnikrux-metrics"]
    assert (NS, "sh.helm.release.v1.omnikrux-loki.v1") in fake_api.objects["secrets"]
    assert (NS, "omnikrux-loki") in fake_api.objects["statefulsets.apps"]


async def test_a_mark_lost_after_the_review_is_refused(env):
    http, app, installed, fake_api, fake_helm, _ = env
    plan = await uninstall_plan(http, installed.cluster_id)
    _unmark(fake_api, "omnikrux-alloy")  # same revision, mark gone
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert (r.status_code, r.json()["detail"]) == (
        409,
        "The monitoring tools in monitoring changed since you reviewed this. Review it again.",
    )
    assert _uninstalls(fake_helm) == []
    assert (await app.state.monitoring.installs.get(installed.cluster_id)).state == "installed"


def _operator_resources(fake_api, *, finalizers: list[str] | None = None) -> None:
    """The metrics release's Prometheus and Alertmanager (served kinds added)."""
    group = "monitoring.coreos.com"
    for plural, kind in (("prometheuses", "Prometheus"), ("alertmanagers", "Alertmanager")):
        if not any(r.plural == plural for r in fake_api.resources):
            fake_api.resources.append(FakeResource(group, "v1", plural, kind, True))
        name = f"omnikrux-metrics-{kind.lower()}"
        meta = {
            "name": name,
            "namespace": NS,
            "uid": f"u-{plural}",
            "labels": {"app.kubernetes.io/instance": "omnikrux-metrics"},
        }
        if finalizers:
            meta["finalizers"] = finalizers
            meta["deletionTimestamp"] = "2026-11-24T10:00:00Z"
        fake_api.objects[f"{plural}.{group}"][(NS, name)] = {
            "apiVersion": f"{group}/v1",
            "kind": kind,
            "metadata": meta,
        }


async def test_the_operator_resources_go_before_the_operator(env):
    http, _, installed, fake_api, fake_helm, _ = env
    _operator_resources(fake_api)
    removes = fake_helm.script["uninstall"]
    seen: dict[str, bool] = {}

    async def watch(args):
        if args[1] == "omnikrux-metrics":
            seen["left"] = bool(fake_api.objects["prometheuses.monitoring.coreos.com"])
        return await removes(args)

    fake_helm.script["uninstall"] = watch
    job = await wait_job(
        http, (await apply(http, await uninstall_plan(http, installed.cluster_id)))["job_id"]
    )
    assert job["state"] == "succeeded", job
    assert seen == {"left": False}
    paths = [d["path"] for d in fake_api.deletes]
    assert paths[:2] == [
        f"/apis/monitoring.coreos.com/v1/namespaces/{NS}/prometheuses/omnikrux-metrics-prometheus",
        (
            f"/apis/monitoring.coreos.com/v1/namespaces/{NS}/alertmanagers/"
            "omnikrux-metrics-alertmanager"
        ),
    ]


class _Sticky(PodStore):
    """Objects a DELETE never removes (held by a finalizer)."""

    def pop(self, key, *default):
        return self[key]


async def test_a_resource_held_by_a_finalizer_is_named(env, monkeypatch):
    http, app, installed, fake_api, fake_helm, _ = env
    ticks = itertools.count(0, 200)
    monkeypatch.setattr(uninstall_job, "CLOCK", lambda: next(ticks))
    _operator_resources(fake_api, finalizers=["example.test/hold"])
    key = "prometheuses.monitoring.coreos.com"
    sticky = _Sticky()
    sticky.update(fake_api.objects[key])
    fake_api.objects[key] = sticky
    job = await wait_job(
        http, (await apply(http, await uninstall_plan(http, installed.cluster_id)))["job_id"]
    )
    assert job["state"] == "failed"
    assert job["message"] == (
        "The Prometheus monitoring/omnikrux-metrics-prometheus was still being deleted after 5 "
        "minutes; it waits for example.test/hold. OmniKrux never removes that by force. What was "
        "already removed stays removed. Check it in monitoring, then uninstall again."
    )
    # Never by force: no write to the object beyond its delete.
    assert not any("prometheuses" in w["path"] for w in fake_api.writes)
    assert "omnikrux-metrics" not in [c.args[1] for c in _uninstalls(fake_helm)]
    assert (await app.state.monitoring.installs.get(installed.cluster_id)).state == "failed"


async def test_a_cancel_while_removing_sources_finishes_their_audit(env, monkeypatch):
    http, app, installed, _, _, _ = env
    services = app.state.monitoring
    entered = asyncio.Event()
    delete = services.sources.delete

    async def slow_delete(source_id, **kw):
        await delete(source_id, **kw)  # committed
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(services.sources, "delete", slow_delete)
    out = await apply(http, await uninstall_plan(http, installed.cluster_id))
    await asyncio.wait_for(entered.wait(), 10)
    job = (await http.post(f"{JOBS}/{out['job_id']}/cancel")).json()
    assert job["state"] == "cancelled"
    assert job["message"].startswith("Uninstall cancelled while removing the sources. ")
    [removed] = [r for r in await _audit(http) if r["action"] == "source_remove"]
    assert removed["outcome"] == "succeeded"  # its delete had committed


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


async def test_the_metrics_charts_admission_secret_goes(env):
    """The kube-prometheus-stack hook Job makes a TLS Secret Helm doesn't own, so `helm uninstall`
    leaves it: the uninstall removes it by its exact name and uid, after the metrics release."""
    http, _, installed, fake_api, fake_helm, _ = env
    key = (NS, "omnikrux-metrics-admission")
    fake_api.objects["secrets"][key] = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": key[1], "namespace": NS, "uid": "u-admission"},
        "type": "kubernetes.io/tls",
        "data": {},
    }
    plan = await uninstall_plan(http, installed.cluster_id)
    assert ADMISSION in plan["summary"]
    job = await wait_job(http, (await apply(http, plan))["job_id"])
    assert job["state"] == "succeeded", job
    path = f"/api/v1/namespaces/{NS}/secrets/omnikrux-metrics-admission"
    [deleted] = [d for d in fake_api.deletes if d["path"] == path]
    assert deleted["body"]["preconditions"] == {"uid": "u-admission"}
    assert key not in fake_api.objects["secrets"]
    assert [c.args[1] for c in _uninstalls(fake_helm)][-1] == "omnikrux-metrics"


async def test_contact_settings_someone_else_made_stay(env):
    http, _, installed, fake_api, _, _ = env
    contact_settings(fake_api, NS, ours=False)
    plan = await uninstall_plan(http, installed.cluster_id)
    assert CONTACTS not in plan["summary"]  # nothing of OmniKrux's to remove
    out = await apply(http, plan)
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


IF_THERE = (
    "Removes OmniKrux's contact-point settings (AlertmanagerConfig omnikrux-contact-points and "
    "its Secret) if they're there."
)


async def test_contact_settings_written_after_the_review_are_removed(env, monkeypatch):
    """A contact-point sync that writes after the uninstall's review (and its check at apply)
    leaves nothing behind: the job removes OmniKrux's settings whatever the review saw."""
    http, app, installed, fake_api, _, _ = env
    plan = await uninstall_plan(http, installed.cluster_id)
    assert IF_THERE in plan["summary"] and CONTACTS not in plan["summary"]
    installs = app.state.monitoring.installs
    real = installs.begin_uninstall

    async def late_sync(cluster_id, *, job_id):
        contact_settings(fake_api, NS)  # written between the apply's check and the job
        return await real(cluster_id, job_id=job_id)

    monkeypatch.setattr(installs, "begin_uninstall", late_sync)
    out = await apply(http, plan)
    assert (await wait_job(http, out["job_id"]))["state"] == "succeeded"
    assert (NS, AMC_NAME) not in fake_api.objects["secrets"]
    assert (NS, AMC_NAME) not in fake_api.objects["alertmanagerconfigs.monitoring.coreos.com"]
