"""The import commit: everything is checked before anything is written, every write is audited
first, the dashboards are all imported in one transaction (or none is), sources are only ever
ones the target project links, alerts run on OmniKrux's engine, and where each dashboard came
from is recorded for Update from source."""

import json
import logging

from omnikrux.audit.store import AuditUnavailable
from omnikrux.monitoring.transfer import importing
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext
from omnikrux.monitoring.transfer.mapping import LEFT_OUT, apply_mapping
from omnikrux.monitoring.transfer.origins import MappingChoice
from omnikrux.monitoring.transfer.types import SkippedItem, digest
from tests.monitoring.conftest import GRAFANA_TOKEN
from tests.monitoring.test_import_preview import (
    API,
    COMMIT,
    DASHBOARDS,
    board,
    chosen,
    fixture_text,
    grafana_entry,
    grafana_input,
    load,
    preview,
    saved_grafana,
    target,
    text_input,
    with_last_reducer,
)
from tests.monitoring.test_rules_api import monitoring_records, refusal

CONTACT_POINTS = f"{API}/alerts/contact-points"
RULES = f"{API}/alerts/rules"


async def commit(http, input: dict, dashboards: list[dict], **extra):
    return await http.post(COMMIT, json={"input": input, "dashboards": dashboards, **extra})


async def committed(http, input: dict, dashboards: list[dict], **extra) -> dict:
    r = await commit(http, input, dashboards, **extra)
    assert r.status_code == 201, r.text
    return r.json()


async def imports(http) -> list[dict]:
    return [r for r in await monitoring_records(http) if r["action"] == "dashboard_import"]


async def project_with_source(http, name: str, url: str, prefix: str = "") -> tuple[str, str]:
    """(project id, source id): a custom project linked to its own new Prometheus source."""
    body = {"type": "prometheus", "reach": "url", "url": url, "name": f"{name} prom"}
    if prefix:
        body["path_prefix"] = prefix
    source = await http.post(f"{API}/sources", json=body)
    assert source.status_code == 201, source.text
    sid = source.json()["id"]
    project = await http.post(
        f"{API}/setup",
        json={"name": name, "kind": "custom", "sources": [{"source_id": sid, "filter": ""}]},
    )
    assert project.status_code == 201, project.text
    return project.json()["id"], sid


async def create(http, kind: str, owner_id: str, spec: dict) -> dict:
    r = await http.post(DASHBOARDS, json={"owner_kind": kind, "owner_id": owner_id, "spec": spec})
    assert r.status_code == 201, r.text
    return r.json()


def sources_of(spec: dict) -> list[dict]:
    found = [v["source"] for v in spec["variables"]]
    for p in spec["panels"]:
        found.extend(q["source"] for q in p["queries"])
    return found


# --- a Grafana file ----------------------------------------------------------------------------


async def test_commit_creates_and_records_origin(monitoring_app, linked_project):
    http, app = monitoring_app
    shop = linked_project
    to = target("project", shop.project_id)
    text = text_input(fixture_text("gridpos_v22_inputs"))
    p = await preview(http, text, to)
    result = await committed(http, text, chosen(p), target=to)
    [made] = result["dashboards"]
    assert (made["key"], made["title"], made["owner_kind"], made["owner_id"]) == (
        "d-1",
        "API latency",
        "project",
        shop.project_id,
    )
    assert (result["group_id"], result["grafana_id"], result["warnings"]) == (None, None, [])
    got = (await http.get(f"{DASHBOARDS}/{made['id']}")).json()
    assert len(got["spec"]["panels"]) == 4
    assert all(s == {"type": "prometheus", "id": None} for s in sources_of(got["spec"]))
    [version] = (await http.get(f"{DASHBOARDS}/{made['id']}/versions")).json()
    assert (version["origin"], version["copied_from"]) == ("imported", "api.json")
    origin = await app.state.monitoring.origins.get(made["id"])
    assert (origin.kind, origin.via, origin.label, origin.grafana_uid) == (
        "grafana",
        "file",
        "api.json",
        "api-lat",
    )
    assert (origin.grafana_version, origin.grafana_id, origin.imported_version) == (3, None, 1)
    # The origin keeps the converted dashboard's digest (Update from source compares the source
    # with it); the preview's also covers the alerts as attached here.
    converted = convert_grafana(load("gridpos_v22_inputs"), GrafanaContext(), key="d-1")
    assert origin.digest == digest(converted) != p["dashboards"][0]["digest"]
    assert origin.mapping == {"grafana:input:DS_PROM": MappingChoice(None)}
    assert origin.panels == {"2": "p-1", "3": "p-2", "4": "p-3", "5": "p-4"}
    [record] = await imports(http)
    assert record["kind"] == "dashboard" and record["name"] == "API latency"
    details = record["details"]
    batch = details.pop("batch")
    assert len(batch) == 32
    assert details == {
        "owner": "project",
        "owner_name": "Shop",
        "from": "api.json",
        "panels": 4,
        "alerts": 0,
        "skipped": len(p["dashboards"][0]["skipped"]),
    }
    assert record["outcome"] == "succeeded"
    # An audit record never holds a document, a query or the file.
    audit = (await http.get("/api/audit")).text
    assert "histogram_quantile" not in audit and "DS_PROM" not in audit


