"""Grafana connections over the API: add, change, test and remove them, and list a Grafana's
dashboards, saved or as entered. Secrets are write-only and never leave by a side door; every
write is audited; a Grafana that can't be read says why in plain words."""

import logging
from datetime import datetime

from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.transfer.api import (
    BASIC_NEEDS,
    CLUSTER_NO_SIGN_IN,
    CLUSTER_PICK,
    GRAFANA_GONE,
    GRAFANA_URL_RULE,
    REACH_FIXED,
    TOKEN_NEEDED,
)
from omnikrux.monitoring.transfer.grafana_client import NOT_GRAFANA, SIGN_IN_CLUSTER, SIGN_IN_URL
from omnikrux.monitoring.transfer.origins import OriginRecord
from tests.monitoring.conftest import GRAFANA_TOKEN
from tests.monitoring.fakes import Basic, Bearer, grafana_answer
from tests.monitoring.test_rules_api import monitoring_records, refusal

API = "/api/monitoring"
GRAFANA = f"{API}/grafana"


def by_url(url: str, **over) -> dict:
    return {"reach": "url", "url": url, "auth": {"type": "bearer", "token": GRAFANA_TOKEN}} | over


def in_cluster(cluster_id: str, **over) -> dict:
    body = {
        "reach": "cluster",
        "cluster_id": cluster_id,
        "namespace": "monitoring",
        "service": "grafana",
        "port": "80",
    }
    return body | over


async def add(http, body: dict) -> dict:
    created = await http.post(GRAFANA, json=body)
    assert created.status_code == 201, created.text
    return created.json()


async def test_grafana_secrets_are_write_only(monitoring_app, fake_grafana_auth, caplog):
    caplog.set_level(logging.DEBUG)
    http, _ = monitoring_app
    created = (
        await http.post(
            GRAFANA,
            json={
                "reach": "url",
                "url": fake_grafana_auth.url,
                "auth": {"type": "bearer", "token": "glsa_SECRET-11"},
            },
        )
    ).json()
    assert created["auth"] == {
        "type": "bearer",
        "username": None,
        "has_password": False,
        "has_token": True,
    }
    assert created["name"] == "Grafana · 127.0.0.1"
    tested = await http.post(f"{GRAFANA}/{created['id']}/test")
    listed = await http.get(f"{GRAFANA}/{created['id']}/dashboards")
    texts = [
        str(created),
        tested.text,
        listed.text,
        (await http.get(GRAFANA)).text,
        (await http.get("/api/audit")).text,
        caplog.text,
    ]
    assert all("glsa_SECRET-11" not in t for t in texts)
    assert tested.json()["ok"] is True  # the stored token was sent


async def test_grafana_errors_never_carry_secrets(monitoring_app, fake_grafana_auth, caplog):
    caplog.set_level(logging.DEBUG)
    http, app = monitoring_app
    fake_grafana_auth.echo_auth_in_errors = True
    body = by_url(fake_grafana_auth.url, auth={"type": "bearer", "token": "glsa_SECRET-12"})
    listed = await http.post(f"{GRAFANA}/dashboards", json=body)
    name = "Grafana · 127.0.0.1"
    assert refusal(listed) == (502, "grafana", SIGN_IN_URL.format(name=name, status=401))
    tested = (await http.post(f"{GRAFANA}/test", json=body)).json()
    assert tested == {
        "ok": False,
        "version": "11.3.0",
        "message": SIGN_IN_URL.format(name=name, status=401),
        "dashboards": None,
        "same_as": None,
    }
    created = await add(http, body)
    rules = await app.state.monitoring.grafana_client.alert_rules(
        await app.state.monitoring.grafana.get(created["id"]), "api"
    )
    texts = [listed.text, str(tested), str(created), str(rules), caplog.text]
    texts.append((await http.get("/api/audit")).text)
    texts.append((await http.post(f"{GRAFANA}/{created['id']}/test")).text)
    assert all("glsa_SECRET-12" not in t for t in texts)
    # The Grafana really did echo the header back.
    assert any(r.headers.get("Authorization") for r in fake_grafana_auth.requests)


