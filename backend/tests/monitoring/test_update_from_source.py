"""Update from source: an imported dashboard re-reads its source (its Grafana, or the file picked
again), the differences are shown with a warning about local edits, and the update is written
as a new version only when neither the source nor the dashboard changed since that review. The
replaced content stays in Versions; panel ids stay stable; each panel alert keeps who it tells
and where it runs, and an alert the source dropped goes through M4's removal review."""

import copy
import json
from dataclasses import replace

from omnikrux.monitoring.alerts.store import ToolObject
from omnikrux.monitoring.transfer import update
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext
from omnikrux.monitoring.transfer.grafana_client import RULES_FAILED
from omnikrux.monitoring.transfer.origins import MappingChoice
from omnikrux.monitoring.transfer.types import SkippedItem, digest
from tests.monitoring.conftest import GRAFANA_TOKEN
from tests.monitoring.test_grafana_alerts import unified
from tests.monitoring.test_import_commit import committed, create
from tests.monitoring.test_import_preview import (
    API,
    DASHBOARDS,
    board,
    chosen,
    grafana_entry,
    grafana_input,
    load,
    preview,
    saved_grafana,
    target,
    text_input,
    with_last_reducer,
)
from tests.monitoring.test_panel_alerts import delete_contact_point
from tests.monitoring.test_rules_api import as_tool, monitoring_records, refusal

RULES = f"{API}/alerts/rules"


def update_preview_url(did: str) -> str:
    return f"{DASHBOARDS}/{did}/update-from-source/preview"


def update_url(did: str) -> str:
    return f"{DASHBOARDS}/{did}/update-from-source"


async def update_preview(http, did: str, body: dict | None = None) -> dict:
    r = await http.post(update_preview_url(did), json=body or {})
    assert r.status_code == 200, r.text
    return r.json()


async def apply(http, did: str, p: dict, **extra):
    body = {"base_version": p["current_version"], "digest": p["digest"], **extra}
    return await http.post(update_url(did), json=body)


async def applied(http, did: str, p: dict, **extra) -> dict:
    r = await apply(http, did, p, **extra)
    assert r.status_code == 200, r.text
    return r.json()


async def versions(http, did: str) -> list[dict]:
    return (await http.get(f"{DASHBOARDS}/{did}/versions")).json()


async def updates(http) -> list[dict]:
    return [r for r in await monitoring_records(http) if r["action"] == "dashboard_update"]


async def dashboard(http, did: str) -> dict:
    return (await http.get(f"{DASHBOARDS}/{did}")).json()


async def save(http, did: str, spec: dict) -> dict:
    current = await dashboard(http, did)
    r = await http.put(
        f"{DASHBOARDS}/{did}", json={"base_version": current["version"], "spec": spec}
    )
    assert r.status_code == 200, r.text
    return r.json()


async def from_grafana(http, fake, project_id: str, raw: dict) -> tuple[str, dict]:
    """(dashboard id, the saved connection): `raw` imported from the fake Grafana as "api-lat"."""
    fake.dashboards = {"api-lat": grafana_entry(raw)}
    g = await saved_grafana(http, fake.url)
    input = grafana_input(["api-lat"], grafana_id=g["id"])
    to = target("project", project_id)
    p = await preview(http, input, to)
    result = await committed(http, input, chosen(p), target=to)
    return result["dashboards"][0]["id"], g


async def from_file(http, project_id: str, raw: dict, name: str = "api.json") -> str:
    text = text_input(json.dumps(raw), name)
    to = target("project", project_id)
    p = await preview(http, text, to)
    return (await committed(http, text, chosen(p), target=to))["dashboards"][0]["id"]


def upstream(raw: dict, version: int, **changes) -> dict:
    """`raw` as Grafana answers it after a change: its first panel's title, the dashboard's
    title, or its first panel's old alert taken away."""
    out = copy.deepcopy(raw)
    out["version"] = version
    if "panel_title" in changes:
        out["panels"][0]["title"] = changes["panel_title"]
    if "title" in changes:
        out["title"] = changes["title"]
    if changes.get("no_alert"):
        out["panels"][0].pop("alert", None)
    if "threshold" in changes:
        out["panels"][0]["alert"]["conditions"][0]["evaluator"]["params"] = [changes["threshold"]]
    return out


# --- a Grafana instance ------------------------------------------------------------------------