async def test_pasted_text_is_labelled_as_such(monitoring_app, linked_project):
    http, _ = monitoring_app
    to = target("project", linked_project.project_id)
    text = text_input(fixture_text("gridpos_v22_inputs"), None, "paste")
    p = await preview(http, text, to)
    [made] = (await committed(http, text, chosen(p), target=to))["dashboards"]
    [version] = (await http.get(f"{DASHBOARDS}/{made['id']}/versions")).json()
    assert version["copied_from"] == "pasted JSON"
    nameless = text_input(fixture_text("gridpos_v22_inputs"), None, "file")
    p = await preview(http, nameless, to)
    [made] = (await committed(http, nameless, chosen(p), target=to))["dashboards"]
    assert made["title"] == "API latency (2)"
    [version] = (await http.get(f"{DASHBOARDS}/{made['id']}/versions")).json()
    assert version["copied_from"] == "a file"


async def test_a_changed_source_since_the_check_is_refused(monitoring_app, linked_project):
    http, _ = monitoring_app
    to = target("project", linked_project.project_id)
    text = text_input(fixture_text("gridpos_v22_inputs"))
    p = await preview(http, text, to)
    [pick] = chosen(p)
    r = await commit(http, text, [pick | {"digest": "0" * 64}], target=to)
    assert refusal(r) == (
        409,
        "changed",
        '"API latency" changed since you checked it. Check again.',
    )
    assert r.json()["detail"]["key"] == "d-1"
    # The file changed under the same key: its digest no longer matches either.
    changed = text_input(json.dumps(load("gridpos_v22_inputs") | {"description": "new"}))
    assert (await commit(http, changed, [pick], target=to)).status_code == 409
    assert (await http.get(DASHBOARDS)).json() == [] and await imports(http) == []


async def test_commit_refusals_say_why(monitoring_app, linked_project):
    http, _ = monitoring_app
    to = target("project", linked_project.project_id)
    text = text_input(fixture_text("gridpos_v22_inputs"))
    [pick] = chosen(await preview(http, text, to))
    twice = await commit(http, text, [pick, pick], target=to)
    assert refusal(twice) == (
        422,
        "invalid_input",
        "Each dashboard can be imported only once at a time.",
    )
    nowhere = await commit(http, text, [pick])
    assert refusal(nowhere) == (
        422,
        "invalid_input",
        "Choose where the dashboards go: a project or group, or a new group.",
    )
    gone = await commit(http, text, [pick], target=target("project", "nope"))
    assert refusal(gone) == (
        404,
        "not_found",
        "That project or group no longer exists. Pick another.",
    )
    unknown = await commit(http, text, [pick | {"key": "d-9"}], target=to)
    assert refusal(unknown)[:2] == (409, "changed")
    bad_title = await commit(http, text, [pick | {"title": " "}], target=to)
    status, code, message = refusal(bad_title)
    assert (status, code) == (422, "not_importable")
    assert message.startswith('" " can\'t be imported: title: ')
    assert (await http.get(DASHBOARDS)).json() == [] and await imports(http) == []


# --- everything checked first, one transaction ---------------------------------------------------


async def test_import_checks_everything_before_writing(monitoring_app, linked_project):
    http, _ = monitoring_app
    shop = linked_project.project_id
    for title in ("Alpha", "Beta", "Errors", "Gamma", "Zeta"):
        await create(http, "project", shop, board(title, linked_project.source_id))
    out = (await http.post(f"{API}/export", json={"kind": "project", "id": shop})).json()
    other, _ = await project_with_source(http, "Other", "http://prometheus.example.invalid:9090")
    await create(http, "project", other, board("Errors", None))
    text = text_input(json.dumps(out["export"]), "shop-project.omnikrux.json")
    to = target("project", other)
    p = await preview(http, text, to)
    assert [(d["key"], d["title"], d["title_taken"]) for d in p["dashboards"]] == [
        ("d-1", "Alpha", False),
        ("d-2", "Beta", False),
        ("d-3", "Errors", True),
        ("d-4", "Gamma", False),
        ("d-5", "Zeta", False),
    ]
    as_titled = [
        {"key": d["key"], "title": d["title"], "digest": d["digest"]} for d in p["dashboards"]
    ]
    r = await commit(http, text, as_titled, target=to)
    assert r.status_code == 409
    assert r.json()["detail"] == {
        "code": "name_taken",
        "message": 'A dashboard named "Errors" already exists. Pick another name.',
        "key": "d-3",
        "problems": [],
    }
    owned = (await http.get(DASHBOARDS, params={"owner_kind": "project", "owner_id": other})).json()
    assert [d["title"] for d in owned] == ["Errors"]
    assert await imports(http) == []
    # Two of the batch under one title: refused the same way, naming the second.
    same = [as_titled[0], as_titled[1] | {"title": "Alpha"}]
    r = await commit(http, text, same, target=to)
    assert refusal(r)[:2] == (409, "name_taken") and r.json()["detail"]["key"] == "d-2"
    # Under the suggested titles all five go in, in one batch.
    result = await committed(http, text, chosen(p), target=to)
    assert [d["title"] for d in result["dashboards"]] == [
        "Alpha",
        "Beta",
        "Errors (2)",
        "Gamma",
        "Zeta",
    ]
    records = await imports(http)
    assert len(records) == 5 and len({r["details"]["batch"] for r in records}) == 1
    assert all(r["details"]["from"] == "shop-project.omnikrux.json" for r in records)