async def test_list_dashboards_through_the_cluster(
    fake_api, fake_grafana, kube_cluster, monitoring_app
):
    http, _ = monitoring_app
    fake_api.service_backends[("monitoring", "grafana:80")] = fake_grafana.url
    fake_grafana.dashboards = {
        "b": grafana_answer("b", "beta", folder="Ops"),
        "a": grafana_answer("a", "Alpha", folder="Ops"),
        "r": grafana_answer("r", "Root"),
        "z": grafana_answer("z", "Zeta", folder="apps"),
    }
    got = await http.post(f"{GRAFANA}/dashboards", json=in_cluster(kube_cluster))
    assert got.status_code == 200, got.text
    assert [i["uid"] for i in got.json()["items"]] == ["r", "z", "a", "b"]
    assert got.json()["items"][0] == {"uid": "r", "title": "Root", "folder": None, "tags": []}
    assert got.json()["truncated"] is False


async def test_a_cluster_grafana_that_wants_a_sign_in_says_so(
    fake_api, fake_grafana, kube_cluster, monitoring_app
):
    http, app = monitoring_app
    fake_api.service_backends[("monitoring", "grafana:80")] = fake_grafana.url
    fake_grafana.require = Basic("admin", "admin")
    cluster = (await app.state.registry.get(kube_cluster)).name
    got = await http.post(f"{GRAFANA}/dashboards", json=in_cluster(kube_cluster))
    assert got.status_code == 502
    assert got.json()["detail"]["code"] == "grafana"
    assert got.json()["detail"]["message"] == SIGN_IN_CLUSTER.format(name=f"Grafana · {cluster}")
    created = await add(http, in_cluster(kube_cluster))
    assert (created["name"], created["cluster_name"]) == (f"Grafana · {cluster}", cluster)
    saved = await http.get(f"{GRAFANA}/{created['id']}/dashboards")
    assert refusal(saved) == (502, "grafana", SIGN_IN_CLUSTER.format(name=created["name"]))


async def test_cluster_reach_refuses_a_sign_in(kube_cluster, monitoring_app):
    http, _ = monitoring_app
    body = in_cluster(kube_cluster, auth={"type": "bearer", "token": "glsa_SECRET-14"})
    for route in (GRAFANA, f"{GRAFANA}/test", f"{GRAFANA}/dashboards"):
        got = await http.post(route, json=body)
        assert refusal(got) == (422, "invalid_input", CLUSTER_NO_SIGN_IN)
        assert "glsa_SECRET-14" not in got.text
    created = await add(http, in_cluster(kube_cluster))
    patched = await http.patch(f"{GRAFANA}/{created['id']}", json={"auth": {"type": "basic"}})
    assert refusal(patched) == (422, "invalid_input", CLUSTER_NO_SIGN_IN)


async def test_the_rules_of_a_connection(kube_cluster, monitoring_app):
    http, _ = monitoring_app
    cases = [
        ({"reach": "url"}, GRAFANA_URL_RULE),
        ({"reach": "url", "url": "ftp://grafana.example"}, GRAFANA_URL_RULE),
        ({"reach": "cluster", "cluster_id": kube_cluster, "namespace": "monitoring"}, CLUSTER_PICK),
        ({"reach": "url", "url": "http://g.example", "auth": {"type": "bearer"}}, TOKEN_NEEDED),
        (
            {"reach": "url", "url": "http://g.example", "auth": {"type": "basic", "username": "a"}},
            BASIC_NEEDS,
        ),
        (
            {"reach": "url", "url": "http://g.example", "auth": {"type": "basic", "password": "p"}},
            BASIC_NEEDS,
        ),
    ]
    for body, words in cases:
        got = await http.post(GRAFANA, json=body)
        assert refusal(got) == (422, "invalid_input", words), body
    odd = await http.post(GRAFANA, json={"reach": "url", "url": "http://g", "colour": "red"})
    assert refusal(odd)[:2] == (422, "invalid_input")
    assert (await http.get(GRAFANA)).json() == []