async def test_update_from_a_grafana_instance_shows_the_change(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, app = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, g = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(
        upstream(raw, 4, panel_title="p95 latency (all routes)")
    )
    p = await update_preview(http, did)
    assert p["same"] is False and p["source_version"] == 4 and p["previous_source_version"] == 3
    assert p["incoming"]["panels"][0]["title"] == "p95 latency (all routes)"
    assert p["current"]["panels"][0]["title"] == "p95 latency"
    assert (p["current_version"], p["edited_since_import"], p["source_label"]) == (
        1,
        False,
        "Grafana · lab",
    )
    assert (p["identity_warning"], p["title_note"], p["new_sources"]) == (None, None, [])
    assert len(p["digest"]) == 64
    assert await updates(http) == []  # a preview writes nothing

    r = await apply(http, did, p)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 2 and body["alert_changes"] == []
    assert body["spec"]["panels"][0]["title"] == "p95 latency (all routes)"
    newest, first = await versions(http, did)
    assert (newest["origin"], newest["copied_from"]) == ("updated", "Grafana · lab")
    assert first["origin"] == "imported"  # the replaced content stays in Versions
    [record] = await updates(http)
    assert (record["kind"], record["name"], record["outcome"]) == (
        "dashboard",
        "API latency",
        "succeeded",
    )
    assert record["details"] == {
        "from": "Grafana · lab",
        "version": 2,
        "previous_version": 1,
        "skipped": len(p["skipped"]),
    }
    origin = await app.state.monitoring.origins.get(did)
    assert (origin.updated_version, origin.grafana_version, origin.imported_version) == (2, 4, 1)
    # The origin keeps the source's own digest; the review's also covers what it made here.
    converted = convert_grafana(
        upstream(raw, 4, panel_title="p95 latency (all routes)"), GrafanaContext(), key="api-lat"
    )
    assert origin.digest == digest(converted) != p["digest"]
    assert p["digest"][:32] == origin.digest[:32]
    # The re-read went to Grafana with the saved sign-in, which never comes back.
    texts = [json.dumps(p), r.text, (await http.get("/api/audit")).text]
    assert all(GRAFANA_TOKEN not in t for t in texts)
    assert "histogram_quantile" not in texts[2]
    out = (await http.get(f"{DASHBOARDS}/{did}/origin")).json()
    assert out == {
        "kind": "grafana",
        "via": "grafana",
        "label": "Grafana · lab",
        "grafana_id": g["id"],
        "grafana_name": "Grafana · lab",
        "grafana_uid": "api-lat",
        "grafana_version": 4,
        "imported_at": out["imported_at"],
        "imported_version": 1,
        "updated_at": out["updated_at"],
        "updated_version": 2,
        "can_refetch": True,
    }
    assert out["updated_at"] is not None


async def test_a_source_that_changed_after_the_review_is_refused(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, _ = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, panel_title="a"))
    p = await update_preview(http, did)
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 5, panel_title="b"))
    r = await apply(http, did, p)
    assert refusal(r) == (
        409,
        "source_changed",
        "The source changed since you reviewed it. Review it again.",
    )
    assert (await dashboard(http, did))["version"] == 1
    assert await updates(http) == []


async def test_a_save_in_between_is_refused(monitoring_app, linked_project, fake_grafana_auth):
    http, _ = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, panel_title="a"))
    p = await update_preview(http, did)
    spec = (await dashboard(http, did))["spec"]
    await save(http, did, spec | {"description": "Saved in another tab"})
    r = await apply(http, did, p)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert (detail["code"], detail["current_version"]) == ("version_conflict", 2)
    assert detail["message"] == (
        "This dashboard was saved somewhere else since you started (version 2). "
        "Review the differences before saving."
    )
    assert (await dashboard(http, did))["version"] == 2
    assert await updates(http) == []


async def test_local_edits_are_flagged(monitoring_app, linked_project, fake_grafana_auth):
    http, app = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    assert (await update_preview(http, did))["edited_since_import"] is False
    spec = (await dashboard(http, did))["spec"]
    await save(http, did, spec | {"description": "A local note"})
    p = await update_preview(http, did)
    assert p["edited_since_import"] is True and p["same"] is False
    assert p["current"]["description"] == "A local note" and p["incoming"]["description"] == ""
    # Once updated, edits count from the update.
    await applied(http, did, p)
    assert (await update_preview(http, did))["edited_since_import"] is False
    origin = await app.state.monitoring.origins.get(did)
    assert origin.updated_version == 3


async def test_nothing_changed_writes_nothing(monitoring_app, linked_project, fake_grafana_auth):
    http, app = monitoring_app
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    p = await update_preview(http, did)
    assert p["same"] is True and p["incoming"] == p["current"]
    before = await app.state.monitoring.origins.get(did)
    body = await applied(http, did, p)
    assert body["version"] == 1 and body["alert_changes"] == []
    assert len(await versions(http, did)) == 1
    assert await updates(http) == []
    assert await app.state.monitoring.origins.get(did) == before


# --- a file --------------------------------------------------------------------------------------


async def test_file_origin_needs_the_file_and_checks_identity(monitoring_app, linked_project):
    http, app = monitoring_app
    raw = load("gridpos_v22_inputs")
    did = await from_file(http, linked_project.project_id, raw)
    r = await http.post(update_preview_url(did), json={})
    assert refusal(r) == (422, "invalid_input", "Pick the file again, or paste its JSON.")
    out = (await http.get(f"{DASHBOARDS}/{did}/origin")).json()
    assert (out["via"], out["grafana_id"], out["grafana_name"], out["can_refetch"]) == (
        "file",
        None,
        None,
        False,
    )

    newer = upstream(raw, 7, panel_title="p95 latency (all routes)")
    text = text_input(json.dumps(newer), "api-v7.json")
    p = await update_preview(http, did, {"input": text})
    assert (p["identity_warning"], p["source_label"], p["source_version"]) == (
        None,
        "api-v7.json",
        7,
    )
    assert p["previous_source_version"] == 3
    body = await applied(http, did, p, input=text)
    assert body["version"] == 2
    [newest, _] = await versions(http, did)
    assert newest["copied_from"] == "api-v7.json"
    assert (await app.state.monitoring.origins.get(did)).grafana_version == 7

    other = text_input(json.dumps(newer | {"uid": "other-board"}), "other.json")
    p = await update_preview(http, did, {"input": other})
    assert p["identity_warning"] == (
        "This file's dashboard isn't the one \"API latency\" was imported from. "
        "Check that it's the right file."
    )
    # A file that isn't a Grafana dashboard has nothing to update from.
    envelope = (await http.post(f"{API}/export", json={"kind": "dashboard", "id": did})).json()
    wrong = text_input(json.dumps(envelope["export"]), "x.omnikrux.json")
    r = await http.post(update_preview_url(did), json={"input": wrong})
    assert refusal(r) == (
        422,
        "not_importable",
        'This file has no dashboard that matches "API latency".',
    )


