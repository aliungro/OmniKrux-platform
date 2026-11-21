"""Groups: a group lists projects; making, changing or deleting one never moves a project."""

import pytest

from omnikrux.audit.store import AuditUnavailable
from omnikrux.monitoring.projects.types import ReviewChanged

API = "/api/monitoring"
CHOSEN_GONE = "One of the chosen projects no longer exists. Reload and pick again."
GROUP_GONE = "That group doesn't exist anymore. It may have been removed."


async def monitoring_records(http) -> list[dict]:
    """Monitoring's audit records, oldest first."""
    records = (await http.get("/api/audit")).json()["records"]
    return [r for r in reversed(records) if r["app"] == "monitoring"]


async def set_up(http, name: str) -> dict:
    body = {
        "name": name,
        "kind": "custom",
        "cluster_id": None,
        "sources": [
            {"source": {"type": "prometheus", "reach": "url", "url": f"http://{name}.example"}}
        ],
    }
    response = await http.post(f"{API}/setup", json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def add_group(http, name: str, project_ids: list[str]) -> dict:
    response = await http.post(f"{API}/groups", json={"name": name, "project_ids": project_ids})
    assert response.status_code == 201, response.text
    return response.json()


async def test_group_combines_projects_without_moving_them(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "shop")
    billing = await set_up(http, "Billing")
    ops = await add_group(http, "Ops", [shop["id"], billing["id"]])
    everything = await add_group(http, "all", [shop["id"]])
    assert ops["project_ids"] == [billing["id"], shop["id"]]  # by project name

    in_both = (await http.get(f"{API}/projects/{shop['id']}")).json()
    assert sorted(in_both["group_ids"]) == sorted([ops["id"], everything["id"]])
    tree = (await http.get(f"{API}/tree")).json()
    assert [(g["name"], g["project_ids"], g["dashboards"]) for g in tree["groups"]] == [
        ("all", [shop["id"]], []),
        ("Ops", [billing["id"], shop["id"]], []),
    ]
    assert [p["name"] for p in tree["projects"]] == ["Billing", "shop"]

    gone = await http.delete(f"{API}/groups/{ops['id']}")
    assert gone.status_code == 204
    after = (await http.get(f"{API}/projects/{shop['id']}")).json()
    assert after["group_ids"] == [everything["id"]]
    assert after["links"] == in_both["links"]
    assert len((await http.get(f"{API}/projects")).json()) == 2
    assert [g["name"] for g in (await http.get(f"{API}/groups")).json()] == ["all"]
    again = await http.delete(f"{API}/groups/{ops['id']}")
    assert again.status_code == 404 and again.json() == {"detail": GROUP_GONE}


async def test_change_group_name_and_members(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop")
    billing = await set_up(http, "Billing")
    ops = await add_group(http, "Ops", [shop["id"]])
    await add_group(http, "Taken", [])

    renamed = await http.patch(f"{API}/groups/{ops['id']}", json={"name": "Platform"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Platform" and renamed.json()["project_ids"] == [shop["id"]]
    moved = await http.patch(f"{API}/groups/{ops['id']}", json={"project_ids": [billing["id"]]})
    assert moved.json()["project_ids"] == [billing["id"]]
    taken = await http.patch(f"{API}/groups/{ops['id']}", json={"name": "Taken"})
    assert taken.status_code == 409
    assert taken.json() == {"detail": 'A group named "Taken" already exists. Pick another name.'}
    missing = await http.patch(f"{API}/groups/nope", json={"name": "X"})
    assert missing.status_code == 404 and missing.json() == {"detail": GROUP_GONE}

    records = await monitoring_records(http)
    groups = [r for r in records if r["kind"] == "group"]
    assert [(r["action"], r["name"], r["outcome"], r["details"]) for r in groups] == [
        ("group_add", "Ops", "succeeded", {"projects": ["Shop"]}),
        ("group_add", "Taken", "succeeded", {"projects": []}),
        ("group_change", "Platform", "succeeded", {"renamed_from": "Ops"}),
        ("group_change", "Platform", "succeeded", {"projects": ["Billing"]}),
        ("group_change", "Taken", "failed", {"renamed_from": "Platform"}),
    ]


async def test_group_refuses_projects_that_are_gone(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop")
    refused = await http.post(f"{API}/groups", json={"name": "Ops", "project_ids": ["nope"]})
    assert refused.status_code == 422
    assert refused.json() == {"detail": CHOSEN_GONE}
    ops = await add_group(http, "Ops", [shop["id"]])
    patched = await http.patch(f"{API}/groups/{ops['id']}", json={"project_ids": ["nope"]})
    assert patched.status_code == 422
    assert patched.json() == {"detail": CHOSEN_GONE}
    assert (await http.get(f"{API}/groups")).json()[0]["project_ids"] == [shop["id"]]
    assert [r["action"] for r in await monitoring_records(http) if r["kind"] == "group"] == [
        "group_add"
    ]


# --- Dashboards go with their group -----------------------------------------------------------

REVIEW_CHANGED = "Something changed since the review. Review it again."


def board(title: str, panels: int = 1) -> dict:
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
                    {"ref": "A", "source": {"type": "prometheus", "id": None}, "expr": "up"}
                ],
            }
            for i in range(panels)
        ],
    }


async def add_dashboard(
    http, owner_kind: str, owner_id: str, title: str, versions: int = 1
) -> dict:
    """A dashboard saved `versions` times in all (the create is the first)."""
    response = await http.post(
        f"{API}/dashboards",
        json={"owner_kind": owner_kind, "owner_id": owner_id, "spec": board(title)},
    )
    assert response.status_code == 201, response.text
    made = response.json()
    for version in range(2, versions + 1):
        response = await http.put(
            f"{API}/dashboards/{made['id']}",
            json={"base_version": made["version"], "spec": board(title, version)},
        )
        assert response.status_code == 200, response.text
        made = response.json()
    return made


async def test_group_with_dashboards_needs_a_review(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop")
    billing = await set_up(http, "Billing")
    ops = await add_group(http, "Ops", [shop["id"], billing["id"]])
    overview = await add_dashboard(http, "group", ops["id"], "Overview", versions=2)
    errors = await add_dashboard(http, "group", ops["id"], "errors")
    shop_board = await add_dashboard(http, "project", shop["id"], "Shop health")

    review_url = f"{API}/groups/{ops['id']}/delete-review"
    review = (await http.get(review_url)).json()
    assert review == {
        "group_id": ops["id"],
        "name": "Ops",
        "dashboards": [
            {"id": errors["id"], "title": "errors", "versions": 1},
            {"id": overview["id"], "title": "Overview", "versions": 2},
        ],
        "token": review["token"],
    }

    tokenless = await http.delete(f"{API}/groups/{ops['id']}")
    assert tokenless.status_code == 409
    assert tokenless.json() == {"detail": REVIEW_CHANGED}
    assert (await http.get(f"{API}/groups")).json()[0]["id"] == ops["id"]
    assert (await http.get(f"{API}/dashboards/{overview['id']}")).status_code == 200

    gone = await http.delete(f"{API}/groups/{ops['id']}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text
    assert (await http.get(f"{API}/groups")).json() == []
    for d in (overview, errors):
        assert (await http.get(f"{API}/dashboards/{d['id']}")).status_code == 404
        assert (await http.get(f"{API}/dashboards/{d['id']}/versions")).status_code == 404
    assert [p["name"] for p in (await http.get(f"{API}/projects")).json()] == ["Billing", "Shop"]
    assert (await http.get(f"{API}/dashboards/{shop_board['id']}")).status_code == 200

    removes = [r for r in await monitoring_records(http) if r["action"].endswith("_remove")]
    assert [(r["action"], r["kind"], r["name"], r["outcome"]) for r in removes] == [
        ("group_remove", "group", "Ops", "failed"),
        ("group_remove", "group", "Ops", "succeeded"),
        ("dashboard_remove", "dashboard", "errors", "succeeded"),
        ("dashboard_remove", "dashboard", "Overview", "succeeded"),
    ]
    assert removes[1]["details"] == {"projects": ["Billing", "Shop"]}
    assert [r["details"] for r in removes[2:]] == [
        {"owner": "group", "owner_name": "Ops", "versions": 1, "with": "group"},
        {"owner": "group", "owner_name": "Ops", "versions": 2, "with": "group"},
    ]


async def test_group_review_goes_stale_when_a_dashboard_is_added(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop")
    ops = await add_group(http, "Ops", [shop["id"]])
    review = (await http.get(f"{API}/groups/{ops['id']}/delete-review")).json()
    assert review["dashboards"] == []
    made = await add_dashboard(http, "group", ops["id"], "Overview")

    stale = await http.delete(f"{API}/groups/{ops['id']}", params={"token": review["token"]})
    assert stale.status_code == 409 and stale.json() == {"detail": REVIEW_CHANGED}
    assert (await http.get(f"{API}/dashboards/{made['id']}")).status_code == 200
    missing = await http.get(f"{API}/groups/nope/delete-review")
    assert missing.status_code == 404 and missing.json() == {"detail": GROUP_GONE}


async def test_leaving_a_group_keeps_group_dashboards(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop")
    billing = await set_up(http, "Billing")
    ops = await add_group(http, "Ops", [shop["id"], billing["id"]])
    overview = await add_dashboard(http, "group", ops["id"], "Overview", versions=2)
    shop_board = await add_dashboard(http, "project", shop["id"], "Shop health")

    left = await http.patch(f"{API}/groups/{ops['id']}", json={"project_ids": [billing["id"]]})
    assert left.status_code == 200, left.text
    emptied = await http.patch(f"{API}/groups/{ops['id']}", json={"project_ids": []})
    assert emptied.status_code == 200, emptied.text

    kept = (await http.get(f"{API}/dashboards/{overview['id']}")).json()
    assert (kept["owner_kind"], kept["owner_id"], kept["version"]) == ("group", ops["id"], 2)
    assert (await http.get(f"{API}/dashboards/{shop_board['id']}")).json()["version"] == 1
    assert not [r for r in await monitoring_records(http) if r["action"] == "dashboard_remove"]


async def test_no_audit_no_group_delete(monitoring_app, monkeypatch):
    http, app = monitoring_app
    shop = await set_up(http, "Shop")
    ops = await add_group(http, "Ops", [shop["id"]])
    made = await add_dashboard(http, "group", ops["id"], "Overview")
    review = (await http.get(f"{API}/groups/{ops['id']}/delete-review")).json()

    async def broken(entry):
        raise AuditUnavailable("disk I/O error")

    monkeypatch.setattr(app.state.audit, "begin_app", broken)
    refused = await http.delete(f"{API}/groups/{ops['id']}", params={"token": review["token"]})
    assert refused.status_code == 503
    assert [g["id"] for g in (await http.get(f"{API}/groups")).json()] == [ops["id"]]
    assert (await http.get(f"{API}/dashboards/{made['id']}")).status_code == 200


async def test_group_store_rechecks_the_review_inside_the_delete(monitoring_app):
    http, app = monitoring_app
    services = app.state.monitoring
    shop = await set_up(http, "Shop")
    ops = await add_group(http, "Ops", [shop["id"]])
    review = await services.groups.delete_review(ops["id"], services.dashboards)
    made = await add_dashboard(http, "group", ops["id"], "Overview")

    for token in (None, review.token):
        with pytest.raises(ReviewChanged):
            await services.groups.delete(ops["id"], token, services.dashboards)
    assert (await http.get(f"{API}/dashboards/{made['id']}")).status_code == 200
    fresh = await services.groups.delete_review(ops["id"], services.dashboards)
    done = await services.groups.delete(ops["id"], fresh.token, services.dashboards)
    assert [d.title for d in done.dashboards] == ["Overview"]
    assert (await http.get(f"{API}/dashboards/{made['id']}")).status_code == 404