async def test_a_failed_write_leaves_nothing_behind(monitoring_app, linked_project, monkeypatch):
    """A write that fails part way (here the third origin row) takes every write back with it."""
    http, app = monitoring_app
    shop = linked_project.project_id
    for title in ("A", "B", "C"):
        await create(http, "project", shop, board(title, linked_project.source_id))
    out = (await http.post(f"{API}/export", json={"kind": "project", "id": shop})).json()
    other, _ = await project_with_source(http, "Other", "http://prometheus.example.invalid:9090")
    text = text_input(json.dumps(out["export"]))
    to = target("project", other)
    p = await preview(http, text, to)
    origins = app.state.monitoring.origins
    real = origins.record
    calls = []

    async def flaky(o, *, session=None):
        calls.append(o.dashboard_id)
        if len(calls) == 3:
            raise RuntimeError("disk full")
        return await real(o, session=session)

    monkeypatch.setattr(origins, "record", flaky)
    r = await commit(http, text, chosen(p), target=to)
    assert r.status_code == 500
    assert r.json()["detail"] == {
        "code": "not_imported",
        "message": "The import couldn't be saved, so nothing was imported. Try again.",
        "key": None,
        "problems": [],
    }
    assert "disk full" not in r.text
    owned = (await http.get(DASHBOARDS, params={"owner_kind": "project", "owner_id": other})).json()
    assert owned == []
    assert [await origins.get(id) for id in calls] == [None, None, None]
    records = await imports(http)
    assert len(records) == 3
    assert all(r["outcome"] == "failed" for r in records)
    assert {r["message"] for r in records} == {importing.NOT_IMPORTED}


async def test_no_audit_no_import(monitoring_app, linked_project, monkeypatch):
    http, app = monitoring_app
    to = target("project", linked_project.project_id)
    text = text_input(fixture_text("gridpos_v22_inputs"))
    p = await preview(http, text, to)

    async def refuse(entry):
        raise AuditUnavailable("disk full")

    monkeypatch.setattr(app.state.audit, "begin_app", refuse)
    r = await commit(http, text, chosen(p), target=to)
    assert r.status_code == 503
    monkeypatch.undo()
    assert (await http.get(DASHBOARDS)).json() == []


# --- sources --------------------------------------------------------------------------------------


