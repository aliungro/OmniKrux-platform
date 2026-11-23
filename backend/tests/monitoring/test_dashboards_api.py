"""The dashboards API: create, save, versions, restore, copy and delete, each audited before the
change; refusals answer `{code, message}` in plain words; dashboards appear in the tree."""

from omnikrux.audit.store import AuditUnavailable

API = "/api/monitoring"
DASHBOARDS = f"{API}/dashboards"
CONFLICT = (
    "This dashboard was saved somewhere else since you started (version {}). "
    "Review the differences before saving."
)
DASHBOARD_GONE = "That dashboard no longer exists."
OWNER_GONE = "That project or group no longer exists."
GROUP_ID = 'In a group dashboard each project uses its own source, so "id" must be null.'
QUERY_TEXT = 'rate(http_requests_total{job="api-SECRET-7"}[5m])'


def doc(title: str, panels: int = 1, source_id: str | None = None) -> dict:
    """A dashboard document with `panels` stat panels stacked down the left."""
    return {
        "schemaVersion": 1,
        "title": title,
        "panels": [
            {
                "id": f"p-{i + 1}",
                "type": "stat",
                "title": f"Panel {i + 1}",
                "layout": {"x": 0, "y": 4 * i, "w": 6, "h": 4},
                "queries": [
                    {
                        "ref": "A",
                        "source": {"type": "prometheus", "id": source_id},
                        "expr": QUERY_TEXT,
                    }
                ],
            }
            for i in range(panels)
        ],
    }


async def monitoring_records(http) -> list[dict]:
    """Monitoring's audit records, oldest first."""
    records = (await http.get("/api/audit")).json()["records"]
    return [r for r in reversed(records) if r["app"] == "monitoring"]