async def test_an_omnikrux_export_is_matched_by_its_export_id(
    monitoring_app, two_projects_on_one_source
):
    http, app = monitoring_app
    pair = two_projects_on_one_source
    first = await create(http, "project", pair.a, board("Requests", None))
    await create(http, "project", pair.a, board("Other", None))
    out = (await http.post(f"{API}/export", json={"kind": "dashboard", "id": first["id"]})).json()
    did = await from_file_text(http, pair.b, json.dumps(out["export"]))
    # The original moves on, and its project's export carries it among others.
    await save(http, first["id"], first["spec"] | {"description": "Moved on"})
    project = (await http.post(f"{API}/export", json={"kind": "project", "id": pair.a})).json()
    text = text_input(json.dumps(project["export"]), "team-a.omnikrux.json")
    p = await update_preview(http, did, {"input": text})
    assert p["identity_warning"] is None and p["incoming"]["description"] == "Moved on"
    assert p["source_version"] is None and p["previous_source_version"] is None
    await applied(http, did, p, input=text)
    assert (await dashboard(http, did))["spec"]["description"] == "Moved on"
    # Another dashboard's export: the only dashboard in it, with the warning.
    others = [d for d in (await http.get(DASHBOARDS)).json() if d["title"] == "Other"]
    single = await http.post(f"{API}/export", json={"kind": "dashboard", "id": others[0]["id"]})
    text = text_input(json.dumps(single.json()["export"]), "other.omnikrux.json")
    p = await update_preview(http, did, {"input": text})
    assert p["identity_warning"] == (
        "This file's dashboard isn't the one \"Requests\" was imported from. "
        "Check that it's the right file."
    )
    assert p["incoming"]["title"] == "Requests" and p["title_note"] == (
        'The source\'s title is "Other"; this dashboard keeps its own title.'
    )
    # Several dashboards and none of them this one: nothing to update from.
    await create(http, "project", pair.b, board("Third", None))
    many = (await http.post(f"{API}/export", json={"kind": "project", "id": pair.b})).json()
    many["export"]["dashboards"] = [
        d for d in many["export"]["dashboards"] if d["dashboard"]["title"] != "Requests"
    ] + [single.json()["export"]["dashboards"][0]]
    r = await http.post(
        update_preview_url(did), json={"input": text_input(json.dumps(many["export"]))}
    )
    assert refusal(r) == (
        422,
        "not_importable",
        'This file has no dashboard that matches "Requests".',
    )
    assert (await app.state.monitoring.origins.get(did)).kind == "omnikrux"


async def from_file_text(http, project_id: str, text: str) -> str:
    input = text_input(text, "requests.omnikrux.json")
    to = target("project", project_id)
    p = await preview(http, input, to)
    return (await committed(http, input, chosen(p), target=to))["dashboards"][0]["id"]


async def test_new_sources_are_listed_with_suggestions(monitoring_app, linked_project):
    http, app = monitoring_app
    raw = load("gridpos_v22_inputs")
    did = await from_file(http, linked_project.project_id, raw)
    newer = upstream(raw, 4)
    added = copy.deepcopy(newer["panels"][1])
    added |= {"id": 40, "title": "Second Prometheus"}
    added["datasource"] = {"type": "prometheus", "uid": "prom-2"}
    added["gridPos"] = {"x": 0, "y": 40, "w": 12, "h": 4}
    newer["panels"].append(added)
    text = text_input(json.dumps(newer))
    p = await update_preview(http, did, {"input": text})
    [new] = p["new_sources"]
    assert new["key"] == "grafana:uid:prom-2" and new["type"] == "prometheus"
    assert new["suggestion"] is None and "first" in new["reason"]
    # The new reference is mapped as chosen; the known one keeps its stored choice.
    chosen_source = linked_project.source_id
    mapping = [{"key": "grafana:uid:prom-2", "source_id": chosen_source}]
    p = await update_preview(http, did, {"input": text, "mapping": mapping})
    second = next(x for x in p["incoming"]["panels"] if x["title"] == "Second Prometheus")
    assert second["queries"][0]["source"]["id"] == chosen_source
    await applied(http, did, p, input=text, mapping=mapping)
    origin = await app.state.monitoring.origins.get(did)
    assert origin.mapping["grafana:uid:prom-2"].source_id == chosen_source
    assert origin.mapping["grafana:input:DS_PROM"].source_id is None
    # A source the project doesn't link is refused in words.
    r = await http.post(
        update_preview_url(did),
        json={"input": text, "mapping": [{"key": "grafana:uid:prom-2", "source_id": "nope"}]},
    )
    assert refusal(r)[:2] == (422, "unlinked_source")