async def test_import_never_keeps_an_unlinked_source_id(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    a, s1 = await project_with_source(http, "A", fake_prometheus.url)
    b, s2 = await project_with_source(http, "B", fake_prometheus.url, prefix="/b")
    made = await create(http, "project", b, board("Copied", s2))
    bare = text_input(json.dumps(made["spec"]), None, "paste")
    to = target("project", a)
    p = await preview(http, bare, to)
    [ref] = p["sources"]
    assert (ref["key"], ref["name"], ref["suggestion"]) == (f"id:{s2}", "B prom", None)
    assert ref["reason"] == "Uses A's first Prometheus-compatible source (A prom)."
    r = await commit(
        http, bare, chosen(p), target=to, mapping=[{"key": f"id:{s2}", "source_id": s2}]
    )
    assert refusal(r) == (
        422,
        "unlinked_source",
        '"B prom" isn\'t linked to A. Pick one of its sources.',
    )
    assert r.json()["detail"]["key"] == f"id:{s2}"
    unknown = await commit(
        http, bare, chosen(p), target=to, mapping=[{"key": f"id:{s2}", "source_id": "nope"}]
    )
    assert refusal(unknown)[:2] == (422, "unlinked_source")
    assert (await http.get(DASHBOARDS, params={"owner_id": a})).json() == []
    # Without a mapping, the reference reads A's first source of the type (id null).
    [made_a] = (await committed(http, bare, chosen(p), target=to))["dashboards"]
    spec = (await http.get(f"{DASHBOARDS}/{made_a['id']}")).json()["spec"]
    assert [s["id"] for s in sources_of(spec)] == [None]
    # Mapped to A's own source, it reads that one.
    mapped = await committed(
        http,
        bare,
        [chosen(p)[0] | {"title": "Copied (2)"}],
        target=to,
        mapping=[{"key": f"id:{s2}", "source_id": s1}],
    )
    spec = (await http.get(f"{DASHBOARDS}/{mapped['dashboards'][0]['id']}")).json()["spec"]
    assert [s["id"] for s in sources_of(spec)] == [s1]


async def test_a_source_of_the_other_type_is_refused(monitoring_app, linked_project_with_loki):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    to = target("project", shop.project_id)
    text = text_input(fixture_text("gridpos_v22_inputs"))
    p = await preview(http, text, to)
    r = await commit(
        http,
        text,
        chosen(p),
        target=to,
        mapping=[{"key": "grafana:input:DS_PROM", "source_id": shop.loki_source_id}],
    )
    assert refusal(r) == (
        422,
        "invalid_input",
        (
            '"Shop logs" is a Loki source, and these queries need a Prometheus-compatible one. '
            "Pick another."
        ),
    )


async def test_group_target_nulls_every_source(monitoring_app, linked_project):
    http, _ = monitoring_app
    group = await http.post(
        f"{API}/groups", json={"name": "All", "project_ids": [linked_project.project_id]}
    )
    gid = group.json()["id"]
    bare = text_input(json.dumps(board("Fleet", linked_project.source_id)), None, "paste")
    to = target("group", gid)
    p = await preview(http, bare, to)
    result = await committed(
        http,
        bare,
        chosen(p),
        target=to,
        mapping=[{"key": f"id:{linked_project.source_id}", "source_id": linked_project.source_id}],
    )
    [made] = result["dashboards"]
    assert (made["owner_kind"], made["owner_id"]) == ("group", gid)
    spec = (await http.get(f"{DASHBOARDS}/{made['id']}")).json()["spec"]
    assert [s["id"] for s in sources_of(spec)] == [None]


def test_apply_mapping_leaves_out_queries_panels_and_variables():
    doc = {
        "schemaVersion": 1,
        "title": "Mixed",
        "variables": [
            {"name": "app", "source": {"type": "loki", "id": "L"}, "match": ""},
            {"name": "pod", "source": {"type": "prometheus", "id": "P"}, "match": '{app="$app"}'},
            {"name": "ns", "source": {"type": "prometheus", "id": "P"}, "match": ""},
        ],
        "panels": [
            {
                "id": "p-1",
                "title": "Both",
                "queries": [
                    {"ref": "A", "source": {"type": "prometheus", "id": "P"}, "expr": "up"},
                    {"ref": "B", "source": {"type": "loki", "id": "L"}, "expr": '{a="b"}'},
                ],
                "alert": {"name": "On B", "query": "B"},
            },
            {
                "id": "p-2",
                "title": "Logs",
                "queries": [{"ref": "A", "source": {"type": "loki", "id": "L"}, "expr": "{a=1}"}],
                "alert": None,
            },
            {
                "id": "p-3",
                "title": "Pods",
                "queries": [
                    {
                        "ref": "A",
                        "source": {"type": "prometheus", "id": "P"},
                        "expr": 'up{pod="$pod"}',
                    }
                ],
                "alert": {"name": "Pods down", "query": "A"},
            },
            {
                "id": "p-4",
                "title": "Kept",
                "queries": [
                    {
                        "ref": "A",
                        "source": {"type": "prometheus", "id": "P"},
                        "expr": 'up{ns="$ns"}',
                    }
                ],
                "alert": None,
            },
        ],
    }
    mapping = {"L": MappingChoice(None, True), "P": MappingChoice("src-9")}
    out, skipped = apply_mapping(doc, mapping, owner_kind="project", titles={"L": "Logs here"})
    why = LEFT_OUT.format(name="Logs here")
    assert why == 'Left out on import: its data source "Logs here" wasn\'t mapped.'
    assert [v["name"] for v in out["variables"]] == ["ns"]
    assert [p["id"] for p in out["panels"]] == ["p-1", "p-4"]
    assert [q["ref"] for q in out["panels"][0]["queries"]] == ["A"]
    assert out["panels"][0]["alert"] is None
    assert [s["id"] for s in sources_of(out)] == ["src-9", "src-9", "src-9"]
    assert skipped == [
        SkippedItem("Variable $app", "Its data source", why),
        SkippedItem("Variable $pod", "Its data source", why),
        SkippedItem('Panel "Both"', "Query B", why),
        SkippedItem('Alert "On B"', "The rule", why),
        SkippedItem('Panel "Logs"', "The whole panel", why),
        SkippedItem('Panel "Pods"', "The whole panel", why),
        SkippedItem('Alert "Pods down"', "The rule", why),
    ]
    # The document given is never changed; a group's reads no source of its own.
    assert doc["variables"][0]["name"] == "app"
    grouped, _ = apply_mapping(doc, {}, owner_kind="group", titles={})
    assert all(s["id"] is None for s in sources_of(grouped))


async def test_leave_out_removes_queries_panels_and_variables(
    monitoring_app, linked_project_with_loki
):
    http, app = monitoring_app
    shop = linked_project_with_loki
    to = target("project", shop.project_id)
    text = text_input(fixture_text("gridpos_v39_objects"), "cluster.json")
    p = await preview(http, text, to)
    assert "grafana:uid:loki-main" in [s["key"] for s in p["sources"]]
    result = await committed(
        http,
        text,
        chosen(p),
        target=to,
        mapping=[{"key": "grafana:uid:loki-main", "leave_out": True}],
    )
    [made] = result["dashboards"]
    spec = (await http.get(f"{DASHBOARDS}/{made['id']}")).json()["spec"]
    assert all(s["type"] == "prometheus" for s in sources_of(spec))
    assert "app" not in [v["name"] for v in spec["variables"]]
    origin = await app.state.monitoring.origins.get(made["id"])
    assert origin.mapping["grafana:uid:loki-main"] == MappingChoice(None, True)
    [record] = await imports(http)
    assert record["details"]["skipped"] > len(p["dashboards"][0]["skipped"])


# --- targets ----------------------------------------------------------------------------------------


async def test_wrong_target_kind_is_refused(monitoring_app, linked_project):
    http, _ = monitoring_app
    shop = linked_project.project_id
    await create(http, "project", shop, board("Shop", linked_project.source_id))
    out = (await http.post(f"{API}/export", json={"kind": "project", "id": shop})).json()
    group = await http.post(f"{API}/groups", json={"name": "All", "project_ids": [shop]})
    text = text_input(json.dumps(out["export"]))
    p = await preview(http, text)
    words = "A project export goes into a project, and a group export into a group."
    r = await commit(http, text, chosen(p), target=target("group", group.json()["id"]))
    assert refusal(r) == (422, "wrong_target", words)
    r = await commit(http, text, chosen(p), new_group={"name": "New", "project_ids": [shop]})
    assert refusal(r) == (422, "wrong_target", words)
    assert await imports(http) == []


async def test_group_export_into_a_new_group(monitoring_app, two_projects_on_one_source):
    http, _ = monitoring_app
    two = two_projects_on_one_source
    group = await http.post(f"{API}/groups", json={"name": "Old", "project_ids": [two.a, two.b]})
    await create(http, "group", group.json()["id"], board("Fleet", None))
    out = (
        await http.post(f"{API}/export", json={"kind": "group", "id": group.json()["id"]})
    ).json()
    text = text_input(json.dumps(out["export"]), "old-group.omnikrux.json")
    p = await preview(http, text)
    taken = await commit(http, text, chosen(p), new_group={"name": "Old", "project_ids": [two.a]})
    assert refusal(taken) == (
        409,
        "name_taken",
        'A group named "Old" already exists. Pick another name.',
    )
    gone = await commit(http, text, chosen(p), new_group={"name": "X", "project_ids": ["nope"]})
    assert refusal(gone) == (
        422,
        "invalid_input",
        "One of the chosen projects no longer exists. Reload and pick again.",
    )
    assert len((await http.get(f"{API}/groups")).json()) == 1
    result = await committed(
        http, text, chosen(p), new_group={"name": "Production", "project_ids": [two.a, two.b]}
    )
    gid = result["group_id"]
    groups = {g["name"]: g for g in (await http.get(f"{API}/groups")).json()}
    assert groups["Production"]["id"] == gid
    assert sorted(groups["Production"]["project_ids"]) == sorted([two.a, two.b])
    [made] = result["dashboards"]
    assert (made["owner_kind"], made["owner_id"], made["title"]) == ("group", gid, "Fleet")
    records = await monitoring_records(http)
    [added] = [r for r in records if r["action"] == "group_add" and r["name"] == "Production"]
    assert added["details"] == {"projects": ["Team A", "Team B"]}
    assert added["outcome"] == "succeeded"
    [record] = await imports(http)
    assert record["details"]["owner"] == "group" and record["details"]["owner_name"] == "Production"


# --- a Grafana instance --------------------------------------------------------------------------


async def test_import_from_a_grafana_instance(monitoring_app, linked_project, fake_grafana_auth):
    http, app = monitoring_app
    fake_grafana_auth.dashboards = {
        "api-lat": grafana_entry(load("gridpos_v22_inputs")),
        "cl-ov": grafana_entry(load("gridpos_v39_objects"), folder="Platform"),
    }
    g = await saved_grafana(http, fake_grafana_auth.url)
    input = grafana_input(["api-lat", "cl-ov"], grafana_id=g["id"])
    to = target("project", linked_project.project_id)
    p = await preview(http, input, to)
    assert (p["format"], p["format_label"]) == (
        "grafana_instance",
        "2 Grafana dashboards from Grafana · lab",
    )
    result = await committed(http, input, chosen(p), target=to)
    assert result["grafana_id"] == g["id"]
    origins = [await app.state.monitoring.origins.get(d["id"]) for d in result["dashboards"]]
    assert [(o.via, o.grafana_id, o.grafana_uid, o.grafana_version) for o in origins] == [
        ("grafana", g["id"], "api-lat", 3),
        ("grafana", g["id"], "cl-ov", 12),
    ]
    assert {o.label for o in origins} == {"Grafana · lab"}
    dashboard_reads = [r for r in fake_grafana_auth.requests if r.path.startswith("/api/dash")]
    assert dashboard_reads and all(
        r.headers.get("Authorization") == f"Bearer {GRAFANA_TOKEN}" for r in dashboard_reads
    )
    listed = (await http.get(f"{API}/grafana")).json()
    assert [c["dashboards_imported"] for c in listed] == [2]


async def test_a_dashboard_grafana_cant_send_is_not_importable(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, _ = monitoring_app
    fake_grafana_auth.dashboards = {"api-lat": grafana_entry(load("gridpos_v22_inputs"))}
    g = await saved_grafana(http, fake_grafana_auth.url)
    input = grafana_input(["api-lat", "gone"], grafana_id=g["id"])
    to = target("project", linked_project.project_id)
    p = await preview(http, input, to)
    gone = next(d for d in p["dashboards"] if d["key"] == "gone")
    r = await commit(
        http, input, [{"key": "gone", "title": "gone", "digest": gone["digest"]}], target=to
    )
    assert refusal(r) == (
        422,
        "not_importable",
        '"gone" can\'t be imported: Grafana · lab has no dashboard with the id gone any more.',
    )
    assert r.json()["detail"]["key"] == "gone"
    # The others go in on their own.
    result = await committed(http, input, chosen(p), target=to)
    assert [d["key"] for d in result["dashboards"]] == ["api-lat"]


async def test_an_unsaved_connection_is_saved_on_commit(
    monitoring_app, linked_project, fake_grafana_auth, caplog
):
    caplog.set_level(logging.DEBUG)
    http, _ = monitoring_app
    fake_grafana_auth.dashboards = {"api-lat": grafana_entry(load("gridpos_v22_inputs"))}
    connection = {
        "reach": "url",
        "url": fake_grafana_auth.url,
        "auth": {"type": "bearer", "token": GRAFANA_TOKEN},
    }
    input = grafana_input(["api-lat"], connection=connection)
    to = target("project", linked_project.project_id)
    p = await preview(http, input, to)
    assert p["format_label"] == "Grafana dashboard from Grafana · 127.0.0.1"
    first = await committed(http, input, chosen(p), target=to)
    [saved] = (await http.get(f"{API}/grafana")).json()
    assert saved["name"] == "Grafana · 127.0.0.1" and saved["auth"]["has_token"] is True
    assert first["grafana_id"] == saved["id"]
    again = await committed(http, input, [chosen(p)[0] | {"title": "Second"}], target=to)
    assert again["grafana_id"] == saved["id"]
    assert len((await http.get(f"{API}/grafana")).json()) == 1
    records = await monitoring_records(http)
    adds = [r for r in records if r["action"] == "grafana_add"]
    assert len(adds) == 1 and adds[0]["outcome"] == "succeeded"
    texts = [
        json.dumps(p),
        json.dumps(first),
        json.dumps(again),
        (await http.get("/api/audit")).text,
        (await http.get(f"{API}/grafana")).text,
        caplog.text,
    ]
    assert all(GRAFANA_TOKEN not in t for t in texts)


async def test_a_connection_removed_before_the_write_is_not_named(
    monitoring_app, linked_project, fake_grafana_auth, monkeypatch
):
    http, app = monitoring_app
    fake_grafana_auth.dashboards = {"api-lat": grafana_entry(load("gridpos_v22_inputs"))}
    g = await saved_grafana(http, fake_grafana_auth.url)
    input = grafana_input(["api-lat"], grafana_id=g["id"])
    to = target("project", linked_project.project_id)
    p = await preview(http, input, to)
    real = importing._begin_all

    async def remove_first(*args, **kwargs):
        started = await real(*args, **kwargs)
        await app.state.monitoring.grafana.delete(g["id"])  # removed while the import runs
        return started

    monkeypatch.setattr(importing, "_begin_all", remove_first)
    result = await committed(http, input, chosen(p), target=to)
    assert result["grafana_id"] is None
    origin = await app.state.monitoring.origins.get(result["dashboards"][0]["id"])
    assert (origin.grafana_id, origin.grafana_uid) == (None, "api-lat")


# --- alerts -------------------------------------------------------------------------------------------


async def test_imported_grafana_alert_lands_on_its_panel(monitoring_app, linked_project):
    http, _ = monitoring_app
    to = target("project", linked_project.project_id)
    text = text_input(json.dumps(with_last_reducer(load("gridpos_v22_inputs"))))
    p = await preview(http, text, to)
    assert p["dashboards"][0]["alerts"] == 1
    result = await committed(http, text, chosen(p), target=to)
    assert result["alert_changes"] == []
    spec = (await http.get(f"{DASHBOARDS}/{result['dashboards'][0]['id']}")).json()["spec"]
    alert = spec["panels"][0]["alert"]
    assert (alert["name"], alert["query"], alert["op"], alert["threshold"], alert["for"]) == (
        "p95 too slow",
        "A",
        "above",
        0.3,
        "5m",
    )
    assert (alert["engine"], alert["notify"], alert["message"]) == (
        "omnikrux",
        [],
        "p95 above 300 ms",
    )
    [rule] = (await http.get(RULES)).json()
    assert rule["origin"] == "panel" and rule["name"] == "p95 too slow"
    # A rule OmniKrux can't run stays out, in words, and the panel keeps no alert.
    plain = text_input(fixture_text("gridpos_v22_inputs"))
    p = await preview(http, plain, to)
    result = await committed(http, plain, chosen(p), target=to)
    spec = (await http.get(f"{DASHBOARDS}/{result['dashboards'][0]['id']}")).json()["spec"]
    assert spec["panels"][0]["alert"] is None


def tool_export(alert: dict) -> dict:
    doc = board("Tool alerts", None) | {"title": "Tool alerts"}
    doc["panels"][0]["alert"] = alert
    return {
        "omnikrux": "monitoring-export",
        "formatVersion": 1,
        "kind": "dashboard",
        "exportedAt": "2026-11-20T10:00:00Z",
        "owner": {"kind": "project", "name": "Elsewhere"},
        "sources": [],
        "dashboards": [{"exportId": "x-1", "owner": "project", "version": 2, "dashboard": doc}],
    }


async def test_imported_omnikrux_alerts_run_on_omnikrux(
    monitoring_app, linked_project, fake_webhook
):
    http, app = monitoring_app
    cp = await http.post(
        CONTACT_POINTS,
        json={"name": "Ops hook", "type": "webhook", "secrets": {"url": f"{fake_webhook.url}/h"}},
    )
    assert cp.status_code == 201, cp.text
    alert = {
        "name": "Requests high",
        "query": "A",
        "op": "above",
        "threshold": 5,
        "for": "1m",
        "engine": "tool",
        "channel": {"receiver": "team", "labels": {}},
        "notify": [{"name": "Ops hook"}, {"name": "Unknown"}],
    }
    text = text_input(json.dumps(tool_export(alert)), "tool.omnikrux.json")
    to = target("project", linked_project.project_id)
    p = await preview(http, text, to)
    [d] = p["dashboards"]
    assert d["alerts"] == 1
    whats = [(s["where"], s["what"]) for s in d["skipped"]]
    assert ('Alert on panel "Requests"', "Runs in the tool") in whats
    assert ('Alert on panel "Requests"', 'Contact point "Unknown"') in whats
    result = await committed(http, text, chosen(p), target=to)
    spec = (await http.get(f"{DASHBOARDS}/{result['dashboards'][0]['id']}")).json()["spec"]
    kept = spec["panels"][0]["alert"]
    assert (kept["engine"], kept["channel"], kept["notify"]) == (
        "omnikrux",
        None,
        [cp.json()["id"]],
    )
    assert result["alert_changes"] == []
    origin = await app.state.monitoring.origins.get(result["dashboards"][0]["id"])
    assert (origin.kind, origin.export_id, origin.via) == ("omnikrux", "x-1", "file")


async def test_commit_answers_the_alert_changes(monitoring_app, linked_project):
    http, _ = monitoring_app
    shop = linked_project
    alert = {"name": "Requests high", "query": "A", "op": "above", "threshold": 5, "for": "1m"}
    await create(http, "project", shop.project_id, board("With alert", shop.source_id, alert=alert))
    await create(http, "project", shop.project_id, board("Without", shop.source_id))
    out = (await http.post(f"{API}/export", json={"kind": "project", "id": shop.project_id})).json()
    other, _ = await project_with_source(http, "Other", "http://prometheus.example.invalid:9090")
    text = text_input(json.dumps(out["export"]))
    to = target("project", other)
    p = await preview(http, text, to)
    result = await committed(http, text, chosen(p), target=to)
    assert [d["title"] for d in result["dashboards"]] == ["With alert", "Without"]
    assert result["alert_changes"] == []  # both run on OmniKrux's engine: nothing in a tool
    rules = (await http.get(RULES)).json()
    assert sorted(r["name"] for r in rules) == ["Requests high", "Requests high"]


async def test_a_failing_audit_record_ends_the_ones_begun(
    monitoring_app, linked_project, monkeypatch
):
    """The second audit record can't be written: the first ends as failed, nothing is written."""
    http, app = monitoring_app
    shop = linked_project.project_id
    for title in ("A", "B"):
        await create(http, "project", shop, board(title, linked_project.source_id))
    out = (await http.post(f"{API}/export", json={"kind": "project", "id": shop})).json()
    other, _ = await project_with_source(http, "Other", "http://prometheus.example.invalid:9090")
    text = text_input(json.dumps(out["export"]))
    to = target("project", other)
    p = await preview(http, text, to)
    audit = app.state.audit
    real = audit.begin_app
    begun = []

    async def second_fails(entry):
        if entry.action == "dashboard_import":
            begun.append(entry.name)
            if len(begun) == 2:
                raise AuditUnavailable("disk full")
        return await real(entry)

    monkeypatch.setattr(audit, "begin_app", second_fails)
    r = await commit(http, text, chosen(p), target=to)
    assert r.status_code == 503
    monkeypatch.undo()
    [record] = await imports(http)
    assert (record["name"], record["outcome"]) == ("A", "failed")
    owned = (await http.get(DASHBOARDS, params={"owner_kind": "project", "owner_id": other})).json()
    assert owned == []


async def test_body_lists_are_bounded(monitoring_app, linked_project):
    http, _ = monitoring_app
    to = target("project", linked_project.project_id)
    text = text_input(fixture_text("gridpos_v22_inputs"))
    [pick] = chosen(await preview(http, text, to))
    many = [{"key": f"k-{i}", "leave_out": True} for i in range(501)]
    r = await commit(http, text, [pick], target=to, mapping=many)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input"
    r = await commit(http, text, [pick | {"digest": "0" * 65}], target=to)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input"
    r = await commit(http, text, [pick], new_group={"name": "G", "project_ids": ["p"] * 501})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_input"
    assert (await http.get(DASHBOARDS)).json() == []


# --- contact points that change while the user reviews --------------------------------------


def notifying_export(names: list[str]) -> dict:
    alert = {
        "name": "Requests high",
        "query": "A",
        "op": "above",
        "threshold": 5,
        "for": "1m",
        "notify": [{"name": n} for n in names],
    }
    return tool_export(alert)


async def contact_point(http, name: str, url: str) -> dict:
    r = await http.post(
        CONTACT_POINTS, json={"name": name, "type": "webhook", "secrets": {"url": f"{url}/h"}}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_a_contact_point_removed_since_the_preview_is_refused(
    monitoring_app, linked_project, fake_webhook
):
    http, _ = monitoring_app
    cp = await contact_point(http, "Ops hook", fake_webhook.url)
    text = text_input(json.dumps(notifying_export(["Ops hook"])))
    to = target("project", linked_project.project_id)
    p = await preview(http, text, to)
    assert p["dashboards"][0]["skipped"] == []  # the preview says the alert tells Ops hook
    review = (await http.get(f"{CONTACT_POINTS}/{cp['id']}/delete-review")).json()
    removed = await http.delete(f"{CONTACT_POINTS}/{cp['id']}", params={"token": review["token"]})
    assert removed.status_code == 200, removed.text
    r = await commit(http, text, chosen(p), target=to)
    assert refusal(r) == (
        409,
        "changed",
        '"Tool alerts" changed since you checked it. Check again.',
    )
    assert r.json()["detail"]["key"] == "d-1"
    assert (await http.get(DASHBOARDS)).json() == [] and await imports(http) == []
    # Checked again, the preview says the contact point is gone, and that imports.
    again = await preview(http, text, to)
    assert [s["what"] for s in again["dashboards"][0]["skipped"]] == ['Contact point "Ops hook"']
    await committed(http, text, chosen(again), target=to)


async def test_a_contact_point_renamed_since_the_preview_is_refused(
    monitoring_app, linked_project, fake_webhook
):
    http, _ = monitoring_app
    cp = await contact_point(http, "Ops hook", fake_webhook.url)
    text = text_input(json.dumps(notifying_export(["Ops hook"])))
    to = target("project", linked_project.project_id)
    p = await preview(http, text, to)
    renamed = await http.patch(f"{CONTACT_POINTS}/{cp['id']}", json={"name": "Ops pager"})
    assert renamed.status_code == 200, renamed.text
    r = await commit(http, text, chosen(p), target=to)
    assert refusal(r)[:2] == (409, "changed")
    assert (await http.get(DASHBOARDS)).json() == []


async def test_a_contact_point_added_since_the_preview_is_refused(
    monitoring_app, linked_project, fake_webhook
):
    """The preview said "Ops hook" would be left out; one added meanwhile would be used."""
    http, _ = monitoring_app
    text = text_input(json.dumps(notifying_export(["Ops hook"])))
    to = target("project", linked_project.project_id)
    p = await preview(http, text, to)
    assert [s["what"] for s in p["dashboards"][0]["skipped"]] == ['Contact point "Ops hook"']
    await contact_point(http, "Ops hook", fake_webhook.url)
    r = await commit(http, text, chosen(p), target=to)
    assert refusal(r)[:2] == (409, "changed")
    assert (await http.get(DASHBOARDS)).json() == []
