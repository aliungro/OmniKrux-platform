"""Groups: a group lists projects; making, changing or deleting one never moves a project."""

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
