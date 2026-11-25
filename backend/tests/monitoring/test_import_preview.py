"""The import preview: what an import of a file, pasted text or a Grafana's dashboards would do,
with what it skips, its alerts, a digest of what was shown and a source suggested for each
reference. Nothing is stored and nothing is audited."""

import copy
import json
from datetime import UTC, datetime
from pathlib import Path

from omnikrux.monitoring.sources.types import ClusterTarget, SourceConfig, SourceSecrets
from omnikrux.monitoring.transfer.grafana_client import NO_DASHBOARD
from omnikrux.monitoring.transfer.mapping import (
    FIRST_OF_TYPE,
    GROUP_TARGET,
    LEFT_OUT,
    NO_TARGET,
    NONE_OF_TYPE,
    SAME_ADDRESS,
    SAME_NAME,
    SAME_SERVICE,
    SAME_SOURCE,
    Target,
    suggest,
)
from omnikrux.monitoring.transfer.types import ExportedCluster, SourceRefFound
from tests.monitoring.conftest import GRAFANA_TOKEN
from tests.monitoring.test_rules_api import monitoring_records, refusal

API = "/api/monitoring"
PREVIEW = f"{API}/import/preview"
COMMIT = f"{API}/import/commit"
DASHBOARDS = f"{API}/dashboards"
FIXTURES = Path(__file__).parent / "grafana_fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text("utf-8"))


def fixture_text(name: str) -> str:
    return (FIXTURES / f"{name}.json").read_text("utf-8")


def text_input(text: str, file_name: str | None = "api.json", via: str = "file") -> dict:
    body = {"kind": "text", "text": text, "via": via}
    if file_name is not None:
        body["file_name"] = file_name
    return body


def grafana_input(uids: list[str], *, grafana_id=None, connection=None) -> dict:
    body: dict = {"kind": "grafana", "uids": uids}
    if grafana_id is not None:
        body["grafana_id"] = grafana_id
    if connection is not None:
        body["connection"] = connection
    return body


def target(kind: str, id: str) -> dict:
    return {"kind": kind, "id": id}


