"""OmniKrux's contact points in the Alertmanager it installed: an AlertmanagerConfig and its
Secret written through a review (create, edit, delete); the secret values go only into that
Secret, never into a plan, a diff, the audit, a log or an answer; an apply refuses what changed
since the review; rule and contact-point saves say when the contact points need a review."""

import asyncio
import dataclasses
import json
import logging

from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.clusters.models import Environment
from omnikrux.monitoring.alerts.contact_points.export import SECRET_RULE
from omnikrux.monitoring.alerts.tool.channels import read_channels
from omnikrux.monitoring.install import contacts as contacts_module
from tests.monitoring.alert_env import CONTACT_POINTS
from tests.monitoring.conftest import HOOK_URL, WEBHOOK_URL

NS = "monitoring"
AMC = "alertmanagerconfigs.monitoring.coreos.com"
KEY = (NS, "omnikrux-contact-points")
RULES = "/api/monitoring/alerts/rules"
STALE = "The contact points or rules changed since you reviewed this. Review it again."
SECRET_LINE = (
    "Secret omnikrux-contact-points holds {k} values; they are hidden here and never shown again."
)
TLS_PORT = "Alertmanager uses direct TLS only on port 465. Change the port, or use STARTTLS."
NO_ALERTMANAGER = (
    "OmniKrux didn't install an Alertmanager in this cluster, so it has nowhere to send "
    "contact points."
)
ROUTING_KEY = "A" * 31 + "Z"
SMTP_PASSWORD = "smtp-XXXX-SECRET-pass"
TOKEN = "tok-XXXX-SECRET-bearer"


def sync_url(cluster_id: str) -> str:
    return f"/api/monitoring/install/clusters/{cluster_id}/contacts/sync"


async def sync(http, cluster_id: str) -> dict:
    r = await http.post(sync_url(cluster_id))
    assert r.status_code == 200, r.text
    return r.json()


async def apply(http, plan: dict, confirm: str | None = None):
    body = {} if confirm is None else {"confirm_text": confirm}
    return await http.post(f"/api/actions/{plan['plan_id']}/apply", json=body)


async def synced(http, cluster_id: str) -> None:
    """Review and apply the contact points."""
    out = await sync(http, cluster_id)
    assert out["kind"] == "review", out
    applied = await apply(http, out["plan"])
    assert applied.status_code == 200, applied.text


async def status_contacts(http, cluster_id: str) -> dict:
    r = await http.get(f"/api/monitoring/install/clusters/{cluster_id}")
    assert r.status_code == 200, r.text
    return r.json()["install"]["contacts"]


