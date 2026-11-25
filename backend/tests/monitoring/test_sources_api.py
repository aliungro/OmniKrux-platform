"""The sources API: write-only secrets, audit before every change, validation words, health,
delete reviews and the per-project field catalog."""

import logging
import socket

from cryptography.fernet import Fernet

from omnikrux.audit.store import AuditUnavailable
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.sources.api import (
    AUTH_NEEDS,
    CLUSTER_ONLY,
    FIXED_KIND,
    HEADER_VALUE,
    NOT_LINKED,
    SECRETS_UNREADABLE,
)
from omnikrux.monitoring.sources.transport import URL_PARTS
from omnikrux.security.secrets import SecretBox
from tests.monitoring.fakes import Bearer

BASE = "/api/monitoring/sources"


def bearer_body(url: str, **over) -> dict:
    body = {
        "type": "prometheus",
        "reach": "url",
        "url": url,
        "auth": {"type": "bearer", "token": "tok-SECRET-4"},
        "headers": [{"name": "X-Scope-OrgID", "value": "hv-SECRET-5"}],
    }
    return body | over


def closed_port_url() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return f"http://127.0.0.1:{port}"


async def audit_records(http) -> list[dict]:
    return (await http.get("/api/audit")).json()["records"]


async def test_source_secrets_are_write_only(monitoring_app, fake_prometheus, caplog):
    caplog.set_level(logging.DEBUG)
    http, _ = monitoring_app
    body = {
        "type": "prometheus",
        "reach": "url",
        "url": fake_prometheus.url,
        "auth": {"type": "bearer", "token": "tok-SECRET-4"},
        "headers": [{"name": "X-Scope-OrgID", "value": "hv-SECRET-5"}],
    }
    response = await http.post(BASE, json=body)
    assert response.status_code == 201
    created = response.json()
    assert created["auth"] == {
        "type": "bearer",
        "username": None,
        "header_name": None,
        "has_password": False,
        "has_token": True,
        "has_api_key": False,
        "has_client_key": False,
        "has_client_cert": False,
    }
    assert created["headers"] == [{"name": "X-Scope-OrgID", "has_value": True}]
    assert created["name"] == "Prometheus · 127.0.0.1"
    assert created["health"]["state"] == "unknown"
    listed = (await http.get(BASE)).text
    audit = (await http.get("/api/audit")).text
    for text in (str(created), listed, audit, caplog.text):
        assert "tok-SECRET-4" not in text and "hv-SECRET-5" not in text


async def test_patch_keeps_unsent_secrets_and_test_still_authenticates(
    monitoring_app, fake_prometheus
):
    http, _ = monitoring_app
    fake_prometheus.require = Bearer("tok-SECRET-4")
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    patched = await http.patch(f"{BASE}/{created['id']}", json={"name": "Shop metrics"})
    assert patched.status_code == 200, patched.text
    assert patched.json()["name"] == "Shop metrics"
    assert patched.json()["auth"]["has_token"] is True
    assert patched.json()["headers"] == [{"name": "X-Scope-OrgID", "has_value": True}]

    tested = await http.post(f"{BASE}/{created['id']}/test")
    assert tested.json() == {"ok": True, "version": "3.1.0", "message": None}
    sent = fake_prometheus.requests[-1].headers
    assert sent["Authorization"] == "Bearer tok-SECRET-4"
    assert sent["X-Scope-OrgID"] == "hv-SECRET-5"
    # The check is kept and read back as the source's health.
    health = (await http.get(BASE)).json()[0]["health"]
    assert health["state"] == "up" and health["version"] == "3.1.0"
    assert health["checked_at"] is not None

    # A header sent without a value keeps its stored value; a new one needs a value.
    kept = await http.patch(
        f"{BASE}/{created['id']}", json={"headers": [{"name": "X-Scope-OrgID", "value": None}]}
    )
    assert kept.json()["headers"] == [{"name": "X-Scope-OrgID", "has_value": True}]
    refused = await http.patch(f"{BASE}/{created['id']}", json={"headers": [{"name": "X-New"}]})
    assert refused.status_code == 422
    assert refused.json()["detail"] == "Enter a value for the X-New header."