async def preview(http, input: dict, to: dict | None = None) -> dict:
    body: dict = {"input": input}
    if to is not None:
        body["target"] = to
    r = await http.post(PREVIEW, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def chosen(p: dict) -> list[dict]:
    """Every importable dashboard of a preview, under its suggested title."""
    return [
        {"key": d["key"], "title": d["suggested_title"], "digest": d["digest"]}
        for d in p["dashboards"]
        if d["importable"]
    ]


def with_last_reducer(raw: dict) -> dict:
    """The v22 fixture with its old panel alert reducing to the last value (OmniKrux can run it)."""
    out = copy.deepcopy(raw)
    out["panels"][0]["alert"]["conditions"][0]["reducer"]["type"] = "last"
    return out


def grafana_entry(raw: dict, *, folder: str | None = None) -> dict:
    meta: dict = {"type": "db", "version": raw.get("version")}
    if folder is not None:
        meta |= {"folderUid": f"f-{folder.lower()}", "folderTitle": folder}
    return {"dashboard": raw, "meta": meta}


async def saved_grafana(http, url: str, name: str = "Grafana · lab") -> dict:
    r = await http.post(
        f"{API}/grafana",
        json={
            "name": name,
            "reach": "url",
            "url": url,
            "auth": {"type": "bearer", "token": GRAFANA_TOKEN},
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def board(title: str, source_id: str | None, *, alert=None, kind: str = "prometheus") -> dict:
    expr = '{app="api"}' if kind == "loki" else "rate(http_requests_total[5m])"
    return {
        "schemaVersion": 1,
        "title": title,
        "panels": [
            {
                "id": "p-1",
                "type": "logs" if kind == "loki" else "timeseries",
                "title": "Requests",
                "layout": {"x": 0, "y": 0, "w": 12, "h": 6},
                "queries": [{"ref": "A", "source": {"type": kind, "id": source_id}, "expr": expr}],
                "alert": alert,
            }
        ],
    }


# --- previews over the API ---------------------------------------------------------------------


async def test_preview_a_grafana_file_lists_skipped_and_suggests_sources(
    monitoring_app, linked_project
):
    http, _ = monitoring_app
    pid = linked_project.project_id
    before = await monitoring_records(http)
    p = await preview(http, text_input(fixture_text("gridpos_v22_inputs")), target("project", pid))
    assert p["format"] == "grafana" and p["format_label"] == "Grafana dashboard"
    assert p["target_kinds"] == ["project", "group"]
    assert p["suggested_target"] == {"kind": "project", "id": pid}
    assert p["bundle"] is None
    assert p["sources"] == [
        {
            "key": "grafana:input:DS_PROM",
            "type": "prometheus",
            "type_guessed": False,
            "name": "Prometheus",
            "detail": None,
            "suggestion": None,
            "leave_out": False,
            "reason": "Uses Shop's first Prometheus-compatible source (Shop).",
        }
    ]
    [d] = p["dashboards"]
    assert (d["key"], d["title"], d["panels"], d["importable"]) == ("d-1", "API latency", 4, True)
    assert (d["suggested_title"], d["title_taken"], d["problems"]) == ("API latency", False, [])
    assert len(d["digest"]) == 64
    assert {
        "where": "Dashboard",
        "what": "Tags",
        "reason": "OmniKrux dashboards have no tags.",
    } in d["skipped"]
    assert p["skipped_total"] == sum(len(x["skipped"]) for x in p["dashboards"])
    # Nothing stored, nothing audited.
    assert (await http.get(DASHBOARDS)).json() == []
    assert await monitoring_records(http) == before


async def test_preview_runs_each_grafana_alert_through_the_alert_adapter(monitoring_app):
    """The preview shows exactly what the commit will do with each alert (preview == commit)."""
    http, _ = monitoring_app
    avg = (await preview(http, text_input(fixture_text("gridpos_v22_inputs"))))["dashboards"][0]
    assert avg["alerts"] == 0
    assert {
        "where": 'Alert "p95 too slow"',
        "what": "The rule",
        "reason": "It uses mean over the values; OmniKrux alerts check the latest value.",
    } in avg["skipped"]
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    last = (await preview(http, text_input(json.dumps(raw))))["dashboards"][0]
    assert last["alerts"] == 1
    assert all(
        s["where"] != 'Alert "p95 too slow"' or s["what"] != "The rule" for s in last["skipped"]
    )
    assert last["digest"] != avg["digest"]


async def test_preview_reasons_without_a_target_or_for_a_group(monitoring_app, linked_project):
    http, _ = monitoring_app
    group = await http.post(
        f"{API}/groups", json={"name": "Everything", "project_ids": [linked_project.project_id]}
    )
    gid = group.json()["id"]
    text = text_input(fixture_text("gridpos_v22_inputs"))
    nowhere = await preview(http, text)
    assert nowhere["sources"][0]["reason"] == NO_TARGET
    assert nowhere["suggested_target"] is None
    into_group = await preview(http, text, target("group", gid))
    assert into_group["sources"][0]["reason"] == GROUP_TARGET
    assert into_group["sources"][0]["suggestion"] is None


async def test_an_unknown_target_is_said_plainly(monitoring_app):
    http, _ = monitoring_app
    r = await http.post(
        PREVIEW,
        json={
            "input": text_input(fixture_text("gridpos_v22_inputs")),
            "target": target("project", "nope"),
        },
    )
    assert refusal(r) == (
        404,
        "not_found",
        "That project or group no longer exists. Pick another.",
    )


async def test_a_project_export_previews_its_bundle(monitoring_app, linked_project_with_loki):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    for spec in (board("Shop", shop.source_id), board("Logs", shop.loki_source_id, kind="loki")):
        r = await http.post(
            DASHBOARDS, json={"owner_kind": "project", "owner_id": shop.project_id, "spec": spec}
        )
        assert r.status_code == 201, r.text
    out = (await http.post(f"{API}/export", json={"kind": "project", "id": shop.project_id})).json()
    p = await preview(http, text_input(json.dumps(out["export"]), "shop-project.omnikrux.json"))
    assert p["format"] == "omnikrux_project"
    assert p["format_label"] == "OmniKrux project export: Shop · 2 dashboards"
    assert p["target_kinds"] == ["project"]
    # No target given: the project with the export's owner name is suggested.
    assert p["suggested_target"] == {"kind": "project", "id": shop.project_id}
    bundle = p["bundle"]
    assert (bundle["kind"], bundle["name"], bundle["project_kind"], bundle["projects"]) == (
        "project",
        "Shop",
        "custom",
        [],
    )
    assert [(s["key"], s["type"], s["filter"], s["auth"]) for s in bundle["sources"]] == [
        ("src-1", "prometheus", 'cluster="a"', "none"),
        ("src-2", "loki", 'cluster="a"', "none"),
    ]
    into = await preview(
        http, text_input(json.dumps(out["export"])), target("project", shop.project_id)
    )
    # In first-use order: the export lists "Logs" (src-2) before "Shop" (src-1).
    assert [(s["key"], s["suggestion"], s["reason"]) for s in into["sources"]] == [
        ("src-2", shop.loki_source_id, SAME_ADDRESS),
        ("src-1", shop.source_id, SAME_ADDRESS),
    ]
    titles = {d["title"]: (d["suggested_title"], d["title_taken"]) for d in into["dashboards"]}
    assert titles == {"Logs": ("Logs (2)", True), "Shop": ("Shop (2)", True)}


async def test_a_group_export_goes_only_into_a_group(monitoring_app, linked_project):
    http, _ = monitoring_app
    group = await http.post(
        f"{API}/groups", json={"name": "All", "project_ids": [linked_project.project_id]}
    )
    gid = group.json()["id"]
    r = await http.post(
        DASHBOARDS, json={"owner_kind": "group", "owner_id": gid, "spec": board("Fleet", None)}
    )
    assert r.status_code == 201, r.text
    out = (await http.post(f"{API}/export", json={"kind": "group", "id": gid})).json()
    p = await preview(
        http,
        text_input(json.dumps(out["export"])),
        target("project", linked_project.project_id),
    )
    assert p["format"] == "omnikrux_group"
    assert p["format_label"] == "OmniKrux group export: All · 1 dashboard"
    assert p["target_kinds"] == ["group"]
    # The project given doesn't take a group export: the group of that name is suggested.
    assert p["suggested_target"] == {"kind": "group", "id": gid}
    assert p["bundle"]["projects"] == ["Shop"]


async def test_a_bare_document_names_the_sources_it_reads(monitoring_app, linked_project):
    http, _ = monitoring_app
    p = await preview(
        http,
        text_input(json.dumps(board("Copied", linked_project.source_id)), None, "paste"),
        target("project", linked_project.project_id),
    )
    assert (p["format"], p["format_label"]) == ("omnikrux_dashboard", "OmniKrux dashboard")
    [ref] = p["sources"]
    assert ref["key"] == f"id:{linked_project.source_id}"
    assert (ref["name"], ref["suggestion"], ref["reason"]) == (
        "Shop",
        linked_project.source_id,
        SAME_SOURCE,
    )
    assert ref["detail"] is not None and ref["detail"].startswith("http://")


async def test_grafana_dashboards_get_titles_unique_within_the_batch(
    monitoring_app, fake_grafana_auth
):
    http, _ = monitoring_app
    one = load("gridpos_v39_objects") | {"uid": "a", "title": "Overview"}
    two = load("gridpos_v39_objects") | {"uid": "b", "title": "Overview"}
    fake_grafana_auth.dashboards = {"a": grafana_entry(one), "b": grafana_entry(two)}
    g = await saved_grafana(http, fake_grafana_auth.url)
    p = await preview(http, grafana_input(["a", "b"], grafana_id=g["id"]))
    assert [(d["key"], d["suggested_title"], d["title_taken"]) for d in p["dashboards"]] == [
        ("a", "Overview", False),
        ("b", "Overview (2)", True),
    ]


async def test_a_grafana_instance_is_read_once_for_its_data_sources(
    monitoring_app, fake_grafana_auth
):
    http, _ = monitoring_app
    fake_grafana_auth.dashboards = {
        "api-lat": grafana_entry(load("gridpos_v22_inputs")),
        "cl-ov": grafana_entry(load("gridpos_v39_objects")),
    }
    g = await saved_grafana(http, fake_grafana_auth.url)
    p = await preview(http, grafana_input(["api-lat", "cl-ov"], grafana_id=g["id"]))
    assert (p["format"], p["format_label"]) == (
        "grafana_instance",
        "2 Grafana dashboards from Grafana · lab",
    )
    paths = [r.path for r in fake_grafana_auth.requests]
    assert paths.count("/api/datasources") == 1
    assert all(
        r.headers.get("Authorization") == f"Bearer {GRAFANA_TOKEN}"
        for r in fake_grafana_auth.requests
        if r.path.startswith("/api/dashboards/")
    )
    single = await preview(http, grafana_input(["cl-ov"], grafana_id=g["id"]))
    assert single["format_label"] == "Grafana dashboard from Grafana · lab"


async def test_one_missing_uid_is_listed_not_fatal(monitoring_app, fake_grafana_auth):
    http, _ = monitoring_app
    fake_grafana_auth.dashboards = {"api-lat": grafana_entry(load("gridpos_v22_inputs"))}
    fake_grafana_auth.dashboard_status = {"v2": 406}
    g = await saved_grafana(http, fake_grafana_auth.url)
    p = await preview(http, grafana_input(["api-lat", "gone", "v2"], grafana_id=g["id"]))
    entries = {d["key"]: d for d in p["dashboards"]}
    assert entries["api-lat"]["importable"] is True
    assert entries["gone"]["importable"] is False
    assert entries["gone"]["problems"] == [
        {"path": "", "message": NO_DASHBOARD.format(name="Grafana · lab", uid="gone")}
    ]
    assert entries["v2"]["importable"] is False
    assert "(HTTP 406)" in entries["v2"]["problems"][0]["message"]


async def test_a_removed_grafana_connection_is_said_plainly(monitoring_app):
    http, _ = monitoring_app
    r = await http.post(PREVIEW, json={"input": grafana_input(["x"], grafana_id="nope")})
    assert refusal(r) == (404, "not_found", "That Grafana connection no longer exists.")
    both = await http.post(PREVIEW, json={"input": grafana_input(["x"])})
    assert refusal(both) == (
        422,
        "invalid_input",
        "Choose one Grafana: a saved connection or a new one.",
    )


async def test_text_that_cant_be_read_is_refused_in_words(monitoring_app):
    http, _ = monitoring_app
    bad = await http.post(PREVIEW, json={"input": text_input("{nope", via="paste")})
    status, code, message = refusal(bad)
    assert (status, code) == (422, "invalid_input") and message.startswith("This isn't valid JSON")
    big = await http.post(PREVIEW, json={"input": text_input(" " * (10 * 1024 * 1024 + 1))})
    assert refusal(big) == (
        413,
        "too_large",
        "This is larger than 10 MB. Export fewer dashboards at a time.",
    )
    shape = await http.post(PREVIEW, json={"input": {"kind": "text"}})
    assert shape.status_code == 422 and shape.json()["detail"]["code"] == "invalid_input"


async def test_import_routes_refuse_cross_origin(monitoring_app):
    http, _ = monitoring_app
    evil = {"Origin": "https://evil.example.invalid"}
    body = {"input": text_input(fixture_text("gridpos_v22_inputs"))}
    for path in (PREVIEW, COMMIT):
        r = await http.post(path, json=body, headers=evil)
        assert r.status_code == 403
        assert r.json() == {"detail": "Cross-origin request refused"}


# --- suggestions -------------------------------------------------------------------------------


def config(id: str, name: str, *, type="prometheus", url=None, cluster=None, prefix=""):
    moment = datetime(2026, 11, 1, tzinfo=UTC)
    return SourceConfig(
        id=id,
        name=name,
        type=type,
        reach="cluster" if cluster else "url",
        url=url,
        cluster=cluster,
        path_prefix=prefix,
        auth_type="none",
        username=None,
        header_name=None,
        client_cert_pem=None,
        ca_pem=None,
        header_names=(),
        secrets=SourceSecrets(),
        created_by_project_id=None,
        created_at=moment,
        updated_at=moment,
        check=None,
    )


def ref(key: str, name: str = "Prom", *, url=None, cluster=None, prefix="", type="prometheus"):
    return SourceRefFound(key, type, False, name, url, cluster, prefix)


def test_suggestions_follow_their_order():
    service = ClusterTarget("c1", "monitoring", "prometheus", "9090", "http")
    sources = [
        config("s-loki", "Logs", type="loki", url="http://loki:3100"),
        config("s-1", "Main", url="http://prom:9090/", prefix="/api"),
        config("s-2", "In cluster", cluster=service),
        config("s-3", "Prom"),
    ]
    shop = Target("project", "p", "Shop", ("s-loki", "s-1", "s-2", "s-3"))
    clusters = {"c1": "lab"}

    def pick(r):
        out = suggest(r, shop, sources, clusters)
        return out.suggestion, out.reason

    assert pick(ref("id:s-2", "x")) == ("s-2", SAME_SOURCE)
    assert pick(ref("src-1", "x", url="http://prom:9090", prefix="api/")) == ("s-1", SAME_ADDRESS)
    in_lab = ExportedCluster("lab", "monitoring", "prometheus", "9090", "http")
    assert pick(ref("src-1", "x", cluster=in_lab)) == ("s-2", SAME_SERVICE)
    unknown_cluster = ExportedCluster(None, "monitoring", "prometheus", "9090", "http")
    assert pick(ref("src-1", "PROM", cluster=unknown_cluster)) == ("s-3", SAME_NAME)
    assert pick(ref("src-1", "other")) == (
        None,
        FIRST_OF_TYPE.format(project="Shop", type="Prometheus-compatible", name="Main"),
    )
    only_prom = Target("project", "p", "Shop", ("s-1",))
    assert suggest(ref("src-1", "x", type="loki"), only_prom, sources, clusters).reason == (
        NONE_OF_TYPE.format(project="Shop", type="Loki")
    )
    assert NONE_OF_TYPE.format(project="Shop", type="Loki") == (
        "Shop has no Loki source yet; its panels say so until you link one."
    )
    # A source the project doesn't link is never suggested, even the same one.
    not_linked = Target("project", "p", "Shop", ("s-3",))
    assert suggest(ref("id:s-2", "x"), not_linked, sources, clusters).suggestion is None


async def test_a_left_out_source_shows_in_the_preview(monitoring_app, linked_project_with_loki):
    """The review's "Leave its panels out" is previewed: the panel count and the skipped list say
    what the import will now do (naming each panel it drops), and the digest stays the one of
    the dashboard as converted, which the commit checks."""
    http, _ = monitoring_app
    to = target("project", linked_project_with_loki.project_id)
    text = text_input(fixture_text("gridpos_v39_objects"))
    before = await preview(http, text, to)
    [loki] = [s for s in before["sources"] if s["type"] == "loki"]
    after = (
        await http.post(
            PREVIEW,
            json={
                "input": text,
                "target": to,
                "mapping": [
                    {"key": loki["key"], "leave_out": True},
                    {"key": "not-in-the-file", "source_id": "anything"},
                ],
            },
        )
    ).json()
    was, now = before["dashboards"][0], after["dashboards"][0]
    assert now["panels"] < was["panels"]
    gone = [s for s in now["skipped"] if s not in was["skipped"]]
    assert gone and all(s["reason"] == LEFT_OUT.format(name=loki["name"]) for s in gone)
    assert any(s["what"] == "The whole panel" and s["where"].startswith("Panel ") for s in gone)
    assert after["skipped_total"] == before["skipped_total"] + len(gone)
    assert now["digest"] == was["digest"]
    assert after["sources"] == before["sources"]
