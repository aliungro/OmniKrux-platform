"""The audited dashboard write path (`dashboards/writes.py`): the M2 routes answer through it
exactly as before, it returns what the panels' alerts did in their tools, and it records an
import's origin and its own audit action and details."""

import pytest
from fastapi import HTTPException, Request

from omnikrux.monitoring.alerts.store import ToolObject
from omnikrux.monitoring.dashboards.writes import (
    create_dashboard_audited,
    save_dashboard_audited,
)
from tests.monitoring.test_panel_alerts import ALERT, board, panel
from tests.monitoring.test_rules_api import as_tool, monitoring_records

API = "/api/monitoring"
DASHBOARDS = f"{API}/dashboards"
CONFLICT = (
    "This dashboard was saved somewhere else since you started (version 2). "
    "Review the differences before saving."
)


def request_for(app) -> Request:
    """A request as a route would get it, for calling the write path directly."""
    return Request({"type": "http", "app": app, "method": "POST", "path": "/", "headers": []})


def without_times(d: dict) -> dict:
    return {k: v for k, v in d.items() if k not in ("id", "created_at", "updated_at")}


async def test_m2_write_routes_answer_as_before(monitoring_app, linked_project):
    http, app = monitoring_app
    pid, name = linked_project.project_id, linked_project.project_name

    # Create
    r = await http.post(
        DASHBOARDS, json={"owner_kind": "project", "owner_id": pid, "spec": board()}
    )
    assert r.status_code == 201, r.text
    made = r.json()
    assert without_times(made) == {
        "owner_kind": "project",
        "owner_id": pid,
        "owner_name": name,
        "title": "Latency",
        "version": 1,
        "spec": made["spec"],
        "ready_made": False,
        "alert_changes": [],
    }
    assert made["spec"]["panels"][0]["alert"] is None

    # Save
    r = await http.put(
        f"{DASHBOARDS}/{made['id']}",
        json={"base_version": 1, "spec": board(panel(), panel("p-2", "Errors", x=6))},
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2 and r.json()["owner_name"] == name

    # Conflict: nothing changes
    r = await http.put(f"{DASHBOARDS}/{made['id']}", json={"base_version": 1, "spec": board()})
    assert r.status_code == 409
    assert r.json()["detail"] == {
        "code": "version_conflict",
        "message": CONFLICT,
        "current_version": 2,
    }

    # Invalid
    r = await http.put(
        f"{DASHBOARDS}/{made['id']}", json={"base_version": 2, "spec": {"schemaVersion": 1}}
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_dashboard" and detail["problems"]

    # Copy
    r = await http.post(
        f"{DASHBOARDS}/copy",
        json={"from_id": made["id"], "owner_kind": "project", "owner_id": pid},
    )
    assert r.status_code == 201, r.text
    assert r.json()["title"] == "Latency (copy)" and r.json()["alert_changes"] == []
    versions = (await http.get(f"{DASHBOARDS}/{r.json()['id']}/versions")).json()
    assert [(v["origin"], v["copied_from"]) for v in versions] == [("copied", "Latency")]

    # A save adding a panel alert that runs in the tool still answers M4's alert changes
    as_tool(app)
    spec = board(panel(alert=ALERT | {"engine": "tool"}))
    r = await http.put(f"{DASHBOARDS}/{made['id']}", json={"base_version": 2, "spec": spec})
    assert r.status_code == 200, r.text
    [rule] = (await http.get(f"{API}/alerts/rules")).json()
    [target] = rule["targets"]
    assert r.json()["alert_changes"] == [
        {
            "target_id": target["id"],
            "rule_id": rule["id"],
            "rule_name": "API latency high",
            "project_id": pid,
            "project_name": name,
            "kind": "review",
            "message": None,
            "tool": "prometheus_rule",
        }
    ]

    records = [
        (r["action"], r["outcome"], r["name"], r["details"]) for r in await monitoring_records(http)
    ]
    dashboard_records = [r for r in records if r[0].startswith("dashboard_")]
    owner = {"owner": "project", "owner_name": name}
    assert dashboard_records == [
        ("dashboard_add", "succeeded", "Latency", owner | {"version": 1, "panels": 1}),
        (
            "dashboard_save",
            "succeeded",
            "Latency",
            owner | {"version": 2, "previous_version": 1, "panels": 2},
        ),
        (
            "dashboard_save",
            "failed",
            "Latency",
            owner | {"version": 2, "previous_version": 1, "panels": 1},
        ),
        (
            "dashboard_add",
            "succeeded",
            "Latency (copy)",
            owner | {"version": 1, "panels": 2, "copied_from": "Latency"},
        ),
        (
            "dashboard_save",
            "succeeded",
            "Latency",
            owner
            | {
                "version": 3,
                "previous_version": 2,
                "panels": 1,
                "alerts_added": ["API latency high"],
            },
        ),
    ]


async def test_writes_return_the_alert_changes(monitoring_app, linked_project):
    _http, app = monitoring_app
    pid = linked_project.project_id
    request = request_for(app)
    as_tool(app)  # Shop's Prometheus has the Operator
    made, changes = await create_dashboard_audited(
        request,
        owner_kind="project",
        owner_id=pid,
        spec=board(panel(alert=ALERT | {"engine": "tool"})),
    )
    [created] = changes
    assert created.kind == "review" and created.tool == "prometheus_rule"
    # Its review was applied: the PrometheusRule is in the cluster.
    services = app.state.monitoring
    obj = ToolObject("prometheus_rule", linked_project.source_id, None, "shop", "omnikrux-rule")
    await services.alerts.set_tool(
        created.target_id,
        tool_state="in_sync",
        tool_message=None,
        tool_object=obj,
        applied_version=1,
    )

    saved, changes = await save_dashboard_audited(
        request, made.id, base_version=made.version, spec=board(panel())
    )
    assert saved.version == made.version + 1
    assert [(c.kind, c.rule_name, c.project_id) for c in changes] == [
        ("review", "API latency high", pid)
    ]

    # No alert on any panel: nothing to tell.
    again, changes = await save_dashboard_audited(
        request, made.id, base_version=saved.version, spec=board(panel(title="Rate"))
    )
    assert again.version == saved.version + 1 and changes == []


async def test_writes_record_origin_and_custom_audit(monitoring_app, linked_project):
    http, app = monitoring_app
    request = request_for(app)
    services = app.state.monitoring
    made, changes = await create_dashboard_audited(
        request,
        owner_kind="project",
        owner_id=linked_project.project_id,
        spec=board(title="API"),
        origin="imported",
        copied_from="api.json",
        action="dashboard_import",
        details={"from": "api.json"},
    )
    assert changes == []
    [first] = await services.dashboards.versions(made.id)
    assert (first.origin, first.copied_from) == ("imported", "api.json")

    saved, _ = await save_dashboard_audited(
        request,
        made.id,
        base_version=1,
        spec=board(panel(title="Rate"), title="API"),
        origin="updated",
        copied_from="api.json",
        action="dashboard_update",
        details={"from": "api.json", "version": 2},
    )
    latest = (await services.dashboards.versions(made.id))[0]
    assert saved.version == 2 and (latest.origin, latest.copied_from) == ("updated", "api.json")

    records = [
        (r["action"], r["kind"], r["name"], r["outcome"], r["details"])
        for r in await monitoring_records(http)
        if r["kind"] == "dashboard"
    ]
    assert records == [
        ("dashboard_import", "dashboard", "API", "succeeded", {"from": "api.json"}),
        (
            "dashboard_update",
            "dashboard",
            "API",
            "succeeded",
            {"from": "api.json", "version": 2},
        ),
    ]


async def test_writes_refuse_as_the_routes_do(monitoring_app, linked_project):
    http, app = monitoring_app
    request = request_for(app)
    with pytest.raises(HTTPException) as gone:
        await create_dashboard_audited(
            request, owner_kind="project", owner_id="nope", spec=board(), action="dashboard_import"
        )
    assert (gone.value.status_code, gone.value.detail["code"]) == (404, "unknown_owner")

    made, _ = await create_dashboard_audited(
        request, owner_kind="project", owner_id=linked_project.project_id, spec=board()
    )
    with pytest.raises(HTTPException) as taken:
        await create_dashboard_audited(
            request, owner_kind="project", owner_id=linked_project.project_id, spec=board()
        )
    assert (taken.value.status_code, taken.value.detail["code"]) == (409, "name_taken")

    with pytest.raises(HTTPException) as conflict:
        await save_dashboard_audited(request, made.id, base_version=7, spec=board())
    assert conflict.value.detail["current_version"] == 1

    ready = f"ready:{linked_project.project_id}:cluster"
    with pytest.raises(HTTPException) as read_only:
        await save_dashboard_audited(request, ready, base_version=0, spec=board())
    assert (read_only.value.status_code, read_only.value.detail["code"]) == (409, "read_only")
    # Refused before the audit: only the refused add and the conflict left records.
    outcomes = [
        (r["action"], r["outcome"])
        for r in await monitoring_records(http)
        if r["kind"] == "dashboard"
    ]
    assert outcomes == [
        ("dashboard_add", "succeeded"),
        ("dashboard_add", "failed"),
        ("dashboard_save", "failed"),
    ]
