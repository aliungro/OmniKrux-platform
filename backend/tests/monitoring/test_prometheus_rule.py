"""Rules that run in Prometheus: each target's PrometheusRule is reviewed, confirmed, audited and
applied through the action pipeline, against a fake Kubernetes API running the Operator."""

from dataclasses import dataclass

import pytest

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.monitoring.alerts.tool import prometheus_rule
from omnikrux.monitoring.alerts.tool.prometheus_rule import (
    CANT_TELL,
    KIND_KEY,
    NAMESPACE_UNMATCHED,
    NO_RULE_SELECTOR,
    STALE,
    UNMEETABLE,
    labels_for,
    object_name,
)
from omnikrux.monitoring.sources.connector import AlertingCapability
from tests.actions.clusters import kubeconfig_named
from tests.fakekube import FORBIDDEN, prometheus_operator, service

API = "/api/monitoring"
RULES = f"{API}/alerts/rules"
PROMETHEUSES = "prometheuses.monitoring.coreos.com"
PRODUCTION = "This is a production cluster."


@dataclass(frozen=True)
class ToolRule:
    rule_id: str
    target_id: str
    project_id: str
    source_id: str
    cluster_id: str


def rule_body(project_id: str, **over) -> dict:
    body = {
        "name": "API latency high",
        "scope": {"kind": "project", "id": project_id},
        "source": {"type": "prometheus", "id": None},
        "expr": "rate(x[5m])",
        "condition": {"op": "above", "threshold": 0.3, "for": "5m", "every": "1m"},
        "engine": "tool",
    }
    return body | over


