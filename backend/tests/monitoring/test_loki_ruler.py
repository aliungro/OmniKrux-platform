"""Rules that run in a Loki ruler: written and removed at once (no review), each change audited
first, a failure in words with a retry, and the group named and filtered per project."""

import asyncio
import json
from dataclasses import fields, replace

import yaml

from omnikrux.audit.store import AuditUnavailable
from omnikrux.monitoring.alerts.store import RuleSpec, ToolObject, UnknownRule
from omnikrux.monitoring.projects.types import ReviewChanged
from omnikrux.monitoring.sources.types import ClusterTarget
from tests.monitoring.alert_env import until
from tests.monitoring.test_rules_api import add_rule, monitoring_records, rule_body
from tests.monitoring.test_transport import config

API = "/api/monitoring"
RULES = f"{API}/alerts/rules"
TARGETS = f"{API}/alerts/targets"
ERRORS = 'sum(count_over_time({app="api"} |= "error" [5m]))'


def loki_body(project_id: str, **over) -> dict:
    values = {
        "name": "Errors",
        "source": {"type": "loki", "id": None},
        "expr": ERRORS,
        "engine": "tool",
    }
    return rule_body(project_id, **(values | over))


def stored_group(fake_loki, target_id: str) -> dict | None:
    text = fake_loki.ruler_groups.get("omnikrux", {}).get(f"omnikrux-{target_id}")
    return yaml.safe_load(text) if text is not None else None


async def target_of(http, rule_id: str) -> dict:
    [target] = (await http.get(f"{RULES}/{rule_id}")).json()["targets"]
    return target


async def test_loki_rule_is_written_and_audited(
    monitoring_app, linked_project_with_loki, fake_loki
):
    http, app = monitoring_app
    shop = linked_project_with_loki
    out = await add_rule(
        http,
        loki_body(
            shop.project_id,
            severity="critical",
            channel={"receiver": "pager", "labels": {"team": "web", "omnikrux_rule": "spoof"}},
        ),
    )
    rule = out["rule"]
    [target] = rule["targets"]
    assert target["tool"] == "loki_ruler" and target["where"] == "in Loki"
    assert target["tool_state"] == "in_sync" and target["tool_message"] is None
    # Written, not yet read back from the ruler: "waiting", never "OK". With OmniKrux's checks
    # off (as in these tests) nothing reads the ruler, and the target says so.
    assert target["state"] == "waiting"
    assert target["message"] == "Not checked yet: OmniKrux's checks are off."
    unread = await app.state.monitoring.alerts.get_target(target["id"])
    assert (unread.state, unread.message) == ("waiting", "Loading in Loki…")
    assert [(c["kind"], c["message"]) for c in out["changes"]] == [("written", None)]

    group = stored_group(fake_loki, target["id"])
    assert group is not None
    assert group["name"] == f"omnikrux-{target['id']}" and group["interval"] == "1m"
    [alert] = group["rules"]
    assert alert["alert"] == "Errors" and alert["for"] == "5m"
    assert 'cluster="a"' in alert["expr"] and alert["expr"] == target["rule_text"]
    # OmniKrux's own labels win over the channel's.
    assert alert["labels"] == {
        "team": "web",
        "severity": "critical",
        "omnikrux_rule": rule["id"],
        "omnikrux_project": shop.project_id,
    }
    assert alert["annotations"]["omnikrux_rule"] == rule["id"]
    [post] = [r for r in fake_loki.requests if r.method == "POST"]
    assert post.path == "/loki/api/v1/rules/omnikrux"
    assert post.headers["Content-Type"] == "application/yaml"

    stored = await app.state.monitoring.alerts.get_target(target["id"])
    assert stored.tool_object == ToolObject(
        "loki_ruler", shop.loki_source_id, None, "omnikrux", f"omnikrux-{target['id']}"
    )
    assert stored.applied_version == rule["version"]
    [record] = [r for r in await monitoring_records(http) if r["action"] == "loki_rule_write"]
    assert (record["kind"], record["name"], record["outcome"], record["actor"]) == (
        "loki_rule",
        "Errors",
        "succeeded",
        "local",
    )
    assert record["details"] == {
        "source": "Shop logs",
        "namespace": "omnikrux",
        "group": f"omnikrux-{target['id']}",
    }
    history = (await http.get(f"{RULES}/{rule['id']}/history")).json()
    assert [h["kind"] for h in history] == ["applied"]
    assert history[0]["message"] == (
        f"Wrote rule group omnikrux/omnikrux-{target['id']} to Shop logs."
    )

    # A save writes the group again, at once.
    saved = await http.put(
        f"{RULES}/{rule['id']}",
        json=loki_body(shop.project_id, base_version=rule["version"], name="Errors (api)"),
    )
    assert saved.status_code == 200, saved.text
    assert [c["kind"] for c in saved.json()["changes"]] == ["written"]
    [alert] = stored_group(fake_loki, target["id"])["rules"]
    assert alert["alert"] == "Errors (api)"
    assert (await target_of(http, rule["id"]))["tool_state"] == "in_sync"