async def test_test_reports_version_and_count(monitoring_app, fake_grafana_auth):
    http, _ = monitoring_app
    got = await http.post(f"{GRAFANA}/test", json=by_url(fake_grafana_auth.url))
    assert got.json() == {
        "ok": True,
        "version": "11.3.0",
        "message": None,
        "dashboards": 3,
        "same_as": None,
    }
    assert (await http.get(GRAFANA)).json() == []  # nothing stored
    assert [r for r in await monitoring_records(http) if r["kind"] == "grafana"] == []
    fake_grafana_auth.version = "13.3.0"
    created = await add(http, by_url(fake_grafana_auth.url, name="Ops Grafana"))
    tested = await http.post(f"{GRAFANA}/{created['id']}/test")
    assert tested.json() == {
        "ok": True,
        "version": "13.3.0",
        "message": None,
        "dashboards": 3,
        "same_as": None,
    }


async def test_not_grafana_is_said_plainly(monitoring_app, fake_grafana):
    http, _ = monitoring_app
    fake_grafana.mode = "not_grafana"
    body = {"reach": "url", "url": fake_grafana.url, "name": "Shop Grafana"}
    tested = await http.post(f"{GRAFANA}/test", json=body)
    assert tested.json() == {
        "ok": False,
        "version": None,
        "message": NOT_GRAFANA.format(name="Shop Grafana"),
        "dashboards": None,
        "same_as": None,
    }
    listed = await http.post(f"{GRAFANA}/dashboards", json=body)
    assert refusal(listed) == (502, "grafana", NOT_GRAFANA.format(name="Shop Grafana"))


async def test_saved_dashboards_list_and_marks_truncation(monitoring_app, fake_grafana):
    http, _ = monitoring_app
    fake_grafana.dashboards = {f"d{n}": grafana_answer(f"d{n}", f"D {n}") for n in range(5000)}
    created = await add(http, {"reach": "url", "url": fake_grafana.url})
    got = (await http.get(f"{GRAFANA}/{created['id']}/dashboards")).json()
    assert len(got["items"]) == 5000 and got["truncated"] is True


