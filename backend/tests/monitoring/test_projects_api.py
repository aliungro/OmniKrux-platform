"""Projects: reading them, linking sources with filters, renaming, and deleting through a review."""

from omnikrux.audit.store import AuditUnavailable
from omnikrux.monitoring.query.filters import BAD_FILTER

API = "/api/monitoring"
REVIEW_CHANGED = "Something changed since the review. Review it again."


async def monitoring_records(http) -> list[dict]:
    """Monitoring's audit records, oldest first."""
    records = (await http.get("/api/audit")).json()["records"]
    return [r for r in reversed(records) if r["app"] == "monitoring"]


async def add_source(http, name: str, url: str = "http://prometheus.example:9090") -> dict:
    response = await http.post(
        f"{API}/sources", json={"type": "prometheus", "reach": "url", "url": url, "name": name}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def set_up(http, name: str, sources: list[dict] | None = None, **over) -> dict:
    body = {"name": name, "kind": "custom", "cluster_id": None, "sources": sources or []}
    response = await http.post(f"{API}/setup", json=body | over)
    assert response.status_code == 201, response.text
    return response.json()


def new(name: str) -> dict:
    return {
        "source": {"type": "prometheus", "reach": "url", "url": "http://p.example", "name": name}
    }


async def test_link_filter_is_validated_and_editable(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop")
    source = await add_source(http, "Metrics")
    link_url = f"{API}/projects/{shop['id']}/sources/{source['id']}"

    refused = await http.put(link_url, json={"filter": "cluster=prod"})
    assert refused.status_code == 422
    assert refused.json() == {"detail": BAD_FILTER}

    linked = await http.put(link_url, json={"filter": 'cluster="prod"'})
    assert linked.status_code == 200, linked.text
    assert linked.json() == {
        "source_id": source["id"],
        "source_name": "Metrics",
        "source_type": "prometheus",
        "filter": 'cluster="prod"',
        "filter_origin": "user",
        "created_by_project": False,
    }
    edited = await http.put(link_url, json={"filter": 'cluster="dev"', "origin": "auto"})
    assert edited.json()["filter"] == 'cluster="dev"' and edited.json()["filter_origin"] == "auto"
    links = (await http.get(f"{API}/projects/{shop['id']}")).json()["links"]
    assert [(link["source_name"], link["filter"]) for link in links] == [
        ("Metrics", 'cluster="dev"')
    ]

    assert (await http.delete(link_url)).status_code == 204
    assert (await http.get(f"{API}/projects/{shop['id']}")).json()["links"] == []
    again = await http.delete(link_url)
    assert again.status_code == 404
    assert again.json() == {"detail": "This source isn't linked to that project."}
    missing = await http.put(f"{API}/projects/{shop['id']}/sources/nope", json={"filter": ""})
    assert missing.status_code == 404
    assert missing.json() == {
        "detail": "That source doesn't exist anymore. It may have been removed."
    }

    changes = [r for r in await monitoring_records(http) if r["action"] == "project_change"]
    assert [(r["name"], r["details"], r["outcome"]) for r in changes] == [
        ("Shop", {"linked": "Metrics", "filter": 'cluster="prod"'}, "succeeded"),
        ("Shop", {"linked": "Metrics", "filter": 'cluster="dev"'}, "succeeded"),
        ("Shop", {"unlinked": "Metrics"}, "succeeded"),
    ]


async def test_project_of_a_removed_cluster_still_opens(monitoring_app, kube_cluster):
    http, app = monitoring_app
    cluster = await app.state.registry.get(kube_cluster)
    project = await set_up(http, "Cluster apps", kind="kubernetes", cluster_id=kube_cluster)
    assert project["cluster_name"] == cluster.name
    assert project["cluster_provider"] == cluster.provider.value
    tree = (await http.get(f"{API}/tree")).json()
    assert tree["projects"][0]["color"] == cluster.provider.value

    await app.state.registry.delete(kube_cluster)
    opened = await http.get(f"{API}/projects/{project['id']}")
    assert opened.status_code == 200
    assert opened.json()["cluster_id"] == kube_cluster
    assert opened.json()["cluster_name"] is None and opened.json()["cluster_provider"] is None
    assert (await http.get(f"{API}/tree")).json()["projects"][0]["color"] == "custom"


async def test_tree_colors_and_order(monitoring_app):
    http, _ = monitoring_app
    await add_source(http, "Metrics")
    await set_up(http, "web", kind="docker")
    await set_up(http, "Azure resources")
    await set_up(http, "hosts", kind="servers")
    tree = (await http.get(f"{API}/tree")).json()
    assert [(p["name"], p["color"], p["dashboards"]) for p in tree["projects"]] == [
        ("Azure resources", "custom", []),
        ("hosts", "onprem", []),
        ("web", "onprem", []),
    ]
    assert tree["source_count"] == 1
    listed = (await http.get(f"{API}/projects")).json()
    assert [p["name"] for p in listed] == ["Azure resources", "hosts", "web"]


async def test_unknown_project_is_404(monitoring_app):
    http, _ = monitoring_app
    gone = "That project doesn't exist anymore. It may have been removed."
    for method, path in [
        ("GET", f"{API}/projects/nope"),
        ("GET", f"{API}/projects/nope/delete-review"),
        ("PATCH", f"{API}/projects/nope"),
        ("DELETE", f"{API}/projects/nope?token=x"),
    ]:
        response = await http.request(method, path, json={"name": "X"})
        assert response.status_code == 404, (method, path)
        assert response.json() == {"detail": gone}
    assert await monitoring_records(http) == []


async def test_rename_project(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop")
    await set_up(http, "Billing")
    taken = await http.patch(f"{API}/projects/{shop['id']}", json={"name": "Billing"})
    assert taken.status_code == 409
    assert taken.json() == {
        "detail": 'A project named "Billing" already exists. Pick another name.'
    }
    renamed = await http.patch(f"{API}/projects/{shop['id']}", json={"name": "Store"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Store"
    changes = [r for r in await monitoring_records(http) if r["action"] == "project_change"]
    assert [(r["name"], r["outcome"], r["details"]) for r in changes] == [
        ("Billing", "failed", {"renamed_from": "Shop"}),
        ("Store", "succeeded", {"renamed_from": "Shop"}),
    ]


async def test_delete_with_stale_review_changes_nothing(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop", [new("Own")])
    review_url = f"{API}/projects/{shop['id']}/delete-review"
    review = (await http.get(review_url)).json()
    assert [s["name"] for s in review["sources_removed"]] == ["Own"]
    assert review["groups_left"] == []

    group = await http.post(f"{API}/groups", json={"name": "Ops", "project_ids": [shop["id"]]})
    assert group.status_code == 201
    stale = await http.delete(f"{API}/projects/{shop['id']}", params={"token": review["token"]})
    assert stale.status_code == 409
    assert stale.json() == {"detail": REVIEW_CHANGED}
    assert (await http.get(f"{API}/projects/{shop['id']}")).status_code == 200
    assert [s["name"] for s in (await http.get(f"{API}/sources")).json()] == ["Own"]
    assert len((await http.get(f"{API}/projects/{shop['id']}")).json()["links"]) == 1
    assert (await http.get(f"{API}/groups")).json()[0]["project_ids"] == [shop["id"]]
    removes = [r for r in await monitoring_records(http) if r["action"].endswith("_remove")]
    assert [(r["action"], r["name"], r["outcome"]) for r in removes] == [
        ("project_remove", "Shop", "failed")
    ]

    fresh = (await http.get(review_url)).json()
    assert [g["name"] for g in fresh["groups_left"]] == ["Ops"]
    gone = await http.delete(f"{API}/projects/{shop['id']}", params={"token": fresh["token"]})
    assert gone.status_code == 204
    assert (await http.get(f"{API}/projects")).json() == []


async def test_delete_project_removes_only_what_it_owns(monitoring_app):
    http, _ = monitoring_app
    outside = await add_source(http, "Outside")
    shop = await set_up(
        http, "Shop", [new("Own"), new("Shared"), {"source_id": outside["id"], "filter": 'a="b"'}]
    )
    shared_id = next(link["source_id"] for link in shop["links"] if link["source_name"] == "Shared")
    billing = await set_up(http, "Billing", [{"source_id": shared_id}])
    group = (
        await http.post(
            f"{API}/groups", json={"name": "Teams", "project_ids": [shop["id"], billing["id"]]}
        )
    ).json()

    review = (await http.get(f"{API}/projects/{shop['id']}/delete-review")).json()
    own_id = next(link["source_id"] for link in shop["links"] if link["source_name"] == "Own")
    assert review == {
        "project_id": shop["id"],
        "name": "Shop",
        "sources_removed": [{"id": own_id, "name": "Own"}],
        "sources_kept": [{"id": shared_id, "name": "Shared", "used_by": ["Billing"]}],
        "sources_unlinked": [{"id": outside["id"], "name": "Outside"}],
        "groups_left": [{"id": group["id"], "name": "Teams"}],
        "token": review["token"],
    }
    gone = await http.delete(f"{API}/projects/{shop['id']}", params={"token": review["token"]})
    assert gone.status_code == 204

    assert (await http.get(f"{API}/projects/{shop['id']}")).status_code == 404
    sources = {s["name"]: s for s in (await http.get(f"{API}/sources")).json()}
    assert set(sources) == {"Outside", "Shared"}
    assert sources["Shared"]["created_by_project_id"] is None
    assert [
        link["source_name"]
        for link in (await http.get(f"{API}/projects/{billing['id']}")).json()["links"]
    ] == ["Shared"]
    assert (await http.get(f"{API}/groups")).json()[0]["project_ids"] == [billing["id"]]

    records = await monitoring_records(http)
    removes = [r for r in records if r["action"].endswith("_remove")]
    assert [(r["action"], r["kind"], r["name"], r["outcome"]) for r in removes] == [
        ("project_remove", "project", "Shop", "succeeded"),
        ("source_remove", "source", "Own", "succeeded"),
    ]
    assert removes[0]["details"] == {"sources_removed": ["Own"], "groups_left": ["Teams"]}


async def test_monitoring_audit_records_name_the_object(monitoring_app):
    http, _ = monitoring_app
    source = await add_source(http, "Metrics")
    shop = await set_up(http, "Shop", [new("Own")])
    await http.put(f"{API}/projects/{shop['id']}/sources/{source['id']}", json={"filter": ""})
    await http.delete(f"{API}/projects/{shop['id']}/sources/{source['id']}")
    await http.patch(f"{API}/projects/{shop['id']}", json={"name": "Store"})
    group = (
        await http.post(f"{API}/groups", json={"name": "Ops", "project_ids": [shop["id"]]})
    ).json()
    await http.patch(f"{API}/groups/{group['id']}", json={"name": "Platform"})
    await http.delete(f"{API}/groups/{group['id']}")
    review = (await http.get(f"{API}/projects/{shop['id']}/delete-review")).json()
    await http.delete(f"{API}/projects/{shop['id']}", params={"token": review["token"]})

    records = await monitoring_records(http)
    assert [(r["action"], r["kind"], r["name"]) for r in records] == [
        ("source_add", "source", "Metrics"),
        ("project_add", "project", "Shop"),
        ("source_add", "source", "Own"),
        ("project_change", "project", "Shop"),
        ("project_change", "project", "Shop"),
        ("project_change", "project", "Store"),
        ("group_add", "group", "Ops"),
        ("group_change", "group", "Platform"),
        ("group_remove", "group", "Platform"),
        ("project_remove", "project", "Store"),
        ("source_remove", "source", "Own"),
    ]
    assert all(r["outcome"] == "succeeded" for r in records)
    assert all(r["kind"] in {"project", "group", "source"} for r in records)


# --- Dashboards go with their project ---------------------------------------------------------


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
    http, owner_id: str, title: str, versions: int = 1, owner_kind: str = "project"
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


async def test_project_review_lists_its_dashboards(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop", [new("Own")])
    other = await set_up(http, "Billing", [new("Theirs")])
    latency = await add_dashboard(http, shop["id"], "API latency", versions=2)
    errors = await add_dashboard(http, shop["id"], "errors")
    await add_dashboard(http, other["id"], "Invoices")

    review = (await http.get(f"{API}/projects/{shop['id']}/delete-review")).json()
    assert review["dashboards"] == [
        {"id": latency["id"], "title": "API latency", "versions": 2},
        {"id": errors["id"], "title": "errors", "versions": 1},
    ]
    assert [s["name"] for s in review["sources_removed"]] == ["Own"]


async def test_saving_a_dashboard_makes_the_project_review_stale(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop", [new("Own")])
    made = await add_dashboard(http, shop["id"], "API latency")
    review = (await http.get(f"{API}/projects/{shop['id']}/delete-review")).json()
    saved = await http.put(
        f"{API}/dashboards/{made['id']}", json={"base_version": 1, "spec": board("API latency", 2)}
    )
    assert saved.status_code == 200, saved.text

    stale = await http.delete(f"{API}/projects/{shop['id']}", params={"token": review["token"]})
    assert stale.status_code == 409
    assert stale.json() == {"detail": REVIEW_CHANGED}
    assert (await http.get(f"{API}/projects/{shop['id']}")).status_code == 200
    kept = (await http.get(f"{API}/dashboards/{made['id']}")).json()
    assert kept["version"] == 2
    assert len((await http.get(f"{API}/dashboards/{made['id']}/versions")).json()) == 2
    removes = [r for r in await monitoring_records(http) if r["action"].endswith("_remove")]
    assert [(r["action"], r["name"], r["outcome"]) for r in removes] == [
        ("project_remove", "Shop", "failed")
    ]

    fresh = (await http.get(f"{API}/projects/{shop['id']}/delete-review")).json()
    assert fresh["dashboards"] == [{"id": made["id"], "title": "API latency", "versions": 2}]
    assert fresh["token"] != review["token"]


async def test_deleting_a_project_takes_its_dashboards(monitoring_app):
    http, _ = monitoring_app
    shop = await set_up(http, "Shop", [new("Own")])
    billing = await set_up(http, "Billing", [new("Theirs")])
    latency = await add_dashboard(http, shop["id"], "API latency", versions=3)
    errors = await add_dashboard(http, shop["id"], "Errors")
    invoices = await add_dashboard(http, billing["id"], "Invoices", versions=2)

    review = (await http.get(f"{API}/projects/{shop['id']}/delete-review")).json()
    gone = await http.delete(f"{API}/projects/{shop['id']}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text

    for d in (latency, errors):
        assert (await http.get(f"{API}/dashboards/{d['id']}")).status_code == 404
        assert (await http.get(f"{API}/dashboards/{d['id']}/versions")).status_code == 404
    assert (await http.get(f"{API}/dashboards/{invoices['id']}")).json()["version"] == 2
    assert len((await http.get(f"{API}/dashboards/{invoices['id']}/versions")).json()) == 2
    assert [d["title"] for d in (await http.get(f"{API}/dashboards")).json()] == ["Invoices"]

    records = await monitoring_records(http)
    removes = [r for r in records if r["action"].endswith("_remove")]
    assert [(r["action"], r["kind"], r["name"], r["outcome"]) for r in removes] == [
        ("project_remove", "project", "Shop", "succeeded"),
        ("source_remove", "source", "Own", "succeeded"),
        ("dashboard_remove", "dashboard", "API latency", "succeeded"),
        ("dashboard_remove", "dashboard", "Errors", "succeeded"),
    ]
    assert [r["details"] for r in removes[2:]] == [
        {"owner": "project", "owner_name": "Shop", "versions": 3, "with": "project"},
        {"owner": "project", "owner_name": "Shop", "versions": 1, "with": "project"},
    ]


async def test_no_audit_no_project_delete(monitoring_app, monkeypatch):
    http, app = monitoring_app
    shop = await set_up(http, "Shop", [new("Own")])
    made = await add_dashboard(http, shop["id"], "API latency")
    review = (await http.get(f"{API}/projects/{shop['id']}/delete-review")).json()

    async def broken(entry):
        raise AuditUnavailable("disk I/O error")

    monkeypatch.setattr(app.state.audit, "begin_app", broken)
    refused = await http.delete(f"{API}/projects/{shop['id']}", params={"token": review["token"]})
    assert refused.status_code == 503
    assert (await http.get(f"{API}/projects/{shop['id']}")).status_code == 200
    assert (await http.get(f"{API}/dashboards/{made['id']}")).status_code == 200