async def test_removed_grafana_asks_for_the_file(monitoring_app, linked_project, fake_grafana_auth):
    http, _ = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, g = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    assert (await http.delete(f"{API}/grafana/{g['id']}")).status_code == 204
    r = await http.post(update_preview_url(did), json={})
    assert refusal(r) == (
        409,
        "no_origin",
        (
            "The Grafana this came from was removed. Pick the dashboard's file to update from "
            "it instead."
        ),
    )
    out = (await http.get(f"{DASHBOARDS}/{did}/origin")).json()
    assert (out["via"], out["grafana_id"], out["grafana_name"], out["can_refetch"]) == (
        "grafana",
        None,
        None,
        False,
    )
    # The file still updates it.
    text = text_input(json.dumps(upstream(raw, 4, panel_title="From the file")))
    p = await update_preview(http, did, {"input": text})
    assert p["identity_warning"] is None
    assert (await applied(http, did, p, input=text))["version"] == 2


async def test_grafana_that_cant_be_read_says_why(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, _ = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    fake_grafana_auth.dashboards = {}
    r = await http.post(update_preview_url(did), json={})
    status, code, message = refusal(r)
    assert (status, code) == (404, "grafana")
    assert message == "Grafana · lab has no dashboard with the id api-lat any more."


async def test_the_dashboard_keeps_its_title(monitoring_app, linked_project, fake_grafana_auth):
    http, _ = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    spec = (await dashboard(http, did))["spec"]
    await save(http, did, spec | {"title": "Our API"})
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, title="API v2"))
    p = await update_preview(http, did)
    assert p["incoming"]["title"] == "Our API"
    assert p["title_note"] == 'The source\'s title is "API v2"; this dashboard keeps its own title.'
    assert (await applied(http, did, p))["title"] == "Our API"


# --- refusals -----------------------------------------------------------------------------------


async def test_only_an_imported_dashboard_has_a_source(monitoring_app, linked_project):
    http, _ = monitoring_app
    made = await create(http, "project", linked_project.project_id, board("Mine", None))
    assert (await http.get(f"{DASHBOARDS}/{made['id']}/origin")).json() is None
    for url in (update_preview_url(made["id"]), update_url(made["id"])):
        body = {} if url.endswith("preview") else {"base_version": 1, "digest": "0" * 64}
        r = await http.post(url, json=body)
        assert refusal(r) == (
            404,
            "no_origin",
            "This dashboard wasn't imported, so it has no source to update from.",
        )
    ready = f"ready:{linked_project.project_id}:cluster"
    r = await http.post(update_preview_url(ready), json={})
    assert refusal(r)[:2] == (409, "read_only")
    assert (await http.get(f"{DASHBOARDS}/{ready}/origin")).json() is None
    r = await http.post(update_preview_url("nope"), json={})
    assert refusal(r) == (404, "not_found", "That dashboard no longer exists.")
    assert (await http.get(f"{DASHBOARDS}/nope/origin")).status_code == 404
    r = await http.post(update_preview_url(made["id"]), json={"nope": 1})
    assert refusal(r)[:2] == (422, "invalid_input")