async def make_tool_rule(http, fake_api, fake_prometheus, cluster_id: str) -> ToolRule:
    """A Prometheus reached through the cluster, a project "Apps" on it (filter `cluster="c"`)
    and a rule "API latency high" that runs in Prometheus."""
    fake_api.service_backends[("monitoring", "kps-prometheus:9090")] = fake_prometheus.url
    source = await http.post(
        f"{API}/sources",
        json={
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": cluster_id,
            "namespace": "monitoring",
            "service": "kps-prometheus",
            "port": "9090",
            "name": "In cluster",
        },
    )
    assert source.status_code == 201, source.text
    project = await http.post(
        f"{API}/setup",
        json={
            "name": "Apps",
            "kind": "custom",
            "sources": [{"source_id": source.json()["id"], "filter": 'cluster="c"'}],
        },
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["id"]
    r = await http.post(RULES, json=rule_body(project_id))
    assert r.status_code == 201, r.text
    rule = r.json()["rule"]
    [target] = rule["targets"]
    assert target["engine"] == "tool" and target["tool_state"] == "needs_review"
    return ToolRule(rule["id"], target["id"], project_id, source.json()["id"], cluster_id)


@pytest.fixture
async def tool_rule(monitoring_app, fake_api, kube_cluster, fake_prometheus) -> ToolRule:
    http, _ = monitoring_app
    prometheus_operator(fake_api)
    return await make_tool_rule(http, fake_api, fake_prometheus, kube_cluster)


@pytest.fixture
async def prod_rule(monitoring_app, fake_api, fake_prometheus) -> ToolRule:
    """`tool_rule` on a cluster registered as production."""
    http, app = monitoring_app
    prometheus_operator(fake_api)
    [info] = await app.state.registry.upsert_from_kubeconfig(
        kubeconfig_named(fake_api, "prod-east"), rewrite_loopback=False, source=SOURCE_UPLOAD
    )
    assert info.environment.value == "production"
    return await make_tool_rule(http, fake_api, fake_prometheus, info.id)


async def sync(http, tool_rule: ToolRule):
    return await http.post(f"{API}/alerts/targets/{tool_rule.target_id}/sync")


async def review(http, tool_rule: ToolRule) -> dict:
    r = await sync(http, tool_rule)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["kind"] == "review", out
    return out["plan"]


async def target(http, tool_rule: ToolRule) -> dict:
    r = await http.get(f"{RULES}/{tool_rule.rule_id}")
    assert r.status_code == 200, r.text
    [found] = [t for t in r.json()["targets"] if t["id"] == tool_rule.target_id]
    return found


async def history(http, tool_rule: ToolRule) -> list[dict]:
    r = await http.get(f"{RULES}/{tool_rule.rule_id}/history")
    assert r.status_code == 200, r.text
    return r.json()


async def apply(http, plan: dict, confirm_text: str | None = None):
    return await http.post(
        f"/api/actions/{plan['plan_id']}/apply", json={"confirm_text": confirm_text}
    )


def stored(fake_api, name: str) -> dict | None:
    return fake_api.objects[KIND_KEY].get(("monitoring", name))


async def save_rule(http, tool_rule: ToolRule, **over) -> dict:
    current = (await http.get(f"{RULES}/{tool_rule.rule_id}")).json()
    body = rule_body(tool_rule.project_id, **over) | {"base_version": current["version"]}
    r = await http.put(f"{RULES}/{tool_rule.rule_id}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def test_review_create_and_apply(monitoring_app, kube_cluster, fake_api, tool_rule):
    http, _ = monitoring_app
    plan = await review(http, tool_rule)
    name = plan["target"]["name"]
    assert name == object_name("API latency high", tool_rule.target_id)
    assert plan["action"] == "create"
    assert plan["title"] == f"Create PrometheusRule {name}"
    assert plan["title"].startswith("Create PrometheusRule omnikrux-api-latency-high-")
    assert plan["target"] == {
        "cluster_id": kube_cluster,
        "kind_key": KIND_KEY,
        "namespace": "monitoring",
        "name": name,
    }
    assert plan["summary"] == [
        (
            'Runs the alert "API latency high" in Prometheus monitoring/kps-prometheus, so it '
            "keeps firing when OmniKrux is off."
        ),
        "Alert when any series is above 0.3 for 5 min, checked every 1 min.",
    ]
    assert plan["apply_label"] == "Create rule"
    assert (plan["confirm_text"], plan["warnings"], plan["blocked"]) == (None, [], [])
    assert plan["diff"]["before"] == "" and f"name: {name}" in plan["diff"]["after"]
    assert fake_api.created_objects == []  # nothing is written by a review

    out = await apply(http, plan)
    assert out.status_code == 200, out.text
    assert out.json()["message"] == f"Created PrometheusRule monitoring/{name}."
    obj = stored(fake_api, name)
    assert obj["metadata"]["labels"] == {
        "release": "kps",
        "app.kubernetes.io/managed-by": "omnikrux",
        "omnikrux.io/target": tool_rule.target_id,
    }
    [group] = obj["spec"]["groups"]
    assert group["name"] == f"omnikrux-{tool_rule.target_id}" and group["interval"] == "1m"
    [rule] = group["rules"]
    assert rule["alert"] == "API latency high"
    assert rule["expr"] == '(rate(x{cluster="c"}[5m])\n) > 0.3'
    assert rule["for"] == "5m"
    assert rule["labels"] == {
        "severity": "warning",
        "omnikrux_rule": tool_rule.rule_id,
        "omnikrux_project": tool_rule.project_id,
    }
    assert rule["annotations"] == {
        "summary": "API latency high is above 0.3 ({{ $value }})",
        "omnikrux_rule": tool_rule.rule_id,
    }

    shown = await target(http, tool_rule)
    assert shown["tool_state"] == "in_sync" and shown["state"] == "ok"
    rec = (await http.get("/api/audit")).json()["records"][0]
    assert (rec["action"], rec["kind"], rec["app"]) == ("create", KIND_KEY, "kubernetes")
    assert (rec["cluster_id"], rec["name"], rec["outcome"]) == (kube_cluster, name, "succeeded")
    assert rec["details"]["title"] == plan["title"]
    assert [(h["kind"], h["message"]) for h in await history(http, tool_rule)] == [
        ("applied", f"Created PrometheusRule monitoring/{name}.")
    ]
    # In sync: nothing more to review.
    again = await sync(http, tool_rule)
    assert again.status_code == 200 and again.json()["kind"] == "done"
    assert again.json()["target"]["tool_state"] == "in_sync"


async def test_update_uses_edit_and_the_resource_version(monitoring_app, fake_api, tool_rule):
    http, _ = monitoring_app
    created = await review(http, tool_rule)
    assert (await apply(http, created)).status_code == 200
    name = created["target"]["name"]

    # A new name and threshold: the same object (it was named once) gets the change.
    saved = await save_rule(
        http,
        tool_rule,
        name="Latency, renamed",
        condition={"op": "above", "threshold": 0.5, "for": "0s", "every": "5m"},
    )
    assert [c["kind"] for c in saved["changes"]] == ["review"]
    assert (await target(http, tool_rule))["tool_state"] == "needs_review"

    plan = await review(http, tool_rule)
    assert plan["action"] == "edit" and plan["target"]["name"] == name
    assert plan["title"] == f"Update PrometheusRule {name}"
    assert plan["summary"] == [
        'Changes the alert "Latency, renamed" that runs in Prometheus monitoring/kps-prometheus.',
        "Alert when any series is above 0.5, checked every 5 min.",
    ]
    assert plan["apply_label"] == "Update rule" and plan["confirm_text"] is None
    assert "> 0.3" in plan["diff"]["before"] and "> 0.5" in plan["diff"]["after"]

    out = await apply(http, plan)
    assert out.status_code == 200, out.text
    assert out.json()["message"] == f"Updated PrometheusRule monitoring/{name}."
    [write] = fake_api.writes
    assert write["method"] == "PUT" and write["body"]["metadata"]["resourceVersion"] == "1"
    [rule] = stored(fake_api, name)["spec"]["groups"][0]["rules"]
    assert rule["alert"] == "Latency, renamed" and rule["expr"].endswith("> 0.5")
    assert rule["for"] == "0s"
    assert len(fake_api.objects[KIND_KEY]) == 1
    assert (await target(http, tool_rule))["tool_state"] == "in_sync"
    rec = (await http.get("/api/audit")).json()["records"][0]
    assert (rec["action"], rec["outcome"]) == ("edit", "succeeded")


async def test_nothing_to_change_reads_in_sync(monitoring_app, fake_api, tool_rule):
    http, app = monitoring_app
    plan = await review(http, tool_rule)
    assert (await apply(http, plan)).status_code == 200
    # A save that changes nothing the tool runs (a version moved): the review finds the object
    # as it should be and the target reads in sync again, with nothing written.
    await app.state.monitoring.alerts.set_tool(
        tool_rule.target_id, tool_state="needs_review", tool_message=None
    )
    out = await sync(http, tool_rule)
    assert out.status_code == 200 and out.json()["kind"] == "done"
    assert out.json()["target"]["tool_state"] == "in_sync"
    assert fake_api.writes == [] and len(fake_api.created_objects) == 1


async def test_delete_on_production_needs_the_name(monitoring_app, fake_api, prod_rule):
    http, _ = monitoring_app
    created = await review(http, prod_rule)
    name = created["target"]["name"]
    assert created["confirm_text"] is None and created["warnings"] == [PRODUCTION]
    assert (await apply(http, created)).status_code == 200

    token = (await http.get(f"{RULES}/{prod_rule.rule_id}/delete-review")).json()["token"]
    removed = await http.delete(f"{RULES}/{prod_rule.rule_id}", params={"token": token})
    assert removed.status_code == 200, removed.text
    assert [c["kind"] for c in removed.json()["changes"]] == ["review"]
    assert removed.json()["rule"] is not None  # being removed until its PrometheusRule goes

    plan = await review(http, prod_rule)
    assert plan["action"] == "delete" and plan["confirm_text"] == name
    assert plan["title"] == f"Delete PrometheusRule {name}"
    assert plan["summary"] == [
        'Stops running the alert "API latency high" in Prometheus monitoring/kps-prometheus.'
    ]
    assert plan["warnings"] == [PRODUCTION] and plan["apply_label"] == "Delete rule"
    assert plan["diff"]["after"] == ""

    wrong = await apply(http, plan, "api")
    assert wrong.status_code == 422 and wrong.json() == {"detail": f"Type {name} to confirm"}
    assert stored(fake_api, name) is not None
    out = await apply(http, plan, name)
    assert out.status_code == 200, out.text
    assert out.json()["message"] == f"Deleted PrometheusRule monitoring/{name}."
    assert stored(fake_api, name) is None
    assert fake_api.deletes[-1]["body"]["preconditions"] == {
        "uid": f"u-prometheusrules-monitoring-{name}"
    }
    # The target and the deleted rule are gone with it.
    assert (await http.get(f"{RULES}/{prod_rule.rule_id}")).status_code == 404
    rec = (await http.get("/api/audit")).json()["records"][0]
    assert (rec["action"], rec["kind"], rec["outcome"]) == ("delete", KIND_KEY, "succeeded")


async def test_stale_review_is_refused(monitoring_app, fake_api, tool_rule):
    http, _ = monitoring_app
    plan = await review(http, tool_rule)
    await save_rule(
        http, tool_rule, condition={"op": "above", "threshold": 0.9, "for": "5m", "every": "1m"}
    )
    out = await apply(http, plan)
    assert out.status_code == 409 and out.json() == {"detail": STALE}
    assert fake_api.created_objects == [] and fake_api.writes == []
    assert (await target(http, tool_rule))["tool_state"] == "needs_review"
    rec = (await http.get("/api/audit")).json()["records"][0]
    assert (rec["action"], rec["outcome"], rec["message"]) == ("create", "failed", STALE)

    # Reviewed again, it applies what the rule says now.
    plan = await review(http, tool_rule)
    assert (await apply(http, plan)).status_code == 200
    [obj] = fake_api.created_objects
    assert obj["spec"]["groups"][0]["rules"][0]["expr"].endswith("> 0.9")


async def test_failed_apply_marks_not_applied(monitoring_app, fake_api, tool_rule):
    http, _ = monitoring_app
    plan = await review(http, tool_rule)
    fake_api.mode = "forbidden"
    out = await apply(http, plan)
    fake_api.mode = "ok"
    assert out.status_code == 403, out.text
    words = out.json()["detail"]
    assert FORBIDDEN in words and "{" not in words
    shown = await target(http, tool_rule)
    assert (shown["tool_state"], shown["tool_message"]) == ("failed", words)
    assert shown["state"] == "not_applied"
    assert [(h["kind"], h["message"]) for h in await history(http, tool_rule)] == [
        ("apply_failed", words)
    ]
    rec = (await http.get("/api/audit")).json()["records"][0]
    assert (rec["outcome"], rec["message"]) == ("failed", words)
    assert fake_api.created_objects == []

    # Retry: a new review, and it applies.
    again = await review(http, tool_rule)
    assert again["action"] == "create"
    assert (await apply(http, again)).status_code == 200
    assert (await target(http, tool_rule))["tool_state"] == "in_sync"


async def test_a_second_review_of_one_change_conflicts(monitoring_app, fake_api, tool_rule):
    http, _ = monitoring_app
    first = await review(http, tool_rule)
    second = await review(http, tool_rule)
    assert (await apply(http, first)).status_code == 200
    out = await apply(http, second)
    name = first["target"]["name"]
    assert out.status_code == 409
    assert out.json() == {
        "detail": f"PrometheusRule {name} changed since you reviewed this change. Review it again."
    }
    assert len(fake_api.created_objects) == 1
    # Not a failure of the rule: reviewed again, it reads in sync with nothing to write.
    assert (await target(http, tool_rule))["tool_state"] == "needs_review"
    again = await sync(http, tool_rule)
    assert again.json()["kind"] == "done" and again.json()["target"]["tool_state"] == "in_sync"


async def test_an_unanswered_write_still_records_the_object(
    monitoring_app, fake_api, tool_rule, monkeypatch
):
    http, app = monitoring_app
    plan = await review(http, tool_rule)
    real = prometheus_rule.call_json

    async def lost(api, method, path, **kwargs):
        if method == "POST":
            await real(api, method, path, **kwargs)
            raise TimeoutError
        return await real(api, method, path, **kwargs)

    monkeypatch.setattr(prometheus_rule, "call_json", lost)
    out = await apply(http, plan)
    assert out.status_code == 502, out.text
    [stored_target] = await app.state.monitoring.alerts.targets(rule_id=tool_rule.rule_id)
    assert stored_target.tool_state == "failed"
    assert stored_target.tool_object is not None
    assert stored_target.tool_object.name == plan["target"]["name"]
    assert stored_target.applied_version is not None  # it counts as running in the cluster
    monkeypatch.setattr(prometheus_rule, "call_json", real)

    # The object did land: the next review updates it instead of creating a second one.
    again = await sync(http, tool_rule)
    assert again.status_code == 200 and again.json()["kind"] == "done"
    assert (await target(http, tool_rule))["tool_state"] == "in_sync"


async def test_blocked_when_the_selector_cannot_be_met(monitoring_app, fake_api, tool_rule):
    http, _ = monitoring_app
    prom = fake_api.objects[PROMETHEUSES][("monitoring", "kps")]

    del prom["spec"]["ruleSelector"]
    plan = await review(http, tool_rule)
    assert plan["blocked"] == [NO_RULE_SELECTOR]
    refused = await apply(http, plan)
    assert refused.status_code == 422 and refused.json() == {"detail": NO_RULE_SELECTOR}

    prom["spec"]["ruleSelector"] = {
        "matchExpressions": [{"key": "team", "operator": "NotIn", "values": ["a", "b"]}]
    }
    plan = await review(http, tool_rule)
    assert plan["blocked"] == [UNMEETABLE.format(expression="team NotIn (a, b)")]

    prom["spec"]["ruleSelector"] = {"matchLabels": {"release": "kps"}}
    prom["spec"]["ruleNamespaceSelector"] = {"matchLabels": {"team": "x"}}
    plan = await review(http, tool_rule)
    assert plan["blocked"] == [
        (
            "This Prometheus reads rules only from namespaces matching team=x, and monitoring "
            "doesn't match."
        )
    ]
    assert plan["blocked"] == [
        NAMESPACE_UNMATCHED.format(selector="team=x", namespace="monitoring")
    ]

    fake_api.objects["namespaces"][("", "monitoring")]["metadata"]["labels"]["team"] = "x"
    assert (await review(http, tool_rule))["blocked"] == []

    # A Service that names another Prometheus: OmniKrux can't tell which one answers.
    svc = fake_api.objects["services"][("monitoring", "kps-prometheus")]
    svc["spec"]["selector"] = {"operator.prometheus.io/name": "other"}
    plan = await review(http, tool_rule)
    assert plan["blocked"] == [CANT_TELL.format(namespace="monitoring", service="kps-prometheus")]
    assert fake_api.created_objects == []


def test_selector_labels():
    assert labels_for({"matchLabels": {"release": "kps"}}) == ({"release": "kps"}, None)
    assert labels_for(
        {
            "matchExpressions": [
                {"key": "role", "operator": "Exists"},
                {"key": "team", "operator": "In", "values": ["ops"]},
            ]
        }
    ) == ({"role": "true", "team": "ops"}, None)
    assert labels_for(
        {
            "matchLabels": {"team": "a"},
            "matchExpressions": [{"key": "team", "operator": "In", "values": ["b"]}],
        }
    ) == ({}, "team In (b)")
    assert labels_for({"matchExpressions": [{"key": "t", "operator": "In", "values": ["a", "b"]}]})[
        1
    ] == ("t In (a, b)")
    assert labels_for({"matchLabels": {"app.kubernetes.io/managed-by": "helm"}}) == (
        {},
        "app.kubernetes.io/managed-by=helm",
    )


def test_object_names_are_stable_and_safe():
    a = object_name("API latency high", "t1")
    assert a.startswith("omnikrux-api-latency-high-") and len(a.rsplit("-", 1)[1]) == 8
    assert object_name("API latency high", "t1") == a != object_name("API latency high", "t2")
    assert object_name("Ünïcödé ✓", "t1").startswith("omnikrux-n-c-d-")
    assert object_name("✓✓", "t1").startswith("omnikrux-rule-")
    long = object_name("x" * 100, "t1")
    assert long == f"omnikrux-{'x' * 40}-{long.rsplit('-', 1)[1]}"


async def test_cancelled_review_leaves_needs_review(monitoring_app, fake_api, tool_rule):
    http, _ = monitoring_app
    plan = await review(http, tool_rule)
    r = await http.delete(f"/api/actions/{plan['plan_id']}")
    assert r.status_code == 204
    shown = await target(http, tool_rule)
    assert shown["tool_state"] == "needs_review" and shown["state"] == "not_applied"
    assert (await apply(http, plan)).status_code == 404
    assert fake_api.created_objects == []


async def test_operator_not_served_says_so(monitoring_app, fake_api, kube_cluster, fake_prometheus):
    http, app = monitoring_app
    # The Service is there, but the cluster serves no monitoring.coreos.com kinds.
    fake_api.objects["services"][("monitoring", "kps-prometheus")] = service(
        "monitoring", "kps-prometheus", ports=[{"name": "web", "port": 9090}]
    )

    async def as_tool(source, *, refresh=False):
        return AlertingCapability(True, "prometheus_rule", None)

    app.state.monitoring.capabilities.get = as_tool
    tool_rule = await make_tool_rule(http, fake_api, fake_prometheus, kube_cluster)
    out = await sync(http, tool_rule)
    assert out.status_code == 404, out.text
    words = out.json()["detail"]
    assert words == f"This cluster doesn't serve {KIND_KEY}."
    shown = await target(http, tool_rule)
    assert (shown["tool_state"], shown["tool_message"]) == ("failed", words)
    assert fake_api.created_objects == []


async def test_unknown_target_is_refused(monitoring_app):
    http, _ = monitoring_app
    r = await http.post(f"{API}/alerts/targets/nope/sync")
    assert r.status_code == 404
    assert r.json()["detail"]["message"] == "That alert rule no longer exists."