async def test_grafana_writes_are_audited(monitoring_app, fake_grafana_auth):
    http, _ = monitoring_app
    created = await add(http, by_url(fake_grafana_auth.url, name="Ops"))
    changed = await http.patch(
        f"{GRAFANA}/{created['id']}",
        json={"name": "Ops 2", "auth": {"type": "basic", "username": "ana", "password": "pw-15"}},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["auth"] == {
        "type": "basic",
        "username": "ana",
        "has_password": True,
        "has_token": False,
    }
    removed = await http.delete(f"{GRAFANA}/{created['id']}")
    assert removed.status_code == 204
    records = [r for r in await monitoring_records(http) if r["kind"] == "grafana"]
    assert [(r["action"], r["name"], r["outcome"]) for r in records] == [
        ("grafana_add", "Ops", "succeeded"),
        ("grafana_change", "Ops 2", "succeeded"),
        ("grafana_remove", "Ops 2", "succeeded"),
    ]
    assert records[0]["details"] == {
        "reach": "url",
        "target": fake_grafana_auth.url,
        "auth": "bearer",
    }
    assert records[1]["details"]["auth"] == "basic"
    assert records[2]["details"] == {"dashboards_imported": 0}
    text = str(records)
    assert GRAFANA_TOKEN not in text and "pw-15" not in text
    assert (await http.get(GRAFANA)).json() == []


async def test_a_change_keeps_secrets_unless_the_sign_in_changes(monitoring_app, fake_grafana_auth):
    http, _ = monitoring_app
    created = await add(http, by_url(fake_grafana_auth.url))
    url = f"{GRAFANA}/{created['id']}"
    kept = await http.patch(url, json={"auth": {"type": "bearer"}, "path_prefix": ""})
    assert kept.json()["auth"]["has_token"] is True
    assert (await http.post(f"{url}/test")).json()["ok"] is True
    reach = await http.patch(url, json={"reach": "cluster"})
    assert refusal(reach) == (422, "invalid_input", REACH_FIXED)
    switch = await http.patch(url, json={"auth": {"type": "basic", "username": "ana"}})
    assert refusal(switch) == (422, "invalid_input", BASIC_NEEDS)
    none = await http.patch(url, json={"auth": {"type": "none"}})
    assert none.json()["auth"] == {
        "type": "none",
        "username": None,
        "has_password": False,
        "has_token": False,
    }
    back = await http.patch(url, json={"auth": {"type": "bearer"}})
    assert refusal(back) == (422, "invalid_input", TOKEN_NEEDED)


async def test_an_unknown_connection_is_gone(monitoring_app):
    http, _ = monitoring_app
    for got in (
        await http.patch(f"{GRAFANA}/nope", json={"name": "x"}),
        await http.delete(f"{GRAFANA}/nope"),
        await http.post(f"{GRAFANA}/nope/test"),
        await http.get(f"{GRAFANA}/nope/dashboards"),
    ):
        assert refusal(got) == (404, "not_found", GRAFANA_GONE)


async def test_names_are_unique_and_a_taken_name_is_refused(monitoring_app, fake_grafana):
    http, _ = monitoring_app
    first = await add(http, {"reach": "url", "url": fake_grafana.url})
    second = await add(http, {"reach": "url", "url": fake_grafana.url})
    assert (first["name"], second["name"]) == ("Grafana · 127.0.0.1", "Grafana · 127.0.0.1 (2)")
    taken = await http.post(
        GRAFANA, json={"reach": "url", "url": fake_grafana.url, "name": "Grafana · 127.0.0.1"}
    )
    assert refusal(taken)[:2] == (409, "name_taken")


async def test_removing_a_grafana_keeps_imported_dashboards(
    monitoring_app, fake_grafana_auth, linked_project
):
    http, app = monitoring_app
    services = app.state.monitoring
    created = await add(http, by_url(fake_grafana_auth.url, name="Ops"))
    dashboard = await http.post(
        f"{API}/dashboards",
        json={
            "owner_kind": "project",
            "owner_id": linked_project.project_id,
            "spec": {"schemaVersion": 1, "title": "Imported", "panels": []},
        },
    )
    assert dashboard.status_code == 201, dashboard.text
    dashboard_id = dashboard.json()["id"]
    at = datetime.fromisoformat(created["created_at"])
    await services.origins.record(
        OriginRecord(
            dashboard_id=dashboard_id,
            kind="grafana",
            via="grafana",
            label="Ops",
            grafana_id=created["id"],
            grafana_uid="api",
            grafana_version=1,
            export_id=None,
            source_title="api",
            mapping={},
            digest="d",
            imported_at=at,
            imported_version=1,
        )
    )
    [listed] = (await http.get(GRAFANA)).json()
    assert listed["dashboards_imported"] == 1
    assert (await http.delete(f"{GRAFANA}/{created['id']}")).status_code == 204
    [record] = [r for r in await monitoring_records(http) if r["action"] == "grafana_remove"]
    assert record["details"] == {"dashboards_imported": 1}
    assert (await http.get(f"{API}/dashboards/{dashboard_id}")).status_code == 200
    origin = await services.origins.get(dashboard_id)
    assert origin is not None and origin.grafana_id is None


async def test_a_sign_in_change_without_a_type_keeps_the_sign_in(monitoring_app, fake_grafana_auth):
    http, _ = monitoring_app
    created = await add(http, by_url(fake_grafana_auth.url))
    url = f"{GRAFANA}/{created['id']}"
    fake_grafana_auth.require = Bearer("glsa_SECRET-16")
    changed = await http.patch(url, json={"auth": {"token": "glsa_SECRET-16"}})
    assert changed.status_code == 200, changed.text
    assert changed.json()["auth"] == {
        "type": "bearer",
        "username": None,
        "has_password": False,
        "has_token": True,
    }
    assert (await http.post(f"{url}/test")).json()["ok"] is True  # the new token is sent
    assert "glsa_SECRET-16" not in changed.text

    basic = await add(
        http,
        by_url(
            fake_grafana_auth.url,
            name="Basic",
            auth={"type": "basic", "username": "ana", "password": "pw-1"},
        ),
    )
    fake_grafana_auth.require = Basic("ana", "pw-2")
    kept = await http.patch(f"{GRAFANA}/{basic['id']}", json={"auth": {"password": "pw-2"}})
    assert kept.json()["auth"] == {
        "type": "basic",
        "username": "ana",
        "has_password": True,
        "has_token": False,
    }
    assert (await http.post(f"{GRAFANA}/{basic['id']}/test")).json()["ok"] is True
    # A connection without a sign-in still takes none from a type-less change.
    plain = await add(http, {"reach": "url", "url": fake_grafana_auth.url, "name": "Plain"})
    still = await http.patch(f"{GRAFANA}/{plain['id']}", json={"auth": {}})
    assert still.json()["auth"]["type"] == "none"


async def test_a_change_or_removal_forgets_the_cached_tls_setting(
    monitoring_app, fake_grafana_auth, monkeypatch
):
    http, app = monitoring_app
    transports = app.state.monitoring.transports
    forgotten: list[str] = []
    forget = transports.forget
    monkeypatch.setattr(transports, "forget", lambda key: (forgotten.append(key), forget(key)))
    created = await add(http, by_url(fake_grafana_auth.url))
    assert forgotten == []
    await http.patch(f"{GRAFANA}/{created['id']}", json={"name": "Renamed"})
    assert forgotten == [f"grafana:{created['id']}"]
    assert (await http.delete(f"{GRAFANA}/{created['id']}")).status_code == 204
    assert forgotten == [f"grafana:{created['id']}"] * 2


async def test_a_cluster_that_may_not_proxy_keeps_its_own_words(
    fake_api, fake_grafana, kube_cluster, monitoring_app
):
    http, app = monitoring_app
    fake_api.service_backends[("monitoring", "grafana:80")] = fake_grafana.url
    fake_api.proxy_forbidden = True
    cluster = (await app.state.registry.get(kube_cluster)).name
    name = f"Grafana · {cluster}"
    words = messages.FORBIDDEN.format(name=name, cluster=cluster)
    listed = await http.post(f"{GRAFANA}/dashboards", json=in_cluster(kube_cluster))
    assert refusal(listed) == (502, "grafana", words)
    tested = (await http.post(f"{GRAFANA}/test", json=in_cluster(kube_cluster))).json()
    assert (tested["ok"], tested["message"]) == (False, words)


async def test_removing_a_connection_names_the_other(
    monitoring_app, fake_grafana_auth, linked_project
):
    """Two connections to one Grafana (compared by target, never by sign-in) name each other, a
    test says so, and removing one hands its dashboards to the other."""
    http, app = monitoring_app
    services = app.state.monitoring
    first = await add(http, by_url(fake_grafana_auth.url, name="Ops"))
    alone = (await http.get(GRAFANA)).json()
    assert [g["same_as"] for g in alone] == [None]
    tested = (await http.post(f"{GRAFANA}/test", json=by_url(fake_grafana_auth.url))).json()
    assert tested["ok"] is True and tested["same_as"] == "Ops"
    second = await add(http, by_url(fake_grafana_auth.url + "/", name="Lab"))
    by_name = {g["name"]: g for g in (await http.get(GRAFANA)).json()}
    assert (by_name["Ops"]["same_as"], by_name["Lab"]["same_as"]) == ("Lab", "Ops")
    own = (await http.post(f"{GRAFANA}/{first['id']}/test")).json()
    assert own["same_as"] == "Lab"
    dashboard = await http.post(
        f"{API}/dashboards",
        json={
            "owner_kind": "project",
            "owner_id": linked_project.project_id,
            "spec": {"schemaVersion": 1, "title": "Imported", "panels": []},
        },
    )
    dashboard_id = dashboard.json()["id"]
    await services.origins.record(
        OriginRecord(
            dashboard_id=dashboard_id,
            kind="grafana",
            via="grafana",
            label="Ops",
            grafana_id=first["id"],
            grafana_uid="api",
            grafana_version=1,
            export_id=None,
            source_title="api",
            mapping={},
            digest="d",
            imported_at=datetime.fromisoformat(first["created_at"]),
            imported_version=1,
        )
    )
    assert (await http.delete(f"{GRAFANA}/{first['id']}")).status_code == 204
    origin = await services.origins.get(dashboard_id)
    assert origin is not None and origin.grafana_id == second["id"]
    [left] = (await http.get(GRAFANA)).json()
    assert left["same_as"] is None and left["dashboards_imported"] == 1
    assert (await http.post(f"{GRAFANA}/{left['id']}/test")).json()["same_as"] is None


async def test_testing_an_edit_never_names_itself(monitoring_app, fake_grafana_auth):
    http, _ = monitoring_app
    ops = await add(http, by_url(fake_grafana_auth.url, name="Ops"))
    body = by_url(fake_grafana_auth.url)
    plain = (await http.post(f"{GRAFANA}/test", json=body)).json()
    assert plain["same_as"] == "Ops"  # a new connection: Ops is the other
    editing = (await http.post(f"{GRAFANA}/test?editing={ops['id']}", json=body)).json()
    assert editing["ok"] is True and editing["same_as"] is None
    await add(http, by_url(fake_grafana_auth.url, name="Lab"))
    again = (await http.post(f"{GRAFANA}/test?editing={ops['id']}", json=body)).json()
    assert again["same_as"] == "Lab"


def test_same_grafana_compares_scheme_and_prefix_too():
    from dataclasses import replace

    from omnikrux.monitoring.sources.types import ClusterTarget
    from omnikrux.monitoring.transfer.grafana_store import (
        GrafanaConfig,
        GrafanaSecrets,
        same_grafana,
    )

    at = datetime(2026, 11, 1)
    base = GrafanaConfig(
        id="a",
        name="A",
        reach="cluster",
        url=None,
        cluster=ClusterTarget("c1", "monitoring", "grafana", "80", "http"),
        path_prefix="",
        auth_type="none",
        username=None,
        secrets=GrafanaSecrets(),
        created_at=at,
        updated_at=at,
    )
    assert same_grafana(base, replace(base, id="b"))
    tls = replace(base, id="b", cluster=ClusterTarget("c1", "monitoring", "grafana", "80", "https"))
    assert not same_grafana(base, tls)
    assert not same_grafana(base, replace(base, id="b", path_prefix="/grafana"))
    assert same_grafana(base, replace(base, id="b", path_prefix="/"))


async def test_a_hand_over_is_audited_and_never_dangles(
    monitoring_app, fake_grafana_auth, linked_project
):
    http, app = monitoring_app
    services = app.state.monitoring
    first = await add(http, by_url(fake_grafana_auth.url, name="Ops"))
    second = await add(http, by_url(fake_grafana_auth.url, name="Lab"))
    made = await http.post(
        f"{API}/dashboards",
        json={
            "owner_kind": "project",
            "owner_id": linked_project.project_id,
            "spec": {"schemaVersion": 1, "title": "Imported", "panels": []},
        },
    )
    did = made.json()["id"]

    async def origin(grafana_id: str):
        await services.origins.record(
            OriginRecord(
                dashboard_id=did,
                kind="grafana",
                via="grafana",
                label="Ops",
                grafana_id=grafana_id,
                grafana_uid="api",
                grafana_version=1,
                export_id=None,
                source_title="api",
                mapping={},
                digest="d",
                imported_at=datetime.fromisoformat(first["created_at"]),
                imported_version=1,
            )
        )

    await origin(first["id"])
    assert (await http.delete(f"{GRAFANA}/{first['id']}")).status_code == 204
    [record] = [r for r in await monitoring_records(http) if r["action"] == "grafana_remove"]
    assert record["details"] == {"dashboards_imported": 1, "handed_to": "Lab"}
    moved = await services.origins.get(did)
    assert moved is not None and (moved.grafana_id, moved.label) == (second["id"], "Lab")
    # A receiver that is gone by the time of the removal: the origin forgets, nothing dangles.
    await origin(second["id"])
    await services.grafana.delete(second["id"], hand_over_to="gone-already")
    left = await services.origins.get(did)
    assert left is not None and left.grafana_id is None