async def test_the_save_and_the_origin_go_together(
    monitoring_app, linked_project, fake_grafana_auth, monkeypatch
):
    http, app = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, panel_title="a"))
    p = await update_preview(http, did)
    before = await app.state.monitoring.origins.get(did)

    async def broken(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(app.state.monitoring.origins, "mark_updated", broken)
    r = await apply(http, did, p)
    assert refusal(r) == (
        500,
        "not_updated",
        "The update couldn't be saved, so nothing changed. Try again.",
    )
    assert "disk full" not in r.text
    assert (await dashboard(http, did))["version"] == 1
    assert len(await versions(http, did)) == 1
    assert await app.state.monitoring.origins.get(did) == before
    [record] = await updates(http)
    assert record["outcome"] == "failed"


# --- panels and alerts --------------------------------------------------------------------------


async def test_panel_ids_stay_with_their_source_panels(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, app = monitoring_app
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    [rule] = (await http.get(RULES)).json()
    assert rule["panel"]["panel_id"] == "p-1"
    # A panel added above every other one upstream comes first in the converted order.
    newer = upstream(raw, 4)
    for panel in newer["panels"]:
        panel["gridPos"] = panel["gridPos"] | {"y": panel["gridPos"]["y"] + 4}
    top = copy.deepcopy(newer["panels"][1]) | {"id": 90, "title": "New on top"}
    top["gridPos"] = {"x": 0, "y": 0, "w": 24, "h": 4}
    newer["panels"].insert(0, top)
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(newer)
    p = await update_preview(http, did)
    ids = {x["title"]: x["id"] for x in p["incoming"]["panels"]}
    assert ids["p95 latency"] == "p-1" and ids["New on top"] == "p-5"
    assert [x["id"] for x in p["current"]["panels"]] == ["p-1", "p-2", "p-3", "p-4"]
    body = await applied(http, did, p)
    assert body["alert_changes"] == []
    [kept] = (await http.get(RULES)).json()
    assert kept["id"] == rule["id"] and kept["panel"]["panel_id"] == "p-1"
    assert kept["origin"] == "panel"
    origin = await app.state.monitoring.origins.get(did)
    assert origin.panels["90"] == "p-5" and origin.panels["2"] == "p-1"


async def test_alert_removed_upstream_shows_in_incoming(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, _ = monitoring_app
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    assert len((await http.get(RULES)).json()) == 1
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, no_alert=True))
    p = await update_preview(http, did)
    assert p["incoming"]["panels"][0]["alert"] is None
    assert p["current"]["panels"][0]["alert"]["name"] == "p95 too slow"
    body = await applied(http, did, p)
    assert body["spec"]["panels"][0]["alert"] is None
    assert (await http.get(RULES)).json() == []
    [record] = await updates(http)
    assert record["details"]["alerts_removed"] == ["p95 too slow"]


async def test_a_panel_gone_with_its_alert_is_listed(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, _ = monitoring_app
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    newer = upstream(raw, 4)
    newer["panels"] = newer["panels"][1:]
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(newer)
    p = await update_preview(http, did)
    assert {
        "where": 'Panel "p95 latency"',
        "what": "Its alert",
        "reason": 'The panel is gone from the source, so its alert "p95 too slow" keeps running '
        "as a rule on the Alerts page.",
    } in p["skipped"]
    await applied(http, did, p)
    [rule] = (await http.get(RULES)).json()
    assert rule["origin"] == "page" and rule["name"] == "p95 too slow"


async def test_update_keeps_alert_routing(
    monitoring_app, linked_project, fake_grafana_auth, fake_webhook
):
    http, _ = monitoring_app
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    cp = await http.post(
        f"{API}/alerts/contact-points",
        json={"name": "Ops hook", "type": "webhook", "secrets": {"url": f"{fake_webhook.url}/h"}},
    )
    assert cp.status_code == 201, cp.text
    spec = (await dashboard(http, did))["spec"]
    alert = spec["panels"][0]["alert"]
    alert |= {"notify": [cp.json()["id"]], "every": "5m", "severity": "critical"}
    await save(http, did, spec)
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, threshold=0.5))
    p = await update_preview(http, did)
    incoming = p["incoming"]["panels"][0]["alert"]
    assert incoming["threshold"] == 0.5
    # Who it tells and how often it is checked stay; the source sets no severity, so it stays.
    assert (incoming["notify"], incoming["every"], incoming["severity"]) == (
        [cp.json()["id"]],
        "5m",
        "critical",
    )
    assert (incoming["engine"], incoming["message"]) == ("omnikrux", "p95 above 300 ms")
    body = await applied(http, did, p)
    assert body["spec"]["panels"][0]["alert"]["notify"] == [cp.json()["id"]]
    [record] = await updates(http)
    assert record["details"]["alerts_changed"] == ["p95 too slow"]


async def test_update_keeps_a_tool_run_alert_and_reviews_its_removal(
    monitoring_app, linked_project, fake_grafana_auth
):
    """The user's decision: an update keeps where a panel alert runs. A tool-run alert the source
    still has stays in the tool (no review); one the source dropped goes through M4's removal
    review."""
    http, app = monitoring_app
    services = app.state.monitoring
    pid = linked_project.project_id
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    did, _ = await from_grafana(http, fake_grafana_auth, pid, raw)
    as_tool(app)  # Shop's Prometheus has the Operator
    spec = (await dashboard(http, did))["spec"]
    spec["panels"][0]["alert"]["engine"] = "tool"
    saved = await save(http, did, spec)
    assert [c["kind"] for c in saved["alert_changes"]] == ["review"]
    [rule] = (await http.get(RULES)).json()
    [tgt] = rule["targets"]
    # M4 applied its PrometheusRule (as its pipeline does once the review is confirmed).
    await services.alerts.set_tool(
        tgt["id"],
        tool_state="in_sync",
        tool_message=None,
        tool_object=ToolObject("prometheus_rule", linked_project.source_id, "c-1", "shop", "r"),
        applied_version=rule["version"],
    )

    # The source changes a panel's title only: the alert stays in the tool, nothing to review.
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, panel_title="p95"))
    p = await update_preview(http, did)
    assert p["incoming"]["panels"][0]["alert"]["engine"] == "tool"
    body = await applied(http, did, p)
    assert body["version"] == 3 and body["alert_changes"] == []
    [same_rule] = (await http.get(RULES)).json()
    assert same_rule["id"] == rule["id"] and same_rule["targets"][0]["tool_state"] == "in_sync"

    # The source drops the alert: its removal from the tool needs the review.
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(
        upstream(raw, 5, panel_title="p95", no_alert=True)
    )
    p = await update_preview(http, did)
    assert p["incoming"]["panels"][0]["alert"] is None
    body = await applied(http, did, p)
    assert body["version"] == 4 and body["spec"]["panels"][0]["alert"] is None
    [change] = body["alert_changes"]
    assert (change["kind"], change["target_id"], change["rule_id"]) == (
        "review",
        tgt["id"],
        rule["id"],
    )
    [left] = (await http.get(RULES)).json()
    [leaving] = left["targets"]
    assert leaving["leaving"] is True and leaving["tool_state"] == "needs_review"