async def test_loki_write_failure_marks_not_applied_and_retry_writes(
    monitoring_app, linked_project_with_loki, fake_loki
):
    http, app = monitoring_app
    shop = linked_project_with_loki
    fake_loki.ruler_fail = 500
    out = await add_rule(http, loki_body(shop.project_id))
    copy = (
        "Couldn't write the rule to Shop logs: Shop logs answered HTTP 500. "
        "Try again, or check the tool."
    )
    [change] = out["changes"]
    assert (change["kind"], change["message"]) == ("failed", copy)
    target = await target_of(http, out["rule"]["id"])
    assert target["tool_state"] == "failed" and target["tool_message"] == copy
    assert target["state"] == "not_applied" and out["rule"]["state"] == "not_applied"
    # A 5xx may have been taken anyway: the group is recorded, so a removal never forgets it.
    stored = await app.state.monitoring.alerts.get_target(target["id"])
    assert stored.tool_object is not None and stored.tool_object.kind == "loki_ruler"
    [record] = [r for r in await monitoring_records(http) if r["action"] == "loki_rule_write"]
    assert record["outcome"] == "unknown"
    history = (await http.get(f"{RULES}/{out['rule']['id']}/history")).json()
    assert [(h["kind"], h["message"]) for h in history] == [("apply_failed", copy)]

    fake_loki.ruler_fail = None
    retried = await http.post(f"{TARGETS}/{target['id']}/sync")
    assert retried.status_code == 200, retried.text
    body = retried.json()
    assert body["kind"] == "done"
    assert body["target"]["tool_state"] == "in_sync" and body["target"]["tool_message"] is None
    assert stored_group(fake_loki, target["id"]) is not None
    writes = [
        r["outcome"] for r in await monitoring_records(http) if r["action"] == "loki_rule_write"
    ]
    assert writes == ["unknown", "succeeded"]


async def test_loki_refusal_and_busy_ruler(monitoring_app, linked_project_with_loki, fake_loki):
    http, app = monitoring_app
    shop = linked_project_with_loki
    # A refusal (4xx) changed nothing in the ruler: no group recorded, in the ruler's words.
    fake_loki.fail_paths["/loki/api/v1/rules/omnikrux"] = 400
    refused = await add_rule(http, loki_body(shop.project_id))
    target = await target_of(http, refused["rule"]["id"])
    assert target["tool_message"] == "Couldn't write the rule to Shop logs: refused"
    stored = await app.state.monitoring.alerts.get_target(target["id"])
    assert stored.tool_object is None and stored.applied_version is None
    [record] = [r for r in await monitoring_records(http) if r["action"] == "loki_rule_write"]
    assert record["outcome"] == "failed"

    # A busy ruler (429): nothing written, nothing marked failed; trying again works.
    fake_loki.fail_paths.clear()
    busy = await add_rule(http, loki_body(shop.project_id, name="Warnings"))
    assert busy["changes"][0]["kind"] == "written"
    fake_loki.fail_paths["/loki/api/v1/rules/omnikrux"] = 429
    saved = await http.put(
        f"{RULES}/{busy['rule']['id']}",
        json=loki_body(shop.project_id, name="Warnings", base_version=1, severity="info"),
    )
    assert saved.status_code == 200, saved.text
    [change] = saved.json()["changes"]
    busy_copy = (
        "Couldn't write the rule to Shop logs: Shop logs is busy (HTTP 429). Try again in a moment."
    )
    assert (change["kind"], change["message"]) == ("failed", busy_copy)
    [record] = [
        r
        for r in await monitoring_records(http)
        if r["action"] == "loki_rule_write" and r["outcome"] == "failed"
    ][-1:]
    assert "429" in record["message"]
    target = await target_of(http, busy["rule"]["id"])
    # The ruler still runs the version before: no longer "in sync", but not failed either.
    assert target["tool_state"] == "needs_review" and target["tool_message"] is None
    assert target["state"] == "not_applied"