async def add_contact(http, body: dict) -> str:
    r = await http.post(CONTACT_POINTS, json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def rule_with(http, rule_id: str, contact_point_ids: list[str]) -> dict:
    """PUT the rule as it is, notifying `contact_point_ids`; the answer."""
    rule = (await http.get(f"{RULES}/{rule_id}")).json()
    body = {
        "name": rule["name"],
        "scope": {"kind": rule["scope"]["kind"], "id": rule["scope"]["id"]},
        "source": {"type": rule["source_type"], "id": rule["source_id"]},
        "expr": rule["expr"],
        "condition": {
            "op": rule["condition"]["op"],
            "threshold": rule["condition"]["threshold"],
            "for": rule["condition"]["for"],
            "every": rule["condition"]["every"],
        },
        "engine": rule["engine"],
        "contact_point_ids": contact_point_ids,
        "base_version": rule["version"],
    }
    r = await http.put(f"{RULES}/{rule_id}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def secret_writes(fake_api) -> list[dict]:
    return [w for w in fake_api.writes if "/secrets/omnikrux-contact-points" in w["path"]]


async def test_contact_sync_review_hides_values(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts, caplog
):
    caplog.set_level(logging.DEBUG)
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    out = await sync(http, installed_cluster.cluster_id)
    plan = out["plan"]
    assert out["kind"] == "review" and plan["action"] == "create"
    assert plan["title"] == "Send alerts to 2 contact points from monitoring's Alertmanager"
    assert plan["apply_label"] == "Apply" and plan["blocked"] == []
    assert plan["target"]["name"] == "omnikrux-contact-points"
    cluster = plan["cluster"]["name"]
    lines = {
        env.cp_id: "Ops Slack (Slack) for API latency high",
        env.hook_id: "Ops hook (Webhook) for API latency high",
    }
    first = (
        f"Routes alerts from rules that run in Prometheus in {cluster} to OmniKrux's contact "
        "points, through the Alertmanager OmniKrux installed."
    )
    assert plan["summary"] == [
        first,
        *(lines[cp] for cp in sorted(lines)),
        SECRET_LINE.format(k=2),
    ]
    assert plan["summary"][-1] == SECRET_LINE.format(k=2)
    applied = await apply(http, plan)
    assert applied.status_code == 200, applied.text
    assert applied.json()["message"] == "Updated the contact points in monitoring's Alertmanager."

    secret = fake_api.objects["secrets"][KEY]
    assert secret["type"] == "Opaque"
    assert secret["metadata"]["labels"] == {"app.kubernetes.io/managed-by": "omnikrux"}
    assert secret["stringData"] == {
        f"cp-{env.cp_id}-webhook_url": WEBHOOK_URL,
        f"cp-{env.hook_id}-url": HOOK_URL,
    }
    amc = fake_api.objects[AMC][KEY]
    assert amc["metadata"]["labels"] == {"app.kubernetes.io/managed-by": "omnikrux"}
    route = amc["spec"]["route"]
    assert route["receiver"] == "omnikrux-none"
    assert route["groupBy"] == ["alertname", "omnikrux_rule", "omnikrux_project"]
    assert (route["groupWait"], route["groupInterval"], route["repeatInterval"]) == (
        "30s",
        "5m",
        "4h",
    )
    assert route["routes"][0]["matchers"] == [
        {"name": "omnikrux_rule", "value": env.rule_id, "matchType": "="}
    ]
    assert [r["receiver"] for r in route["routes"]] == sorted(
        [f"cp-{env.cp_id}", f"cp-{env.hook_id}"]
    )
    assert all(r["continue"] is True for r in route["routes"])
    receivers = {r["name"]: r for r in amc["spec"]["receivers"]}
    assert receivers["omnikrux-none"] == {"name": "omnikrux-none"}
    assert receivers[f"cp-{env.cp_id}"]["slackConfigs"] == [
        {
            "apiURL": {"key": f"cp-{env.cp_id}-webhook_url", "name": "omnikrux-contact-points"},
            "sendResolved": True,
        }
    ]
    assert receivers[f"cp-{env.hook_id}"]["webhookConfigs"] == [
        {
            "sendResolved": True,
            "urlSecret": {"key": f"cp-{env.hook_id}-url", "name": "omnikrux-contact-points"},
        }
    ]
    # The Secret was written before the AlertmanagerConfig that reads it.
    created = [
        o["kind"]
        for o in fake_api.created_objects
        if o.get("kind") in ("Secret", "AlertmanagerConfig")
        and o["metadata"]["name"] == "omnikrux-contact-points"
    ]
    assert created == ["Secret", "AlertmanagerConfig"]

    audit = (await http.get("/api/audit")).text
    assert "omnikrux-contact-points" in audit
    status = (await http.get(f"/api/monitoring/install/clusters/{env.cluster_id}")).text
    for text in (json.dumps(plan), audit, caplog.text, json.dumps(amc), applied.text, status):
        for secret_value in (WEBHOOK_URL, HOOK_URL, "XXXX-SECRET"):
            assert secret_value not in text
    record = await _record(monitoring_app, installed_cluster.cluster_id)
    assert record.contacts_digest is not None and len(record.contacts_digest) == 64
    assert "XXXX" not in repr(record)


async def _record(monitoring_app, cluster_id):
    _, app = monitoring_app
    return await app.state.monitoring.installs.get(cluster_id)


async def test_each_type_becomes_its_receiver(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    teams = await add_contact(
        http,
        {
            "name": "Teams",
            "type": "teams",
            "secrets": {"webhook_url": "https://teams.example.test/hook/XXXX-SECRET-T"},
        },
    )
    pager = await add_contact(
        http, {"name": "Pager", "type": "pagerduty", "secrets": {"routing_key": ROUTING_KEY}}
    )
    hook = await add_contact(
        http,
        {
            "name": "Token hook",
            "type": "webhook",
            "secrets": {"url": "https://hook.example.test/x", "bearer_token": TOKEN},
        },
    )
    mail = await add_contact(
        http,
        {
            "name": "Mail",
            "type": "email",
            "settings": {
                "host": "smtp.example.test",
                "port": 587,
                "security": "starttls",
                "username": "ops",
                "from_address": "alerts@example.test",
                "to": ["ops@example.test", "db@example.test"],
            },
            "secrets": {"password": SMTP_PASSWORD},
        },
    )
    await rule_with(http, env.rule_id, [env.cp_id, teams, pager, hook, mail])
    out = await sync(http, installed_cluster.cluster_id)
    assert out["plan"]["summary"][-1] == SECRET_LINE.format(k=6)
    assert (await apply(http, out["plan"])).status_code == 200
    receivers = {r["name"]: r for r in fake_api.objects[AMC][KEY]["spec"]["receivers"]}

    def ref(cp: str, field: str) -> dict:
        return {"key": f"cp-{cp}-{field}", "name": "omnikrux-contact-points"}

    assert receivers[f"cp-{teams}"]["msteamsv2Configs"] == [
        {"sendResolved": True, "webhookURL": ref(teams, "webhook_url")}
    ]
    assert receivers[f"cp-{pager}"]["pagerdutyConfigs"] == [
        {
            "routingKey": ref(pager, "routing_key"),
            "sendResolved": True,
            "severity": "{{ .CommonLabels.severity }}",
            "url": "https://events.pagerduty.com/v2/enqueue",
        }
    ]
    assert receivers[f"cp-{hook}"]["webhookConfigs"] == [
        {
            "httpConfig": {
                "authorization": {"credentials": ref(hook, "bearer_token"), "type": "Bearer"}
            },
            "sendResolved": True,
            "urlSecret": ref(hook, "url"),
        }
    ]
    assert receivers[f"cp-{mail}"]["emailConfigs"] == [
        {
            "authPassword": ref(mail, "password"),
            "authUsername": "ops",
            "from": "alerts@example.test",
            "requireTLS": True,
            "sendResolved": True,
            "smarthost": "smtp.example.test:587",
            "to": "ops@example.test, db@example.test",
        }
    ]
    data = fake_api.objects["secrets"][KEY]["stringData"]
    assert data[f"cp-{pager}-routing_key"] == ROUTING_KEY
    assert data[f"cp-{mail}-password"] == SMTP_PASSWORD
    assert data[f"cp-{hook}-bearer_token"] == TOKEN
    amc_text = json.dumps(fake_api.objects[AMC][KEY])
    for value in (ROUTING_KEY, SMTP_PASSWORD, TOKEN, "XXXX-SECRET"):
        assert value not in amc_text


async def test_email_tls_on_another_port_is_skipped(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    mail = await add_contact(
        http,
        {
            "name": "Direct TLS mail",
            "type": "email",
            "settings": {
                "host": "smtp.example.test",
                "port": 2465,
                "security": "tls",
                "from_address": "alerts@example.test",
                "to": ["ops@example.test"],
            },
        },
    )
    await rule_with(http, env.rule_id, [env.cp_id, mail])
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    assert plan["warnings"] == [f"Direct TLS mail can't be sent from Alertmanager: {TLS_PORT}"]
    assert not any(line.startswith("Direct TLS mail") for line in plan["summary"])
    assert plan["title"] == "Send alerts to 1 contact point from monitoring's Alertmanager"
    assert (await apply(http, plan)).status_code == 200
    names = [r["name"] for r in fake_api.objects[AMC][KEY]["spec"]["receivers"]]
    assert names == ["omnikrux-none", f"cp-{env.cp_id}"]


async def test_user_run_alertmanager_is_refused(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, app = monitoring_app
    services = app.state.monitoring
    alertmanager = installed_cluster.sources["alertmanager"]
    await services.sources.set_installed_by_omnikrux(alertmanager, False)
    name = (await services.sources.get(alertmanager)).name
    writes = len(fake_api.writes)
    created = len(fake_api.created_objects)
    r = await http.post(sync_url(installed_cluster.cluster_id))
    assert r.status_code == 409
    assert r.json()["detail"] == SECRET_RULE.format(source=name)
    assert len(fake_api.writes) == writes and len(fake_api.created_objects) == created
    assert KEY not in fake_api.objects["secrets"] and KEY not in fake_api.objects[AMC]
    contacts = await status_contacts(http, installed_cluster.cluster_id)
    assert contacts["state"] == "failed"
    assert contacts["message"] == SECRET_RULE.format(source=name)


async def test_changed_contacts_since_review_are_refused(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    changed = await http.patch(
        f"{CONTACT_POINTS}/{env.cp_id}",
        json={"secrets": {"webhook_url": "https://hooks.slack.example.test/services/NEW-SECRET"}},
    )
    assert changed.status_code == 200, changed.text
    refused = await apply(http, plan)
    assert (refused.status_code, refused.json()["detail"]) == (409, STALE)
    assert KEY not in fake_api.objects["secrets"] and KEY not in fake_api.objects[AMC]
    records = (await http.get("/api/audit")).json()["records"]
    [record] = [r for r in records if r["kind"] == AMC]
    assert record["outcome"] == "failed" and record["message"] == STALE

    # Applied once, then the rule changes: the update is refused the same way.
    await synced(http, installed_cluster.cluster_id)
    secret_before = json.dumps(fake_api.objects["secrets"][KEY], sort_keys=True)
    plan = await sync(http, installed_cluster.cluster_id)
    assert plan["kind"] == "done"
    await rule_with(http, env.rule_id, [env.cp_id])
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    assert plan["action"] == "edit"
    await rule_with(http, env.rule_id, [env.hook_id])
    refused = await apply(http, plan)
    assert (refused.status_code, refused.json()["detail"]) == (409, STALE)
    assert json.dumps(fake_api.objects["secrets"][KEY], sort_keys=True) == secret_before


async def test_nothing_to_route_removes_the_settings(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts, monkeypatch
):
    http, app = monitoring_app
    env = tool_rule_with_contacts
    await synced(http, installed_cluster.cluster_id)
    review = (await http.get(f"{RULES}/{env.rule_id}/delete-review")).json()
    deleted = await http.delete(f"{RULES}/{env.rule_id}", params={"token": review["token"]})
    assert deleted.status_code == 200, deleted.text
    contacts_change = [c for c in deleted.json()["changes"] if c["kind"] == "contacts"]
    assert [c["cluster_id"] for c in contacts_change] == [installed_cluster.cluster_id]

    # On a production cluster the removal asks for the name, as every delete there does.
    registry = app.state.registry
    real_get = registry.get

    async def production(cluster_id):
        info = await real_get(cluster_id)
        return dataclasses.replace(info, environment=Environment.PRODUCTION)

    monkeypatch.setattr(registry, "get", production)
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    assert plan["action"] == "delete"
    assert plan["title"] == "Remove the contact points from monitoring's Alertmanager"
    assert plan["apply_label"] == "Remove"
    assert plan["confirm_text"] == "omnikrux-contact-points"
    assert plan["warnings"][0] == "This is a production cluster."
    assert plan["diff"]["after"] == ""
    wrong = await apply(http, plan)
    assert wrong.status_code == 422
    done = await apply(http, plan, confirm="omnikrux-contact-points")
    assert done.status_code == 200, done.text
    assert KEY not in fake_api.objects[AMC] and KEY not in fake_api.objects["secrets"]
    monkeypatch.undo()
    contacts = await status_contacts(http, installed_cluster.cluster_id)
    assert (contacts["state"], contacts["contact_points"], contacts["rules"]) == ("none", 0, 0)
    assert (await sync(http, installed_cluster.cluster_id))["kind"] == "done"


async def test_in_sync_answers_done(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    await synced(http, installed_cluster.cluster_id)
    writes = len(fake_api.writes)
    out = await sync(http, installed_cluster.cluster_id)
    assert out["kind"] == "done"
    assert out["contacts"]["state"] == "in_sync"
    assert (out["contacts"]["contact_points"], out["contacts"]["rules"]) == (2, 1)
    assert out["contacts"]["applied_at"] is not None
    assert len(fake_api.writes) == writes


async def test_an_update_puts_both_with_their_versions(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    await synced(http, installed_cluster.cluster_id)
    await rule_with(http, env.rule_id, [env.hook_id])
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    assert plan["action"] == "edit"
    assert plan["title"] == "Update the contact points in monitoring's Alertmanager"
    assert plan["apply_label"] == "Update"
    assert "XXXX" not in json.dumps(plan)
    assert (await apply(http, plan)).status_code == 200
    puts = [w for w in fake_api.writes if w["method"] == "PUT"]
    assert [w["path"].rsplit("/", 2)[-2] for w in puts] == ["secrets", "alertmanagerconfigs"]
    assert all(w["body"]["metadata"]["resourceVersion"] == "1" for w in puts)
    assert fake_api.objects["secrets"][KEY]["stringData"] == {f"cp-{env.hook_id}-url": HOOK_URL}


async def test_saving_a_rule_reports_a_contacts_change(
    monitoring_app, installed_cluster, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    await synced(http, installed_cluster.cluster_id)
    pager = await add_contact(
        http, {"name": "Pager", "type": "pagerduty", "secrets": {"routing_key": ROUTING_KEY}}
    )
    saved = await rule_with(http, env.rule_id, [env.cp_id, env.hook_id, pager])
    [change] = [c for c in saved["changes"] if c["kind"] == "contacts"]
    cluster = (await http.get(f"/api/monitoring/install/clusters/{env.cluster_id}")).json()
    assert change == {
        "target_id": "",
        "rule_id": "",
        "rule_name": "",
        "project_id": "",
        "project_name": cluster["cluster_name"],
        "kind": "contacts",
        "message": "The contact points in monitoring's Alertmanager need a review.",
        "tool": None,
        "cluster_id": installed_cluster.cluster_id,
    }
    # Other changes keep their shape: no cluster_id key at all.
    assert all("cluster_id" not in c for c in saved["changes"] if c["kind"] != "contacts")
    # Saved again with the same contact points: nothing new to review after an apply.
    await synced(http, installed_cluster.cluster_id)
    again = await rule_with(http, env.rule_id, [env.cp_id, env.hook_id, pager])
    assert [c for c in again["changes"] if c["kind"] == "contacts"] == []


async def test_patching_a_contact_point_reports_a_contacts_change(
    monitoring_app, installed_cluster, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    await synced(http, installed_cluster.cluster_id)
    renamed = await http.patch(f"{CONTACT_POINTS}/{env.hook_id}", json={"name": "Ops hook 2"})
    assert renamed.status_code == 200, renamed.text
    # A name isn't part of the Alertmanager's settings.
    assert renamed.json()["alert_changes"] == []
    assert renamed.json()["name"] == "Ops hook 2"
    changed = await http.patch(
        f"{CONTACT_POINTS}/{env.cp_id}",
        json={"secrets": {"webhook_url": "https://hooks.slack.example.test/services/OTHER"}},
    )
    assert changed.status_code == 200, changed.text
    body = changed.json()
    [change] = body["alert_changes"]
    assert change["kind"] == "contacts" and change["cluster_id"] == installed_cluster.cluster_id
    assert body["secrets_set"] == ["webhook_url"] and "OTHER" not in changed.text
    # The list and add answers keep M4's shape.
    listed = (await http.get(CONTACT_POINTS)).json()
    assert all("alert_changes" not in cp for cp in listed)
    contacts = await status_contacts(http, installed_cluster.cluster_id)
    assert contacts["state"] == "needs_review"


async def test_deleting_a_contact_point_reports_a_contacts_change(
    monitoring_app, installed_cluster, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    await synced(http, installed_cluster.cluster_id)
    review = (await http.get(f"{CONTACT_POINTS}/{env.hook_id}/delete-review")).json()
    removed = await http.delete(
        f"{CONTACT_POINTS}/{env.hook_id}", params={"token": review["token"]}
    )
    assert removed.status_code == 200, removed.text
    [change] = removed.json()["alert_changes"]
    assert list(removed.json()) == ["alert_changes"]
    assert change["kind"] == "contacts" and change["cluster_id"] == installed_cluster.cluster_id

    # A contact point no tool rule on the installed tools uses: nothing to review.
    await synced(http, installed_cluster.cluster_id)
    unused = await add_contact(
        http, {"name": "Unused", "type": "slack", "secrets": {"webhook_url": WEBHOOK_URL}}
    )
    review = (await http.get(f"{CONTACT_POINTS}/{unused}/delete-review")).json()
    removed = await http.delete(f"{CONTACT_POINTS}/{unused}", params={"token": review["token"]})
    assert (removed.status_code, removed.json()) == (200, {"alert_changes": []})

    # A stale token is refused as in M4.
    review = (await http.get(f"{CONTACT_POINTS}/{env.cp_id}/delete-review")).json()
    await rule_with(http, env.rule_id, [env.cp_id])  # the review's rules moved on
    stale = await http.delete(f"{CONTACT_POINTS}/{env.cp_id}", params={"token": "stale"})
    assert stale.status_code == 409
    assert stale.json()["detail"] == "Something changed since the review. Review it again."
    assert review["name"] == "Ops Slack"


async def test_capability_says_installed(
    monitoring_app, installed_cluster, tool_rule_with_contacts, linked_project
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    for project_id, expected in ((env.project_id, True), (linked_project.project_id, False)):
        r = await http.get(
            "/api/monitoring/alerts/capabilities",
            params={"scope_kind": "project", "scope_id": project_id, "source_type": "prometheus"},
        )
        assert r.status_code == 200, r.text
        [one] = r.json()
        assert one["installed_by_omnikrux"] is expected


async def test_status_reports_contacts_state(
    monitoring_app, installed_cluster, tool_rule_with_contacts
):
    http, _ = monitoring_app
    before = await status_contacts(http, installed_cluster.cluster_id)
    assert before == {
        "state": "needs_review",
        "message": None,
        "applied_at": None,
        "contact_points": 2,
        "rules": 1,
    }
    await synced(http, installed_cluster.cluster_id)
    after = await status_contacts(http, installed_cluster.cluster_id)
    assert after["state"] == "in_sync" and after["applied_at"] is not None
    assert (after["contact_points"], after["rules"]) == (2, 1)


async def test_a_failed_apply_says_why_and_keeps_what_was_applied(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts, monkeypatch
):
    http, app = monitoring_app
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    real = contacts_module.call_json

    async def refusing(api, method, path, **kwargs):
        if method == "POST" and path.endswith("/secrets"):
            exc = ApiException(status=403, reason="Forbidden")
            exc.body = json.dumps({"message": "secrets is forbidden"})
            raise exc
        return await real(api, method, path, **kwargs)

    monkeypatch.setattr(contacts_module, "call_json", refusing)
    refused = await apply(http, plan)
    monkeypatch.undo()
    assert refused.status_code == 403, refused.text
    detail = refused.json()["detail"]
    assert "Secret monitoring/omnikrux-contact-points" in detail
    assert KEY not in fake_api.objects[AMC]
    record = await app.state.monitoring.installs.get(installed_cluster.cluster_id)
    assert record.contacts_digest is None and record.contacts_message == detail
    contacts = await status_contacts(http, installed_cluster.cluster_id)
    assert (contacts["state"], contacts["message"]) == ("failed", detail)
    records = (await http.get("/api/audit")).json()["records"]
    [audit] = [r for r in records if r["kind"] == AMC]
    assert audit["outcome"] == "failed"


async def test_a_rule_save_never_fails_over_contact_points(
    monitoring_app, installed_cluster, tool_rule_with_contacts, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger="omnikrux")
    http, _ = monitoring_app
    env = tool_rule_with_contacts

    async def unreadable(*args, **kwargs):
        from omnikrux.monitoring.alerts.contact_points.types import SecretsUnreadable

        raise SecretsUnreadable("Ops Slack")

    monkeypatch.setattr(contacts_module, "export_receivers", unreadable)
    saved = await rule_with(http, env.rule_id, [env.cp_id])
    assert [c for c in saved["changes"] if c["kind"] == "contacts"] == []
    words = "The saved secret of Ops Slack can't be read. Enter it again."
    contacts = await status_contacts(http, installed_cluster.cluster_id)
    assert (contacts["state"], contacts["message"]) == ("failed", words)
    r = await http.post(sync_url(installed_cluster.cluster_id))
    assert (r.status_code, r.json()["detail"]) == (409, words)
    assert "SecretsUnreadable" in caplog.text
    monkeypatch.undo()
    # Readable again: the next save says the contact points need a review.
    saved = await rule_with(http, env.rule_id, [env.cp_id, env.hook_id])
    assert [c["kind"] for c in saved["changes"] if c["kind"] == "contacts"] == ["contacts"]
    contacts = await status_contacts(http, installed_cluster.cluster_id)
    assert (contacts["state"], contacts["message"]) == ("needs_review", None)


async def test_no_alertmanager_is_refused(monitoring_app, installed_cluster):
    http, app = monitoring_app
    installs = app.state.monitoring.installs
    await installs.finish(
        installed_cluster.cluster_id, "installed", None, sources={"alertmanager": None}
    )
    r = await http.post(sync_url(installed_cluster.cluster_id))
    assert (r.status_code, r.json()["detail"]) == (409, NO_ALERTMANAGER)


async def test_contact_sync_right_after_install(
    monitoring_app, installed_cluster, tool_rule_with_contacts
):
    """The install job forgets the cluster's kinds once the CRDs are there, so the
    AlertmanagerConfig's review works at once (no "not served")."""
    http, _ = monitoring_app
    r = await http.post(sync_url(installed_cluster.cluster_id))
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "review"


async def test_channels_leave_out_omnikrux_contact_points(fake_alertmanager, direct):
    fake_alertmanager.config_yaml = """
route:
  receiver: monitoring/omnikrux-contact-points/omnikrux-none
  routes:
    - receiver: monitoring/omnikrux-contact-points/omnikrux-none
      matchers: ['namespace="monitoring"']
      routes:
        - receiver: monitoring/omnikrux-contact-points/cp-1
          matchers: ['omnikrux_rule="r1"']
    - receiver: ops-slack
      matchers: ['team="ops"']
receivers:
  - name: monitoring/omnikrux-contact-points/omnikrux-none
  - name: monitoring/omnikrux-contact-points/cp-1
    slack_configs: [{channel: x}]
  - name: ops-slack
    slack_configs: [{channel: y}]
"""
    t = direct(fake_alertmanager.url, type="alertmanager", name="Alerts")
    assert [c.receiver for c in await read_channels(t, "Alerts")] == ["ops-slack"]


# -- fix round 1: never during an install or uninstall; never where another Alertmanager reads --

ALERTMANAGERS = "alertmanagers.monitoring.coreos.com"
UNINSTALLING = (
    "The monitoring tools in monitoring are being uninstalled, so OmniKrux sends no contact "
    "points there."
)
NOT_INSTALLED = (
    "The monitoring tools in monitoring didn't finish installing. Install again, then sync the "
    "contact points."
)


def other_alertmanager(where: str) -> str:
    return (
        f"Alertmanager {where} would also read OmniKrux's contact points: its "
        "alertmanagerConfigSelector and alertmanagerConfigNamespaceSelector select "
        "monitoring/omnikrux-contact-points, so the addresses and keys would reach it. Narrow "
        "those selectors, then review again."
    )


def alertmanager(fake_api, namespace: str, name: str, **spec) -> None:
    """An Alertmanager resource with these spec fields (`config`/`namespaces`: its
    alertmanagerConfigSelector and alertmanagerConfigNamespaceSelector)."""
    body: dict = {}
    if "config" in spec:
        body["alertmanagerConfigSelector"] = spec["config"]
    if "namespaces" in spec:
        body["alertmanagerConfigNamespaceSelector"] = spec["namespaces"]
    fake_api.objects[ALERTMANAGERS][(namespace, name)] = {
        "apiVersion": "monitoring.coreos.com/v1",
        "kind": "Alertmanager",
        "metadata": {"name": name, "namespace": namespace, "uid": f"u-am-{name}"},
        "spec": body,
    }


def contact_writes(fake_api) -> list[dict]:
    return [w for w in fake_api.writes if "omnikrux-contact-points" in w["path"]] + [
        o
        for o in fake_api.created_objects
        if (o.get("metadata") or {}).get("name") == "omnikrux-contact-points"
    ]


async def test_no_sync_while_uninstalling_or_after_a_failed_install(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, app = monitoring_app
    installs = app.state.monitoring.installs
    cluster = installed_cluster.cluster_id
    plan = (await sync(http, cluster))["plan"]  # reviewed before the uninstall begins
    await installs.begin_uninstall(cluster, job_id="uninstall-job")
    r = await http.post(sync_url(cluster))
    assert (r.status_code, r.json()["detail"]) == (409, UNINSTALLING)
    applied = await apply(http, plan)
    assert (applied.status_code, applied.json()["detail"]) == (409, UNINSTALLING)
    assert contact_writes(fake_api) == []
    # A save while the uninstall runs reports nothing to review there.
    saved = await rule_with(http, tool_rule_with_contacts.rule_id, [tool_rule_with_contacts.cp_id])
    assert [c for c in saved["changes"] if c["kind"] == "contacts"] == []

    await installs.finish(cluster, "failed", "stopped", job_id="uninstall-job")
    r = await http.post(sync_url(cluster))
    assert (r.status_code, r.json()["detail"]) == (409, NOT_INSTALLED)


async def test_an_uninstall_waits_for_a_running_sync(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts, monkeypatch
):
    http, app = monitoring_app
    installs = app.state.monitoring.installs
    cluster = installed_cluster.cluster_id
    plan = (await sync(http, cluster))["plan"]
    writing, go_on = asyncio.Event(), asyncio.Event()
    real = contacts_module.call_json

    async def slow(api, method, path, **kwargs):
        if method == "POST" and path.endswith("/secrets"):
            writing.set()
            await go_on.wait()
        return await real(api, method, path, **kwargs)

    monkeypatch.setattr(contacts_module, "call_json", slow)
    applying = asyncio.create_task(apply(http, plan))
    await asyncio.wait_for(writing.wait(), 10)
    uninstalling = asyncio.create_task(installs.begin_uninstall(cluster, job_id="u"))
    await asyncio.sleep(0.2)
    assert not uninstalling.done()  # it waits for the sync's writes
    assert (await installs.get(cluster)).state == "installed"
    go_on.set()
    assert (await applying).status_code == 200
    record = await asyncio.wait_for(uninstalling, 10)
    assert record.state == "uninstalling"
    # Both objects were written before the uninstall began, so its own step removes them.
    assert KEY in fake_api.objects["secrets"] and KEY in fake_api.objects[AMC]


async def test_another_alertmanager_that_reads_the_settings_blocks(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    cluster = installed_cluster.cluster_id
    # OmniKrux's own selects everything: fine. One in another namespace with a config selector
    # but no namespace selector reads only its own namespace; one without a config selector
    # reads none; one whose labels don't match reads none.
    alertmanager(fake_api, NS, "omnikrux-metrics-alertmanager", config={}, namespaces={})
    alertmanager(fake_api, "other", "own-namespace-only", config={})
    alertmanager(fake_api, "other", "no-selector", namespaces={})
    alertmanager(
        fake_api, "other", "team-only", config={"matchLabels": {"team": "a"}}, namespaces={}
    )
    plan = (await sync(http, cluster))["plan"]
    assert plan["blocked"] == []

    # A later kube-prometheus-stack's defaults: everything, everywhere.
    alertmanager(fake_api, "kps", "kps-alertmanager", config={}, namespaces={})
    # Matching labels, and a namespace selector that picks OmniKrux's namespace.
    alertmanager(
        fake_api,
        "team",
        "picky",
        config={
            "matchExpressions": [{"key": "app.kubernetes.io/managed-by", "operator": "Exists"}]
        },
        namespaces={"matchLabels": {"kubernetes.io/metadata.name": NS}},
    )
    # The same Alertmanager in OmniKrux's namespace without a namespace selector.
    alertmanager(fake_api, NS, "next-door", config={})
    plan = (await sync(http, cluster))["plan"]
    assert plan["blocked"] == [
        other_alertmanager("kps/kps-alertmanager"),
        other_alertmanager("monitoring/next-door"),
        other_alertmanager("team/picky"),
    ]
    refused = await apply(http, plan)
    assert refused.status_code == 422
    assert contact_writes(fake_api) == []


async def test_an_alertmanager_that_appears_after_the_review_is_refused(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    assert plan["blocked"] == []
    alertmanager(fake_api, "kps", "kps-alertmanager", config={}, namespaces={})
    refused = await apply(http, plan)
    assert refused.status_code == 409
    assert refused.json()["detail"] == other_alertmanager("kps/kps-alertmanager")
    assert contact_writes(fake_api) == []


async def test_alertmanagers_that_cant_be_read_block(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    fake_api.forbidden_kinds.add(ALERTMANAGERS)
    refused = await apply(http, plan)
    assert refused.status_code == 409
    words = refused.json()["detail"]
    assert words.startswith(
        "OmniKrux sends contact points only where no other Alertmanager can read them, and it "
        "couldn't check that: Not allowed to list the Alertmanagers in the cluster"
    )
    assert words.endswith(". Try again.")
    blocked = (await sync(http, installed_cluster.cluster_id))["plan"]["blocked"]
    assert blocked == [words]
    assert contact_writes(fake_api) == []


async def test_a_secret_left_without_its_alertmanagerconfig_is_removed(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    await synced(http, installed_cluster.cluster_id)
    del fake_api.objects[AMC][KEY]  # removed by an earlier delete whose Secret step failed
    await rule_with(http, env.rule_id, [])
    out = await sync(http, installed_cluster.cluster_id)
    assert out["kind"] == "review" and out["plan"]["action"] == "delete"
    assert (await apply(http, out["plan"])).status_code == 200
    assert KEY not in fake_api.objects["secrets"]
    assert (await sync(http, installed_cluster.cluster_id))["kind"] == "done"


async def test_an_update_writes_what_its_review_shows(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    env = tool_rule_with_contacts
    await synced(http, installed_cluster.cluster_id)
    live = fake_api.objects[AMC][KEY]["metadata"]
    live["labels"]["team"] = "ops"
    live["annotations"] = {"note": "kept"}
    await rule_with(http, env.rule_id, [env.hook_id])
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    assert "team: ops" in plan["diff"]["after"] and "note: kept" in plan["diff"]["after"]
    assert (await apply(http, plan)).status_code == 200
    written = fake_api.objects[AMC][KEY]
    assert written["metadata"]["labels"] == {
        "app.kubernetes.io/managed-by": "omnikrux",
        "team": "ops",
    }
    assert written["metadata"]["annotations"] == {"note": "kept"}
    assert [r["name"] for r in written["spec"]["receivers"]] == [
        "omnikrux-none",
        f"cp-{env.hook_id}",
    ]


def test_alert_change_schema_keeps_its_fields():
    from omnikrux.monitoring.alerts.sync import AlertChangeOut

    schema = AlertChangeOut.model_json_schema(mode="serialization")
    assert "cluster_id" in schema["properties"] and "target_id" in schema["properties"]


async def test_an_alertmanager_that_takes_the_settings_as_its_whole_configuration_blocks(
    monitoring_app, installed_cluster, fake_api, tool_rule_with_contacts
):
    http, _ = monitoring_app
    # No selectors at all, but it names OmniKrux's AlertmanagerConfig as its configuration.
    fake_api.objects[ALERTMANAGERS][(NS, "global")] = {
        "apiVersion": "monitoring.coreos.com/v1",
        "kind": "Alertmanager",
        "metadata": {"name": "global", "namespace": NS, "uid": "u-am-global"},
        "spec": {"alertmanagerConfiguration": {"name": "omnikrux-contact-points"}},
    }
    # The same name from another namespace refers to that namespace's object, not OmniKrux's.
    fake_api.objects[ALERTMANAGERS][("other", "elsewhere")] = {
        "apiVersion": "monitoring.coreos.com/v1",
        "kind": "Alertmanager",
        "metadata": {"name": "elsewhere", "namespace": "other", "uid": "u-am-elsewhere"},
        "spec": {"alertmanagerConfiguration": {"name": "omnikrux-contact-points"}},
    }
    plan = (await sync(http, installed_cluster.cluster_id))["plan"]
    assert plan["blocked"] == [other_alertmanager("monitoring/global")]
    assert contact_writes(fake_api) == []