# --- what the review saw -----------------------------------------------------------------------

CHANGED_SINCE = '"Requests" changed since you checked it. Check again.'


async def contact_point(http, name: str, url: str) -> str:
    r = await http.post(
        f"{API}/alerts/contact-points",
        json={"name": name, "type": "webhook", "secrets": {"url": f"{url}/h"}},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def export_text(http, did: str) -> dict:
    out = (await http.post(f"{API}/export", json={"kind": "dashboard", "id": did})).json()
    return text_input(json.dumps(out["export"]), "requests.omnikrux.json")


async def unchanged_after_refusal(http, app, did: str) -> None:
    assert (await dashboard(http, did))["version"] == 1
    assert len(await versions(http, did)) == 1
    assert await updates(http) == []
    assert (await app.state.monitoring.origins.get(did)).updated_version is None


async def test_a_contact_point_changed_since_the_review_is_refused(
    monitoring_app, two_projects_on_one_source, fake_webhook
):
    """An OmniKrux export's new alert names its contact points; renaming or removing one between
    the review and the apply would change who the alert tells, so the apply is refused."""
    http, app = monitoring_app
    pair = two_projects_on_one_source
    cp = await contact_point(http, "Ops hook", fake_webhook.url)
    first = await create(http, "project", pair.a, board("Requests", None))
    did = await from_file_text(http, pair.b, (await export_text(http, first["id"]))["text"])
    alert = {"name": "Requests high", "query": "A", "op": "above", "threshold": 5, "notify": [cp]}
    await save(http, first["id"], board("Requests", None, alert=alert))
    text = await export_text(http, first["id"])

    p = await update_preview(http, did, {"input": text})
    assert p["incoming"]["panels"][0]["alert"]["notify"] == [cp]
    renamed = await http.patch(f"{API}/alerts/contact-points/{cp}", json={"name": "Ops pager"})
    assert renamed.status_code == 200, renamed.text
    r = await apply(http, did, p, input=text)
    assert refusal(r) == (409, "changed", CHANGED_SINCE)
    await unchanged_after_refusal(http, app, did)

    await http.patch(f"{API}/alerts/contact-points/{cp}", json={"name": "Ops hook"})
    p = await update_preview(http, did, {"input": text})
    await delete_contact_point(http, cp)
    r = await apply(http, did, p, input=text)
    assert refusal(r) == (409, "changed", CHANGED_SINCE)
    await unchanged_after_refusal(http, app, did)

    # Reviewed again, it goes through as shown: the alert tells no one.
    p = await update_preview(http, did, {"input": text})
    assert p["incoming"]["panels"][0]["alert"]["notify"] == []
    assert (await applied(http, did, p, input=text))["version"] == 2


def with_second_prometheus(raw: dict) -> dict:
    out = upstream(raw, 4)
    added = copy.deepcopy(out["panels"][1]) | {"id": 40, "title": "Second Prometheus"}
    added["datasource"] = {"type": "prometheus", "uid": "prom-2"}
    added["gridPos"] = {"x": 0, "y": 40, "w": 12, "h": 4}
    out["panels"].append(added)
    return out


async def test_a_suggestion_changed_since_the_review_is_refused(
    monitoring_app, linked_project, fake_prometheus
):
    http, app = monitoring_app
    pid = linked_project.project_id
    raw = load("gridpos_v22_inputs")
    did = await from_file(http, pid, raw)
    text = text_input(json.dumps(with_second_prometheus(raw)))
    p = await update_preview(http, did, {"input": text})
    [new] = p["new_sources"]
    assert new["suggestion"] is None
    # A source with the reference's name is linked meanwhile: the suggestion (and so the panel's
    # source) would change.
    made = await http.post(
        f"{API}/sources",
        json={
            "type": "prometheus",
            "reach": "url",
            "url": fake_prometheus.url,
            "name": new["name"],
        },
    )
    assert made.status_code == 201, made.text
    linked = await http.put(
        f"{API}/projects/{pid}/sources/{made.json()['id']}", json={"filter": ""}
    )
    assert linked.status_code == 200, linked.text
    r = await apply(http, did, p, input=text)
    assert refusal(r)[:2] == (409, "changed")
    assert (await dashboard(http, did))["version"] == 1 and await updates(http) == []
    again = await update_preview(http, did, {"input": text})
    assert again["new_sources"][0]["suggestion"] == made.json()["id"]
    assert again["digest"][:32] == p["digest"][:32] != again["digest"][32:]
    assert again["digest"] != p["digest"]
    assert (await app.state.monitoring.origins.get(did)).updated_version is None


async def test_saved_mapping_choices_changed_since_the_review_are_refused(
    monitoring_app, linked_project
):
    http, app = monitoring_app
    raw = load("gridpos_v22_inputs")
    did = await from_file(http, linked_project.project_id, raw)
    text = text_input(json.dumps(with_second_prometheus(raw)))
    mapping = [{"key": "grafana:uid:prom-2", "source_id": linked_project.source_id}]
    p = await update_preview(http, did, {"input": text, "mapping": mapping})
    await applied(http, did, p, input=text, mapping=mapping)
    # The stored choice is what a preview without a mapping uses now.
    newer = with_second_prometheus(raw) | {"description": "Newer"}
    text = text_input(json.dumps(newer))
    p = await update_preview(http, did, {"input": text})
    second = next(x for x in p["incoming"]["panels"] if x["title"] == "Second Prometheus")
    assert second["queries"][0]["source"]["id"] == linked_project.source_id
    # The stored choices change before the apply (another update chose otherwise).
    origins = app.state.monitoring.origins
    origin = await origins.get(did)
    changed = origin.mapping | {"grafana:uid:prom-2": MappingChoice(None)}
    await origins.record(replace(origin, mapping=changed))
    r = await apply(http, did, p, input=text)
    assert refusal(r) == (
        409,
        "changed",
        '"API latency" changed since you checked it. Check again.',
    )
    assert (await dashboard(http, did))["version"] == 2
    assert len(await updates(http)) == 1


# --- panels added here, and alert settings that no longer fit -----------------------------------


async def test_panels_added_here_are_named_as_local(
    monitoring_app, linked_project, fake_grafana_auth
):
    http, _ = monitoring_app
    raw = load("gridpos_v22_inputs")
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    spec = (await dashboard(http, did))["spec"]
    local = copy.deepcopy(spec["panels"][1]) | {"id": "p-9", "title": "Mine"}
    local["layout"] = local["layout"] | {"y": 60}
    with_alert = copy.deepcopy(local) | {"id": "p-10", "title": "Mine too"}
    with_alert["layout"] = with_alert["layout"] | {"y": 70}
    with_alert["alert"] = {"name": "Mine high", "query": "A", "op": "above", "threshold": 5}
    await save(http, did, spec | {"panels": [*spec["panels"], local, with_alert]})
    p = await update_preview(http, did)
    assert {
        "where": 'Panel "Mine"',
        "what": "The whole panel",
        "reason": "It was added here and isn't in the source, so the update leaves it out.",
    } in p["skipped"]
    assert {
        "where": 'Panel "Mine too"',
        "what": "The whole panel",
        "reason": "It was added here and isn't in the source, so the update leaves it out; its "
        'alert "Mine high" keeps running as a rule on the Alerts page.',
    } in p["skipped"]
    assert not any("gone from the source" in s["reason"] for s in p["skipped"])


def _alert_panel(alert: dict | None, *, id: str = "p-1", x: int = 0) -> dict:
    return {
        "id": id,
        "type": "timeseries",
        "title": "Requests",
        "layout": {"x": x, "y": 0, "w": 12, "h": 6},
        "queries": [
            {"ref": "A", "source": {"type": "prometheus", "id": None}, "expr": "rate(x[5m])"}
        ],
        "alert": alert,
    }


INCOMING = {
    "name": "Requests high",
    "query": "A",
    "of": "each",
    "op": "above",
    "threshold": 5,
    "for": "5m",
    "every": "1m",
    "severity": "warning",
    "message": "",
    "notify": [],
    "engine": "omnikrux",
    "channel": None,
}


def test_kept_settings_that_no_longer_fit_take_the_source_alert():
    """The settings kept here are refused by M4's check with the source's new alert: the source's
    alert is taken as it is, said in words that fit where it came from."""
    current = {"panels": [_alert_panel(INCOMING | {"notify": ["not a valid id!"]})]}
    for incoming, words in (
        (INCOMING, update.ROUTING_RESET),
        (INCOMING | {"notify": ["cp-1"]}, update.ROUTING_FROM_FILE),
    ):
        doc = {"panels": [_alert_panel(incoming)]}
        out, items = update._merge_alerts(doc, current, {}, [])
        assert out["panels"][0]["alert"] == incoming
        assert items == [SkippedItem('Alert "Requests high"', "The rule", words)]
    assert "tells no one" in update.ROUTING_RESET
    assert "tells the contact points the file names" in update.ROUTING_FROM_FILE


def test_runs_in_the_tool_items_are_matched_by_panel_id():
    """Two panels with one title: only the item of the panel whose alert stays in the tool goes."""
    tool = INCOMING | {"engine": "tool"}
    current = {"panels": [_alert_panel(tool), _alert_panel(None, id="p-2", x=12)]}
    doc = {"panels": [_alert_panel(INCOMING), _alert_panel(INCOMING, id="p-2", x=12)]}
    where = 'Alert on panel "Requests"'
    items = [
        SkippedItem(where, "Runs in the tool", "first"),
        SkippedItem(where, "Runs in the tool", "second"),
    ]
    out, kept = update._merge_alerts(doc, current, {}, items, ["p-1", "p-2"])
    assert out["panels"][0]["alert"]["engine"] == "tool"
    assert out["panels"][1]["alert"]["engine"] == "omnikrux"
    assert kept == [items[1]]


# --- Grafana's alert rules not read on an update (review M1) -------------------------------------

REQUESTS_EXPR = 'sum(rate(http_requests_total{job="$job"}[5m]))'
KEPT = "Grafana's alert rules weren't read, so the alert here is kept as it is."


def without_legacy_alert(raw: dict) -> dict:
    out = copy.deepcopy(raw)
    out["panels"][0].pop("alert", None)
    return out


async def from_grafana_with_a_rule(http, fake, project_id: str) -> tuple[str, dict, dict]:
    """(dashboard id, the saved connection, the raw dashboard): the v22 fixture imported with one
    Grafana-managed rule, "Too many requests", on its "Requests per second" panel."""
    rule = unified(
        "Too many requests", panel="3", expr=REQUESTS_EXPR, value=100.0, dashboard="api-lat"
    )
    fake.ruler = {"Folder": [{"name": "g", "rules": [rule]}]}
    raw = without_legacy_alert(load("gridpos_v22_inputs"))
    did, g = await from_grafana(http, fake, project_id, raw)
    return did, g, raw


def requests_alert(doc: dict) -> dict | None:
    return next(p for p in doc["panels"] if p["title"] == "Requests per second")["alert"]


async def test_an_update_from_the_file_keeps_alerts_from_rules_it_cant_see(
    monitoring_app, linked_project, fake_grafana_auth
):
    """A dashboard imported from a Grafana, whose connection is gone, updated from its file: the
    file holds no Grafana alert rules, so the panel keeps its alert and the review says so."""
    http, _ = monitoring_app
    did, g, raw = await from_grafana_with_a_rule(http, fake_grafana_auth, linked_project.project_id)
    before = (await dashboard(http, did))["spec"]
    alert = requests_alert(before)
    assert alert is not None and alert["name"] == "Too many requests"
    [rule] = (await http.get(RULES)).json()
    assert (await http.delete(f"{API}/grafana/{g['id']}")).status_code == 204

    text = text_input(json.dumps(upstream(raw, 4, panel_title="From the file")))
    p = await update_preview(http, did, {"input": text})
    assert requests_alert(p["incoming"]) == alert
    assert {"where": 'Alert "Too many requests"', "what": "The rule", "reason": KEPT} in p[
        "skipped"
    ]
    body = await applied(http, did, p, input=text)
    assert body["version"] == 2 and body["alert_changes"] == []
    assert body["spec"]["panels"][0]["title"] == "From the file"
    assert requests_alert(body["spec"]) == alert
    [kept] = (await http.get(RULES)).json()
    assert (kept["id"], kept["origin"]) == (rule["id"], "panel")
    [record] = await updates(http)
    assert "alerts_removed" not in record["details"]


async def test_an_update_whose_rules_read_failed_keeps_the_alerts(
    monitoring_app, linked_project, fake_grafana_auth
):
    """Grafana answers the dashboard but not its alert rules: the panel keeps its alert, the
    review says why, and once the rules are read again a rule gone upstream does go."""
    http, _ = monitoring_app
    did, _, raw = await from_grafana_with_a_rule(http, fake_grafana_auth, linked_project.project_id)
    alert = requests_alert((await dashboard(http, did))["spec"])
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(upstream(raw, 4, panel_title="New"))
    fake_grafana_auth.ruler_status = 500
    p = await update_preview(http, did)
    assert requests_alert(p["incoming"]) == alert
    reasons = [(s["where"], s["what"], s["reason"]) for s in p["skipped"]]
    assert ('Alert "Too many requests"', "The rule", KEPT) in reasons
    assert (
        "Dashboard",
        "Grafana alert rules",
        RULES_FAILED.format(name="Grafana · lab"),
    ) in reasons
    body = await applied(http, did, p)
    assert requests_alert(body["spec"]) == alert and body["alert_changes"] == []
    assert len((await http.get(RULES)).json()) == 1

    # Read again, with the rule gone upstream: now the source is known to have no alert.
    fake_grafana_auth.ruler_status = 200
    fake_grafana_auth.ruler = {}
    p = await update_preview(http, did)
    assert requests_alert(p["incoming"]) is None
    assert not any(s["reason"] == KEPT for s in p["skipped"])


def test_an_unread_alert_that_no_longer_fits_its_panel_is_said_to_go():
    current = {"panels": [_alert_panel(INCOMING)]}
    panel = _alert_panel(None)
    panel["queries"][0]["ref"] = "B"
    out, items = update._keep_unread_alerts({"panels": [panel]}, current)
    assert out["panels"][0]["alert"] is None
    assert items == [
        SkippedItem('Alert "Requests high"', "The rule", update.RULES_NOT_READ_DROPPED)
    ]
    # A panel that comes in with its own alert keeps that one; a new panel takes nothing.
    other = INCOMING | {"name": "From the source"}
    doc = {"panels": [_alert_panel(other), _alert_panel(None, id="p-2", x=12)]}
    out, items = update._keep_unread_alerts(doc, current)
    assert [p["alert"] for p in out["panels"]] == [other, None] and items == []


async def test_update_with_no_new_version_says_so(
    monitoring_app, linked_project, fake_grafana_auth
):
    """A Grafana still at the version this dashboard took has nothing new, even when the
    dashboard was edited here (so it isn't `same`)."""
    http, _ = monitoring_app
    raw = with_last_reducer(load("gridpos_v22_inputs"))
    did, _ = await from_grafana(http, fake_grafana_auth, linked_project.project_id, raw)
    p = await update_preview(http, did)
    assert p["no_new_version"] is True
    assert p["source_version"] == p["previous_source_version"] == raw["version"]
    fake_grafana_auth.dashboards["api-lat"] = grafana_entry(
        upstream(raw, raw["version"] + 1, panel_title="Renamed")
    )
    changed = await update_preview(http, did)
    assert changed["no_new_version"] is False