async def test_loki_rule_removed_with_its_rule(monitoring_app, linked_project_with_loki, fake_loki):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    shop = linked_project_with_loki
    rule = (await add_rule(http, loki_body(shop.project_id)))["rule"]
    target = await target_of(http, rule["id"])
    assert stored_group(fake_loki, target["id"]) is not None

    review = (await http.get(f"{RULES}/{rule['id']}/delete-review")).json()
    assert [r["project_name"] for r in review["loki_removals"]] == ["Shop"]
    gone = await http.delete(f"{RULES}/{rule['id']}", params={"token": review["token"]})
    assert gone.status_code == 200, gone.text
    assert gone.json()["rule"] is None
    assert [c["kind"] for c in gone.json()["changes"]] == ["removed"]
    assert stored_group(fake_loki, target["id"]) is None
    assert await alerts.targets() == []
    try:
        await alerts.get_rule(rule["id"])
    except UnknownRule:
        pass
    else:
        raise AssertionError("the deleted rule was not purged")
    [record] = [r for r in await monitoring_records(http) if r["action"] == "loki_rule_remove"]
    assert (record["kind"], record["name"], record["outcome"]) == (
        "loki_rule",
        "Errors",
        "succeeded",
    )
    assert record["details"]["group"] == f"omnikrux-{target['id']}"


async def test_a_failed_loki_removal_keeps_the_rule_until_a_retry(
    monitoring_app, linked_project_with_loki, fake_loki
):
    http, app = monitoring_app
    shop = linked_project_with_loki
    rule = (await add_rule(http, loki_body(shop.project_id)))["rule"]
    target = await target_of(http, rule["id"])
    fake_loki.ruler_fail = 500
    review = (await http.get(f"{RULES}/{rule['id']}/delete-review")).json()
    gone = await http.delete(f"{RULES}/{rule['id']}", params={"token": review["token"]})
    assert gone.status_code == 200, gone.text
    [change] = gone.json()["changes"]
    assert change["kind"] == "failed"
    left = gone.json()["rule"]
    assert left["removing"] is True
    [leaving] = left["targets"]
    assert leaving["leaving"] is True and leaving["tool_state"] == "failed"
    assert leaving["tool_message"] == (
        "Couldn't remove the rule from Shop logs: Shop logs answered HTTP 500. "
        "Try again, or check the tool."
    )
    assert stored_group(fake_loki, target["id"]) is not None

    fake_loki.ruler_fail = None
    retried = await http.post(f"{TARGETS}/{target['id']}/sync")
    assert retried.status_code == 200, retried.text
    assert retried.json() == {"kind": "done", "target": None}
    assert stored_group(fake_loki, target["id"]) is None
    assert await app.state.monitoring.alerts.targets() == []
    assert (await http.get(f"{RULES}/{rule['id']}")).status_code == 404