async def create(http, owner_id: str, spec: dict, owner_kind: str = "project") -> dict:
    response = await http.post(
        DASHBOARDS, json={"owner_kind": owner_kind, "owner_id": owner_id, "spec": spec}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def add_group(http, name: str, project_ids: list[str]) -> dict:
    response = await http.post(f"{API}/groups", json={"name": name, "project_ids": project_ids})
    assert response.status_code == 201, response.text
    return response.json()


async def test_create_save_and_versions_through_the_api(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    r = await http.post(
        DASHBOARDS, json={"owner_kind": "project", "owner_id": pid, "spec": doc("API latency")}
    )
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["version"] == 1 and d["owner_name"] == linked_project.project_name
    assert d["owner_kind"] == "project" and d["owner_id"] == pid and d["ready_made"] is False
    assert d["title"] == "API latency" and d["spec"]["panels"][0]["id"] == "p-1"
    assert d["created_at"] and d["updated_at"]

    r = await http.put(
        f"{DASHBOARDS}/{d['id']}", json={"base_version": 1, "spec": doc("API latency", panels=2)}
    )
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 2 and len(r.json()["spec"]["panels"]) == 2
    versions = (await http.get(f"{DASHBOARDS}/{d['id']}/versions")).json()
    assert [v["version"] for v in versions] == [2, 1]
    assert [(v["origin"], v["panel_count"], v["title"]) for v in versions] == [
        ("saved", 2, "API latency"),
        ("created", 1, "API latency"),
    ]
    one = (await http.get(f"{DASHBOARDS}/{d['id']}/versions/1")).json()
    assert one["version"] == 1 and len(one["spec"]["panels"]) == 1 and one["saved_at"]

    got = (await http.get(f"{DASHBOARDS}/{d['id']}")).json()
    assert got["version"] == 2 and got["owner_name"] == "Shop"
    listed = (await http.get(DASHBOARDS, params={"owner_kind": "project", "owner_id": pid})).json()
    assert [(s["title"], s["version"], s["panel_count"], s["ready_made"]) for s in listed] == [
        ("API latency", 2, 2, False)
    ]


async def test_unknown_dashboard_owner_and_version_say_so(monitoring_app, linked_project):
    http, _ = monitoring_app
    gone = await http.get(f"{DASHBOARDS}/nope")
    assert gone.status_code == 404
    assert gone.json() == {"detail": {"code": "not_found", "message": DASHBOARD_GONE}}
    for method, path, body in (
        ("PUT", f"{DASHBOARDS}/nope", {"base_version": 1, "spec": doc("A")}),
        ("GET", f"{DASHBOARDS}/nope/versions", None),
        ("POST", f"{DASHBOARDS}/nope/versions/1/restore", {"base_version": 1}),
        ("DELETE", f"{DASHBOARDS}/nope?version=1", None),
    ):
        r = await http.request(method, path, json=body)
        assert r.status_code == 404, (method, path)
        assert r.json()["detail"]["code"] == "not_found", (method, path)

    no_owner = await http.post(
        DASHBOARDS, json={"owner_kind": "group", "owner_id": "nope", "spec": doc("A")}
    )
    assert no_owner.status_code == 404
    assert no_owner.json() == {"detail": {"code": "unknown_owner", "message": OWNER_GONE}}

    d = await create(http, linked_project.project_id, doc("A"))
    for path in (f"{DASHBOARDS}/{d['id']}/versions/9", f"{DASHBOARDS}/{d['id']}/versions/x"):
        r = await http.get(path)
        assert r.status_code == 404 and r.json()["detail"]["code"] == "not_found"
    assert (await monitoring_records(http))[-1]["action"] == "dashboard_add"


async def test_invalid_document_lists_problems(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    spec = doc("API latency")
    spec["panels"][0]["layout"]["w"] = 30
    r = await http.post(DASHBOARDS, json={"owner_kind": "project", "owner_id": pid, "spec": spec})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_dashboard"
    assert detail["message"] == "panels[0].layout.w: Use a whole number from 2 to 24."
    assert detail["problems"][0] == {
        "path": "panels[0].layout.w",
        "message": "Use a whole number from 2 to 24.",
    }

    async def refused(body) -> dict:
        response = await http.post(DASHBOARDS, json=body)
        assert response.status_code == 422, response.text
        assert set(response.json()["detail"]) >= {"code", "message"}
        return response.json()["detail"]

    not_object = await refused({"owner_kind": "project", "owner_id": pid, "spec": [1]})
    assert not_object["code"] == "invalid_dashboard"
    assert not_object["problems"] == [{"path": "", "message": "Expected an object."}]
    for body in (
        {"owner_kind": "project", "spec": doc("A")},
        {"owner_kind": "team", "owner_id": pid, "spec": doc("A")},
        {"owner_kind": "project", "owner_id": pid, "spec": doc("A"), "extra": 1},
        [1, 2],
    ):
        assert (await refused(body))["code"] == "bad_request"
    not_json = await http.post(
        DASHBOARDS, content=b"{nope", headers={"content-type": "application/json"}
    )
    assert not_json.status_code == 422 and not_json.json()["detail"]["code"] == "bad_request"
    stale = await http.request("DELETE", f"{DASHBOARDS}/x?version=one")
    assert stale.status_code == 422 and stale.json()["detail"]["code"] == "bad_request"
    owner = await http.get(DASHBOARDS, params={"owner_kind": "team"})
    assert owner.status_code == 422 and owner.json()["detail"]["code"] == "bad_request"
    assert (await http.get(DASHBOARDS)).json() == []
    assert not [r for r in await monitoring_records(http) if r["kind"] == "dashboard"]


async def test_save_with_old_base_version_is_refused(monitoring_app, linked_project):
    http, _ = monitoring_app
    d = await create(http, linked_project.project_id, doc("API latency"))
    url = f"{DASHBOARDS}/{d['id']}"
    first = await http.put(url, json={"base_version": 1, "spec": doc("API latency", panels=2)})
    assert first.status_code == 200
    second = await http.put(url, json={"base_version": 1, "spec": doc("API latency", panels=3)})
    assert second.status_code == 409
    assert second.json() == {
        "detail": {
            "code": "version_conflict",
            "message": CONFLICT.format(2),
            "current_version": 2,
        }
    }
    assert (await http.get(url)).json()["version"] == 2
    stale_delete = await http.delete(url, params={"version": 1})
    assert stale_delete.status_code == 409
    assert stale_delete.json()["detail"]["current_version"] == 2
    saves = [r for r in await monitoring_records(http) if r["action"] == "dashboard_save"]
    assert [(r["outcome"], r["message"]) for r in saves] == [
        ("succeeded", None),
        ("failed", CONFLICT.format(2)),
    ]


async def test_titles_are_unique_per_owner(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    await create(http, pid, doc("API latency"))
    other = await create(http, pid, doc("Errors"))
    taken = 'A dashboard named "API latency" already exists. Pick another name.'
    again = await http.post(
        DASHBOARDS, json={"owner_kind": "project", "owner_id": pid, "spec": doc("API latency")}
    )
    assert again.status_code == 409
    assert again.json() == {"detail": {"code": "name_taken", "message": taken}}
    rename = await http.put(
        f"{DASHBOARDS}/{other['id']}", json={"base_version": 1, "spec": doc("API latency")}
    )
    assert rename.status_code == 409 and rename.json()["detail"]["code"] == "name_taken"


async def test_unlinked_source_is_refused_for_a_project(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    spec = doc("API latency", source_id="nope")
    r = await http.post(DASHBOARDS, json={"owner_kind": "project", "owner_id": pid, "spec": spec})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_dashboard"
    assert detail["problems"] == [
        {"path": "panels[0].queries[0].source.id", "message": "This source isn't linked to Shop."}
    ]
    assert detail["message"] == "panels[0].queries[0].source.id: This source isn't linked to Shop."

    d = await create(http, pid, doc("API latency", source_id=linked_project.source_id))
    assert d["spec"]["panels"][0]["queries"][0]["source"]["id"] == linked_project.source_id
    with_variable = doc("API latency", source_id=linked_project.source_id)
    with_variable["variables"] = [
        {
            "name": "job",
            "type": "labelValues",
            "source": {"type": "prometheus", "id": "gone"},
            "labelName": "job",
        }
    ]
    saved = await http.put(
        f"{DASHBOARDS}/{d['id']}", json={"base_version": 1, "spec": with_variable}
    )
    assert saved.status_code == 422, saved.text
    assert [p["path"] for p in saved.json()["detail"]["problems"]] == ["variables[0].source.id"]


async def test_group_dashboard_refuses_source_ids(monitoring_app, linked_project):
    http, _ = monitoring_app
    group = await add_group(http, "Ops", [linked_project.project_id])
    spec = doc("Overview", source_id=linked_project.source_id)
    r = await http.post(
        DASHBOARDS, json={"owner_kind": "group", "owner_id": group["id"], "spec": spec}
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_dashboard"
    assert r.json()["detail"]["problems"] == [
        {"path": "panels[0].queries[0].source.id", "message": GROUP_ID}
    ]
    d = await create(http, group["id"], doc("Overview"), owner_kind="group")
    assert d["owner_name"] == "Ops" and d["owner_kind"] == "group"


async def test_copy_adapts_sources_and_names_the_copy(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    group = await add_group(http, "Ops", [pid])
    source = await create(http, pid, doc("API latency", source_id=linked_project.source_id))

    r = await http.post(
        f"{DASHBOARDS}/copy",
        json={"from_id": source["id"], "owner_kind": "group", "owner_id": group["id"]},
    )
    assert r.status_code == 201, r.text
    copy = r.json()
    assert copy["title"] == "API latency (copy)" and copy["spec"]["title"] == "API latency (copy)"
    assert copy["owner_name"] == "Ops" and copy["version"] == 1
    assert copy["spec"]["panels"][0]["queries"][0]["source"] == {"type": "prometheus", "id": None}
    versions = (await http.get(f"{DASHBOARDS}/{copy['id']}/versions")).json()
    assert [(v["version"], v["origin"], v["copied_from"]) for v in versions] == [
        (1, "copied", "API latency")
    ]

    again = await http.post(
        f"{DASHBOARDS}/copy",
        json={"from_id": source["id"], "owner_kind": "group", "owner_id": group["id"]},
    )
    assert again.json()["title"] == "API latency (copy) (2)"
    same_project = await http.post(
        f"{DASHBOARDS}/copy",
        json={"from_id": source["id"], "owner_kind": "project", "owner_id": pid},
    )
    kept = same_project.json()["spec"]["panels"][0]["queries"][0]["source"]["id"]
    assert kept == linked_project.source_id

    named = await http.post(
        f"{DASHBOARDS}/copy",
        json={
            "from_id": source["id"],
            "owner_kind": "project",
            "owner_id": pid,
            "title": "API latency",
        },
    )
    assert named.status_code == 409 and named.json()["detail"]["code"] == "name_taken"
    missing = await http.post(
        f"{DASHBOARDS}/copy", json={"from_id": "nope", "owner_kind": "project", "owner_id": pid}
    )
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "not_found"
    no_owner = await http.post(
        f"{DASHBOARDS}/copy",
        json={"from_id": source["id"], "owner_kind": "group", "owner_id": "nope"},
    )
    assert no_owner.status_code == 404 and no_owner.json()["detail"]["code"] == "unknown_owner"

    adds = [r for r in await monitoring_records(http) if r["action"] == "dashboard_add"]
    assert adds[1]["details"] == {
        "owner": "group",
        "owner_name": "Ops",
        "version": 1,
        "panels": 1,
        "copied_from": "API latency",
    }


async def test_restore_through_the_api(monitoring_app, linked_project):
    http, _ = monitoring_app
    d = await create(http, linked_project.project_id, doc("API latency"))
    url = f"{DASHBOARDS}/{d['id']}"
    await http.put(url, json={"base_version": 1, "spec": doc("Renamed", panels=3)})

    r = await http.post(f"{url}/versions/1/restore", json={"base_version": 2})
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 3 and r.json()["title"] == "API latency"
    assert len(r.json()["spec"]["panels"]) == 1
    versions = (await http.get(f"{url}/versions")).json()
    assert [(v["version"], v["origin"], v["restored_from"]) for v in versions] == [
        (3, "restored", 1),
        (2, "saved", None),
        (1, "created", None),
    ]
    stale = await http.post(f"{url}/versions/1/restore", json={"base_version": 2})
    assert stale.status_code == 409 and stale.json()["detail"]["current_version"] == 3


async def test_every_dashboard_write_is_audited(monitoring_app, linked_project):
    http, _ = monitoring_app
    d = await create(http, linked_project.project_id, doc("API latency"))
    url = f"{DASHBOARDS}/{d['id']}"
    assert (await http.put(url, json={"base_version": 1, "spec": doc("API latency", 2)})).is_success
    assert (await http.post(f"{url}/versions/1/restore", json={"base_version": 2})).is_success
    assert (await http.delete(url, params={"version": 3})).status_code == 204
    assert (await http.get(url)).status_code == 404

    records = [r for r in await monitoring_records(http) if r["kind"] == "dashboard"]
    assert [(r["action"], r["name"], r["outcome"]) for r in records] == [
        ("dashboard_add", "API latency", "succeeded"),
        ("dashboard_save", "API latency", "succeeded"),
        ("dashboard_restore", "API latency", "succeeded"),
        ("dashboard_remove", "API latency", "succeeded"),
    ]
    assert [r["details"] for r in records] == [
        {"owner": "project", "owner_name": "Shop", "version": 1, "panels": 1},
        {
            "owner": "project",
            "owner_name": "Shop",
            "version": 2,
            "previous_version": 1,
            "panels": 2,
        },
        {"from_version": 1, "version": 3},
        {"owner": "project", "owner_name": "Shop", "versions": 3},
    ]
    assert all(r["app"] == "monitoring" for r in records)
    assert "SECRET-7" not in (await http.get("/api/audit")).text


async def test_no_audit_no_dashboard(monitoring_app, linked_project, monkeypatch):
    http, app = monitoring_app

    async def broken(entry):
        raise AuditUnavailable("disk I/O error")

    monkeypatch.setattr(app.state.audit, "begin_app", broken)
    r = await http.post(
        DASHBOARDS,
        json={"owner_kind": "project", "owner_id": linked_project.project_id, "spec": doc("A")},
    )
    assert r.status_code == 503
    assert (await http.get(DASHBOARDS)).json() == []


async def test_tree_lists_dashboards_under_their_owner(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    group = await add_group(http, "Ops", [pid])
    zeta = await create(http, pid, doc("zeta"))
    alpha = await create(http, pid, doc("Alpha"))
    mid = await create(http, pid, doc("beta"))
    overview = await create(http, group["id"], doc("Overview"), owner_kind="group")

    tree = (await http.get(f"{API}/tree")).json()
    [project] = tree["projects"]
    assert project["dashboards"] == [
        {"id": alpha["id"], "title": "Alpha", "ready_made": False},
        {"id": mid["id"], "title": "beta", "ready_made": False},
        {"id": zeta["id"], "title": "zeta", "ready_made": False},
        # After the saved ones: the ready-made view a project with Prometheus always has.
        {"id": f"ready:{pid}:nodes", "title": "Node health", "ready_made": True},
    ]
    [ops] = tree["groups"]
    assert ops["dashboards"] == [{"id": overview["id"], "title": "Overview", "ready_made": False}]


async def test_dashboard_routes_refuse_cross_origin(monitoring_app, linked_project):
    http, _ = monitoring_app
    d = await create(http, linked_project.project_id, doc("API latency"))
    url = f"{DASHBOARDS}/{d['id']}"
    evil = {"Origin": "http://evil.example"}
    for method, path, body in (
        ("GET", DASHBOARDS, None),
        ("POST", DASHBOARDS, {"owner_kind": "project", "owner_id": "x", "spec": doc("B")}),
        ("GET", url, None),
        ("PUT", url, {"base_version": 1, "spec": doc("B")}),
        ("DELETE", f"{url}?version=1", None),
        ("GET", f"{url}/versions", None),
        ("GET", f"{url}/versions/1", None),
        ("POST", f"{url}/versions/1/restore", {"base_version": 1}),
        ("POST", f"{DASHBOARDS}/copy", {"from_id": d["id"], "owner_kind": "project"}),
    ):
        r = await http.request(method, path, json=body, headers=evil)
        assert r.status_code == 403, (method, path)
        assert r.json() == {"detail": "Cross-origin request refused"}
    assert (await http.get(url)).json()["version"] == 1
    assert len((await http.get(DASHBOARDS)).json()) == 1


async def test_explore_save_is_noted_in_audit(monitoring_app, linked_project):
    http, _ = monitoring_app
    d = await create(http, linked_project.project_id, doc("API latency"))
    spec = doc("API latency", panels=2)
    spec["panels"][1]["title"] = "CPU"
    saved = await http.put(
        f"{DASHBOARDS}/{d['id']}", json={"base_version": 1, "spec": spec, "origin": "explore"}
    )
    assert saved.status_code == 200, saved.text
    # A save that adds nothing new lists no panels.
    again = await http.put(
        f"{DASHBOARDS}/{d['id']}", json={"base_version": 2, "spec": spec, "origin": "explore"}
    )
    assert again.status_code == 200, again.text
    saves = [r for r in await monitoring_records(http) if r["action"] == "dashboard_save"]
    assert [r["details"] for r in saves] == [
        {
            "owner": "project",
            "owner_name": "Shop",
            "version": 2,
            "previous_version": 1,
            "panels": 2,
            "from": "explore",
            "added_panels": ["CPU"],
        },
        {
            "owner": "project",
            "owner_name": "Shop",
            "version": 3,
            "previous_version": 2,
            "panels": 2,
            "from": "explore",
            "added_panels": [],
        },
    ]


async def test_editor_save_details_are_unchanged(monitoring_app, linked_project):
    http, _ = monitoring_app
    d = await create(http, linked_project.project_id, doc("API latency"))
    url = f"{DASHBOARDS}/{d['id']}"
    assert (await http.put(url, json={"base_version": 1, "spec": doc("API latency", 2)})).is_success
    assert (
        await http.put(
            url, json={"base_version": 2, "spec": doc("API latency", 3), "origin": "editor"}
        )
    ).is_success
    refused = await http.put(
        url, json={"base_version": 3, "spec": doc("API latency", 3), "origin": "other"}
    )
    assert refused.status_code == 422
    saves = [r for r in await monitoring_records(http) if r["action"] == "dashboard_save"]
    assert [r["details"] for r in saves] == [
        {
            "owner": "project",
            "owner_name": "Shop",
            "version": v,
            "previous_version": v - 1,
            "panels": v,
        }
        for v in (2, 3)
    ]