async def test_add_source_is_audited(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    records = [r for r in await audit_records(http) if r["app"] == "monitoring"]
    assert len(records) == 1
    record = records[0]
    assert (record["action"], record["kind"], record["name"], record["outcome"]) == (
        "source_add",
        "source",
        created["name"],
        "succeeded",
    )
    assert record["details"] == {
        "type": "prometheus",
        "reach": "url",
        "target": fake_prometheus.url,
        "auth": "bearer",
        "headers": ["X-Scope-OrgID"],
    }


async def test_change_and_failed_change_are_audited(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    first = (await http.post(BASE, json=bearer_body(fake_prometheus.url, name="One"))).json()
    await http.post(BASE, json=bearer_body(fake_prometheus.url, name="Two"))
    taken = await http.patch(f"{BASE}/{first['id']}", json={"name": "Two"})
    assert taken.status_code == 409
    assert taken.json()["detail"] == 'A source named "Two" already exists. Pick another name.'
    changes = [r for r in await audit_records(http) if r["action"] == "source_change"]
    assert [(r["name"], r["outcome"], r["message"]) for r in changes] == [
        ("Two", "failed", 'A source named "Two" already exists. Pick another name.')
    ]


async def test_no_audit_no_source(monitoring_app, fake_prometheus, monkeypatch):
    http, app = monitoring_app

    async def broken(entry):
        raise AuditUnavailable("disk I/O error")

    monkeypatch.setattr(app.state.audit, "begin_app", broken)
    response = await http.post(BASE, json=bearer_body(fake_prometheus.url))
    assert response.status_code == 503
    assert response.json() == {
        "detail": "Nothing was changed: the audit log can't be written (disk I/O error)."
    }
    assert (await http.get(BASE)).json() == []


async def test_source_validation_words(monitoring_app, fake_prometheus, kube_cluster):
    http, _ = monitoring_app

    async def refused(body: dict) -> str:
        response = await http.post(BASE, json=body)
        assert response.status_code == 422, response.text
        return response.json()["detail"]

    with_userinfo = fake_prometheus.url.replace("http://", "http://u:p@")
    assert await refused({"type": "prometheus", "reach": "url", "url": with_userinfo}) == URL_PARTS
    assert (
        await refused({"type": "prometheus", "reach": "url", "url": fake_prometheus.url + "?a=1"})
        == URL_PARTS
    )
    cluster = {
        "type": "prometheus",
        "reach": "cluster",
        "cluster_id": kube_cluster,
        "namespace": "monitoring",
        "service": "prometheus-server",
        "port": "80",
    }
    assert await refused(cluster | {"auth": {"type": "bearer", "token": "t"}}) == CLUSTER_ONLY
    assert await refused(cluster | {"headers": [{"name": "X-A", "value": "v"}]}) == CLUSTER_ONLY
    basic = {"type": "basic", "username": "admin"}
    assert (
        await refused(
            {"type": "prometheus", "reach": "url", "url": fake_prometheus.url} | {"auth": basic}
        )
        == "Basic authentication needs a user name and a password."
    )
    too_many = [{"name": f"X-H{i}", "value": "v"} for i in range(21)]
    assert (
        await refused(bearer_body(fake_prometheus.url, headers=too_many))
        == "A source takes at most 20 custom headers."
    )
    assert (await http.get(BASE)).json() == []
    assert [r for r in await audit_records(http) if r["app"] == "monitoring"] == []


async def test_type_and_reach_cannot_change(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    for change in ({"type": "loki"}, {"reach": "cluster"}):
        response = await http.patch(f"{BASE}/{created['id']}", json=change)
        assert response.status_code == 422
        assert response.json()["detail"] == FIXED_KIND


async def test_health_marks_down_with_words_and_caches(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    down = (
        await http.post(BASE, json={"type": "prometheus", "reach": "url", "url": closed_port_url()})
    ).json()
    up = (
        await http.post(
            BASE, json={"type": "prometheus", "reach": "url", "url": fake_prometheus.url}
        )
    ).json()

    first = (await http.get(f"{BASE}/health")).json()
    assert first[down["id"]]["state"] == "down"
    assert first[down["id"]]["message"].startswith("Can't reach")
    assert first[up["id"]]["state"] == "up"
    seen = len(fake_prometheus.requests)

    second = (await http.get(f"{BASE}/health")).json()
    assert second == first
    assert len(fake_prometheus.requests) == seen

    await http.get(f"{BASE}/health", params={"refresh": "true"})
    assert len(fake_prometheus.requests) > seen
    listed = {s["id"]: s["health"] for s in (await http.get(BASE)).json()}
    assert listed[down["id"]]["state"] == "down"


async def test_health_of_a_removed_cluster_is_down(
    monitoring_app, fake_api, fake_prometheus, kube_cluster
):
    http, app = monitoring_app
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    body = {
        "type": "prometheus",
        "reach": "cluster",
        "cluster_id": kube_cluster,
        "namespace": "monitoring",
        "service": "prometheus-server",
        "port": "80",
    }
    created = (await http.post(BASE, json=body)).json()
    cluster_name = (await app.state.registry.get(kube_cluster)).name
    assert created["name"] == f"Prometheus · {cluster_name}"
    assert created["cluster_name"] == cluster_name
    assert (await http.get(f"{BASE}/health")).json()[created["id"]]["state"] == "up"

    await app.state.registry.delete(kube_cluster)
    after = (await http.get(f"{BASE}/health")).json()[created["id"]]
    assert after["state"] == "down"
    assert after["message"] == messages.UNKNOWN_CLUSTER.format(name=created["name"])
    listed = (await http.get(BASE)).json()[0]
    assert listed["health"]["state"] == "down" and listed["cluster_name"] is None


async def test_delete_review_and_stale_token(monitoring_app, fake_prometheus):
    http, app = monitoring_app
    services = app.state.monitoring
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    shop = await services.projects.create("Shop", "custom", None)
    await services.projects.link(shop.id, created["id"], (), "none")

    review = (await http.get(f"{BASE}/{created['id']}/delete-review")).json()
    assert review["source_id"] == created["id"] and review["name"] == created["name"]
    assert review["projects"] == [{"id": shop.id, "name": "Shop"}]

    other = await services.projects.create("Billing", "custom", None)
    await services.projects.link(other.id, created["id"], (), "none")
    stale = await http.delete(f"{BASE}/{created['id']}", params={"token": review["token"]})
    assert stale.status_code == 409
    assert stale.json() == {"detail": "Something changed since the review. Review it again."}
    assert len((await http.get(BASE)).json()) == 1
    assert len((await services.projects.get(other.id)).links) == 1

    fresh = (await http.get(f"{BASE}/{created['id']}/delete-review")).json()
    gone = await http.delete(f"{BASE}/{created['id']}", params={"token": fresh["token"]})
    assert gone.status_code == 204
    assert (await http.get(BASE)).json() == []
    assert (await services.projects.get(shop.id)).links == ()
    removes = [r for r in await audit_records(http) if r["action"] == "source_remove"]
    assert [(r["outcome"], r["name"]) for r in removes] == [
        ("succeeded", created["name"]),
        ("failed", created["name"]),
    ]
    missing = await http.get(f"{BASE}/{created['id']}/delete-review")
    assert missing.status_code == 404


async def test_test_unsaved_source_stores_nothing(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    fake_prometheus.require = Bearer("tok-SECRET-4")
    ok = await http.post(f"{BASE}/test", json=bearer_body(fake_prometheus.url))
    assert ok.json() == {"ok": True, "version": "3.1.0", "message": None}
    wrong = await http.post(
        f"{BASE}/test",
        json=bearer_body(fake_prometheus.url, auth={"type": "bearer", "token": "nope"}),
    )
    assert wrong.json()["ok"] is False and "rejected the credentials" in wrong.json()["message"]
    assert (await http.get(BASE)).json() == []
    assert [r for r in await audit_records(http) if r["app"] == "monitoring"] == []


async def test_fields_apply_the_projects_filter(monitoring_app, fake_prometheus):
    http, app = monitoring_app
    services = app.state.monitoring
    fake_prometheus.labels = ["job", "namespace"]
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    shop = await services.projects.create("Shop", "custom", None)

    unlinked = await http.get(f"{BASE}/{created['id']}/fields", params={"project": shop.id})
    assert unlinked.status_code == 404 and unlinked.json()["detail"] == NOT_LINKED

    await services.projects.link(
        shop.id, created["id"], (Matcher("namespace", "=", "shop"),), "user"
    )
    fields = await http.get(f"{BASE}/{created['id']}/fields", params={"project": shop.id})
    assert fields.status_code == 200, fields.text
    assert fields.json()["labels"] == ["job", "namespace"]
    labels_request = next(r for r in fake_prometheus.requests if r.path == "/api/v1/labels")
    assert labels_request.params["match[]"] == ['{namespace="shop"}']

    alerting = (await http.get(f"{BASE}/{created['id']}/alerting")).json()
    assert set(alerting) == {"omnikrux_engine", "tool_engine", "reason"}


async def test_undecryptable_source_still_lists_and_takes_new_secrets(
    monitoring_app, fake_prometheus
):
    http, app = monitoring_app
    fake_prometheus.require = Bearer("tok-NEW-6")
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    lose_the_key(app)

    listed = await http.get(BASE)
    assert listed.status_code == 200
    health = listed.json()[0]["health"]
    assert health["state"] == "down" and health["message"] == SECRETS_UNREADABLE
    assert (await http.get(f"{BASE}/health")).json()[created["id"]]["message"] == (
        SECRETS_UNREADABLE
    )

    patched = await http.patch(
        f"{BASE}/{created['id']}",
        json={
            "auth": {"type": "bearer", "token": "tok-NEW-6"},
            "headers": [{"name": "X-Scope-OrgID", "value": "hv-NEW-7"}],
        },
    )
    assert patched.status_code == 200, patched.text
    tested = await http.post(f"{BASE}/{created['id']}/test")
    assert tested.json()["ok"] is True


async def test_source_reads_refuse_cross_origin(monitoring_app):
    http, _ = monitoring_app
    for path in (BASE, f"{BASE}/health"):
        response = await http.get(path, headers={"Origin": "http://evil.example"})
        assert response.status_code == 403
        assert response.json() == {"detail": "Cross-origin request refused"}


async def test_empty_secrets_are_refused(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    url = {"type": "prometheus", "reach": "url", "url": fake_prometheus.url}
    cases = [
        ({"type": "basic", "username": "admin", "password": ""}, "basic"),
        ({"type": "bearer", "token": ""}, "bearer"),
        ({"type": "api_key", "header_name": "X-Api-Key", "api_key": ""}, "api_key"),
        ({"type": "mtls", "client_cert_pem": "cert", "client_key_pem": ""}, "mtls"),
    ]
    for auth, kind in cases:
        response = await http.post(BASE, json=url | {"auth": auth})
        assert response.status_code == 422, auth
        assert response.json()["detail"] == AUTH_NEEDS[kind]
    # On PATCH too: an empty value never replaces a stored one.
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    emptied = await http.patch(
        f"{BASE}/{created['id']}", json={"auth": {"type": "bearer", "token": ""}}
    )
    assert emptied.status_code == 422 and emptied.json()["detail"] == AUTH_NEEDS["bearer"]


def lose_the_key(app) -> None:
    app.state.monitoring.sources._box = SecretBox(Fernet.generate_key())


async def test_undecryptable_source_recovers_without_credentials(monitoring_app, fake_prometheus):
    http, app = monitoring_app
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    lose_the_key(app)

    patched = await http.patch(
        f"{BASE}/{created['id']}", json={"auth": {"type": "none"}, "headers": []}
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["health"]["state"] in ("unknown", "up")
    assert patched.json()["health"]["message"] != SECRETS_UNREADABLE
    health = (await http.get(f"{BASE}/health")).json()[created["id"]]
    assert health["state"] == "up" and health["message"] is None
    fields = await http.get(f"{BASE}/{created['id']}/alerting")
    assert fields.status_code == 200


async def test_undecryptable_source_needs_every_secret_again(monitoring_app, fake_prometheus):
    http, app = monitoring_app
    created = (await http.post(BASE, json=bearer_body(fake_prometheus.url))).json()
    lose_the_key(app)
    path = f"{BASE}/{created['id']}"
    header_value = HEADER_VALUE.format(name="X-Scope-OrgID")

    token_only = await http.patch(path, json={"auth": {"type": "bearer", "token": "tok-NEW"}})
    assert token_only.status_code == 422 and token_only.json()["detail"] == header_value
    unvalued = await http.patch(
        path,
        json={
            "auth": {"type": "bearer", "token": "tok-NEW"},
            "headers": [{"name": "X-Scope-OrgID"}],
        },
    )
    assert unvalued.status_code == 422 and unvalued.json()["detail"] == header_value
    headers_only = await http.patch(
        path, json={"headers": [{"name": "X-Scope-OrgID", "value": "hv-NEW"}]}
    )
    assert headers_only.status_code == 422
    assert headers_only.json()["detail"] == AUTH_NEEDS["bearer"]
    # Nothing was changed: the source still asks for its credentials.
    listed = (await http.get(BASE)).json()[0]
    assert listed["health"]["message"] == SECRETS_UNREADABLE