async def test_project_delete_takes_its_loki_rules_out_first(
    monitoring_app, linked_project_with_loki, fake_loki
):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    rule = (await add_rule(http, loki_body(shop.project_id)))["rule"]
    target = await target_of(http, rule["id"])
    review = (await http.get(f"{API}/projects/{shop.project_id}/delete-review")).json()

    fake_loki.ruler_fail = 503
    refused = await http.delete(
        f"{API}/projects/{shop.project_id}", params={"token": review["token"]}
    )
    assert refused.status_code == 502
    assert refused.json()["detail"] == (
        'Couldn\'t remove the rule "Errors" from Loki: Shop logs answered HTTP 503. '
        "Try again, or check the tool. Nothing was deleted."
    )
    # Taken out before the delete only: the stored target is as it was.
    kept = await target_of(http, rule["id"])
    assert kept["tool_state"] == "in_sync" and kept["leaving"] is False
    assert stored_group(fake_loki, target["id"]) is not None

    fake_loki.ruler_fail = None
    gone = await http.delete(f"{API}/projects/{shop.project_id}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text
    assert stored_group(fake_loki, target["id"]) is None
    assert (await http.get(RULES)).json() == []


async def test_loki_errors_never_carry_the_sources_secret(
    monitoring_app, linked_project, fake_loki
):
    http, _ = monitoring_app
    source = await http.post(
        f"{API}/sources",
        json={
            "type": "loki",
            "reach": "url",
            "url": fake_loki.url,
            "name": "Shop logs",
            "auth": {"type": "bearer", "token": "tok-SECRET-11"},
        },
    )
    assert source.status_code == 201, source.text
    linked = await http.put(
        f"{API}/projects/{linked_project.project_id}/sources/{source.json()['id']}",
        json={"filter": 'cluster="a"'},
    )
    assert linked.status_code == 200, linked.text
    fake_loki.echo_auth_in_errors = True
    fake_loki.fail_paths["/loki/api/v1/rules/omnikrux"] = 400
    out = await add_rule(http, loki_body(linked_project.project_id))
    target = await target_of(http, out["rule"]["id"])
    assert target["tool_state"] == "failed"
    texts = [
        str(out),
        str(target),
        (await http.get("/api/audit")).text,
        (await http.get(f"{RULES}/{out['rule']['id']}/history")).text,
    ]
    assert all("tok-SECRET-11" not in text for text in texts)


async def test_no_audit_no_loki_change(
    monitoring_app, linked_project_with_loki, fake_loki, monkeypatch
):
    http, app = monitoring_app
    services = app.state.monitoring
    shop = linked_project_with_loki
    rule = (await add_rule(http, loki_body(shop.project_id)))["rule"]
    target = await target_of(http, rule["id"])
    real = services.audit.begin_app

    async def unavailable(entry):
        if entry.kind == "loki_rule":
            raise AuditUnavailable("disk I/O error")
        return await real(entry)

    monkeypatch.setattr(services.audit, "begin_app", unavailable)
    sent = len(fake_loki.requests)
    saved = await http.put(
        f"{RULES}/{rule['id']}", json=loki_body(shop.project_id, base_version=1, severity="info")
    )
    assert saved.status_code == 200, saved.text
    words = "Nothing was changed: the audit log can't be written (disk I/O error)."
    [change] = saved.json()["changes"]
    assert (change["kind"], change["message"]) == ("failed", words)
    shown = await target_of(http, rule["id"])
    assert (shown["tool_state"], shown["tool_message"]) == ("failed", words)
    assert len(fake_loki.requests) == sent  # nothing reached the ruler

    review = (await http.get(f"{RULES}/{rule['id']}/delete-review")).json()
    gone = await http.delete(f"{RULES}/{rule['id']}", params={"token": review["token"]})
    assert gone.status_code == 200, gone.text
    assert gone.json()["changes"][0]["kind"] == "failed"
    assert len(fake_loki.requests) == sent
    assert stored_group(fake_loki, target["id"]) is not None


async def test_a_stopped_delete_writes_its_loki_rules_back(
    monitoring_app, linked_project_with_loki, fake_loki, monkeypatch
):
    http, app = monitoring_app
    services = app.state.monitoring
    shop = linked_project_with_loki
    rule = (await add_rule(http, loki_body(shop.project_id)))["rule"]
    target = await target_of(http, rule["id"])
    review = (await http.get(f"{API}/projects/{shop.project_id}/delete-review")).json()

    async def changed_meanwhile(*args, **kwargs):
        raise ReviewChanged()

    monkeypatch.setattr(services.projects, "delete", changed_meanwhile)
    stopped = await http.delete(
        f"{API}/projects/{shop.project_id}", params={"token": review["token"]}
    )
    assert stopped.status_code == 409
    assert stopped.json()["detail"].endswith(
        "1 alert rule had been taken out of Loki and is being written back."
    )
    # Taken out, then written back for real: in the ruler again, and in sync.
    assert stored_group(fake_loki, target["id"]) is not None
    back = await target_of(http, rule["id"])
    assert back["tool_state"] == "in_sync" and back["leaving"] is False
    methods = [r.method for r in fake_loki.requests if r.path.startswith("/loki/api/v1/rules/")]
    assert methods == ["POST", "DELETE", "POST"]


async def test_rule_groups_and_silences_cross_a_clusters_service_proxy(
    fake_api, fake_loki, fake_alertmanager, kube_cluster, monitoring_app
):
    """A source reached through a cluster gets the same bodies: YAML for a ruler, JSON for an
    Alertmanager, and a DELETE."""
    _, app = monitoring_app
    transports = app.state.monitoring.transports
    fake_api.service_backends[("monitoring", "loki:3100")] = fake_loki.url
    fake_api.service_backends[("monitoring", "alertmanager:9093")] = fake_alertmanager.url
    loki = transports.for_source(
        config(
            type="loki",
            reach="cluster",
            url=None,
            cluster=ClusterTarget(kube_cluster, "monitoring", "loki", "3100", "http"),
        )
    )
    group = yaml.safe_dump({"name": "omnikrux-t1", "rules": []}).encode()
    written = await loki.request(
        "POST",
        "/loki/api/v1/rules/omnikrux",
        body=group,
        content_type="application/yaml",
        timeout=5,
    )
    assert written.status == 202
    assert (
        yaml.safe_load(fake_loki.ruler_groups["omnikrux"]["omnikrux-t1"])["name"] == "omnikrux-t1"
    )
    assert fake_loki.requests[-1].headers["Content-Type"] == "application/yaml"
    removed = await loki.request("DELETE", "/loki/api/v1/rules/omnikrux/omnikrux-t1", timeout=5)
    assert removed.status == 202 and fake_loki.ruler_groups["omnikrux"] == {}

    am = transports.for_source(
        config(
            type="alertmanager",
            reach="cluster",
            url=None,
            cluster=ClusterTarget(kube_cluster, "monitoring", "alertmanager", "9093", "http"),
        )
    )
    silence = {
        "matchers": [{"name": "a", "value": "b", "isRegex": False, "isEqual": True}],
        "startsAt": "2099-01-01T00:00:00+00:00",
        "endsAt": "2099-01-02T00:00:00+00:00",
        "createdBy": "OmniKrux",
        "comment": "c",
    }
    made = await am.request(
        "POST",
        "/api/v2/silences",
        body=json.dumps(silence).encode(),
        content_type="application/json",
        timeout=5,
    )
    assert made.status == 200
    [held] = fake_alertmanager.silences.values()
    assert held["createdBy"] == "OmniKrux" and held["matchers"] == silence["matchers"]


async def test_a_save_during_a_loki_write_is_never_marked_in_sync(
    monitoring_app, linked_project_with_loki, fake_loki
):
    http, app = monitoring_app
    services = app.state.monitoring
    shop = linked_project_with_loki
    rule = (await add_rule(http, loki_body(shop.project_id)))["rule"]
    target = await services.alerts.get_target((await target_of(http, rule["id"]))["id"])
    record = await services.alerts.get_rule(rule["id"])

    fake_loki.release.clear()
    fake_loki.mode = "hang"  # the ruler holds the next write until released
    posts = len([r for r in fake_loki.requests if r.method == "POST"])
    writing = asyncio.create_task(services.loki_ruler.write(target, record))
    await until(lambda: len([r for r in fake_loki.requests if r.method == "POST"]) > posts)
    # The rule is saved while the ruler holds the older version.
    spec = RuleSpec(**{f.name: getattr(record, f.name) for f in fields(RuleSpec)})
    await services.alerts.update_rule(
        rule["id"], replace(spec, name="Errors (saved meanwhile)"), base_version=record.version
    )
    fake_loki.mode = "ok"
    fake_loki.release.set()
    change = await writing
    assert change.kind == "written"
    held = await services.alerts.get_target(target.id)
    # What the ruler holds is the version before: not in sync, and the save's own hand-off
    # writes the newer one.
    assert held.tool_state == "needs_review" and held.applied_version == record.version

    await services.alert_sync.reconcile_rule(rule["id"], changed=True)
    held = await services.alerts.get_target(target.id)
    assert held.tool_state == "in_sync" and held.applied_version == record.version + 1
    [alert] = stored_group(fake_loki, target.id)["rules"]
    assert alert["alert"] == "Errors (saved meanwhile)"
