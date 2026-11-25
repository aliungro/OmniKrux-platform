"""Project setup: one request creates the project, its new sources and every link, or nothing."""

from omnikrux.monitoring.query.filters import BAD_FILTER
from omnikrux.monitoring.sources.rules import ONE_SOURCE

SETUP = "/api/monitoring/setup"
CLUSTER_NEEDED = "Pick a cluster for a Kubernetes project."


async def monitoring_records(http) -> list[dict]:
    """Monitoring's audit records, oldest first."""
    records = (await http.get("/api/audit")).json()["records"]
    return [r for r in reversed(records) if r["app"] == "monitoring"]


async def add_source(http, url: str, **over) -> dict:
    response = await http.post(
        "/api/monitoring/sources", json={"type": "prometheus", "reach": "url", "url": url} | over
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_setup_creates_project_sources_and_links_at_once(
    monitoring_app, fake_prometheus, fake_loki
):
    http, _ = monitoring_app
    shared = await add_source(http, fake_loki.url, type="loki", name="Loki · shared")
    body = {
        "name": "Shop",
        "kind": "custom",
        "cluster_id": None,
        "sources": [
            {
                "source": {
                    "type": "prometheus",
                    "reach": "url",
                    "url": fake_prometheus.url,
                    "name": "Shop metrics",
                    "auth": {"type": "bearer", "token": "tok-SECRET-9"},
                },
                "filter": 'cluster="a"',
                "origin": "auto",
            },
            {"source_id": shared["id"], "filter": '{namespace = "shop"}'},
            {"source": {"type": "loki", "reach": "url", "url": "http://loki.example:3100"}},
        ],
    }
    response = await http.post(SETUP, json=body)
    assert response.status_code == 201, response.text
    project = response.json()
    assert project["name"] == "Shop" and project["kind"] == "custom"
    assert project["cluster_id"] is None and project["cluster_name"] is None
    assert project["group_ids"] == []
    links = project["links"]
    assert [link["source_name"] for link in links] == [
        "Shop metrics",
        "Loki · shared",
        "Loki · loki.example",
    ]
    assert [link["source_type"] for link in links] == ["prometheus", "loki", "loki"]
    assert [link["filter"] for link in links] == ['cluster="a"', 'namespace="shop"', ""]
    assert [link["filter_origin"] for link in links] == ["auto", "user", "user"]
    assert [link["created_by_project"] for link in links] == [True, False, True]
    assert links[1]["source_id"] == shared["id"]

    sources = {s["name"]: s for s in (await http.get("/api/monitoring/sources")).json()}
    assert sources["Shop metrics"]["created_by_project_id"] == project["id"]
    assert sources["Loki · loki.example"]["created_by_project_id"] == project["id"]
    assert sources["Loki · shared"]["created_by_project_id"] is None
    assert sources["Shop metrics"]["auth"]["has_token"] is True
    assert (await http.get(f"/api/monitoring/projects/{project['id']}")).json() == project

    records = (await monitoring_records(http))[1:]  # after the shared source's own record
    assert [(r["action"], r["kind"], r["name"], r["outcome"]) for r in records] == [
        ("project_add", "project", "Shop", "succeeded"),
        ("source_add", "source", "Shop metrics", "succeeded"),
        ("source_add", "source", "Loki · loki.example", "succeeded"),
    ]
    assert records[0]["details"] == {
        "kind": "custom",
        "cluster": None,
        "sources": ["Shop metrics", "Loki · shared", "Loki · loki.example"],
        "created_sources": ["Shop metrics", "Loki · loki.example"],
    }
    assert records[1]["details"]["auth"] == "bearer"
    assert "tok-SECRET-9" not in (await http.get("/api/audit")).text


async def test_setup_is_all_or_nothing(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    await add_source(http, fake_prometheus.url, name="Taken")
    body = {
        "name": "Shop",
        "kind": "docker",
        "cluster_id": None,
        "sources": [
            {"source": {"type": "prometheus", "reach": "url", "url": "http://a.example"}},
            {
                "source": {
                    "type": "loki",
                    "reach": "url",
                    "url": "http://b.example",
                    "name": "Taken",
                }
            },
        ],
    }
    response = await http.post(SETUP, json=body)
    assert response.status_code == 409
    assert response.json() == {
        "detail": 'A source named "Taken" already exists. Pick another name.'
    }
    assert (await http.get("/api/monitoring/projects")).json() == []
    assert [s["name"] for s in (await http.get("/api/monitoring/sources")).json()] == ["Taken"]
    records = (await monitoring_records(http))[1:]
    assert [(r["action"], r["name"], r["outcome"]) for r in records] == [
        ("project_add", "Shop", "failed"),
        ("source_add", "Prometheus · a.example", "failed"),
        ("source_add", "Taken", "failed"),
    ]

    # A project name that is taken stores nothing either.
    first = await http.post(SETUP, json=body | {"sources": []})
    assert first.status_code == 201
    again = await http.post(SETUP, json=body | {"sources": body["sources"][:1]})
    assert again.status_code == 409
    assert again.json() == {"detail": 'A project named "Shop" already exists. Pick another name.'}
    assert [s["name"] for s in (await http.get("/api/monitoring/sources")).json()] == ["Taken"]
    assert len((await http.get("/api/monitoring/projects")).json()) == 1


async def test_setup_gives_new_sources_distinct_default_names(monitoring_app):
    http, _ = monitoring_app
    new = {"source": {"type": "prometheus", "reach": "url", "url": "http://p.example"}}
    response = await http.post(
        SETUP, json={"name": "Shop", "kind": "servers", "cluster_id": None, "sources": [new, new]}
    )
    assert response.status_code == 201, response.text
    assert [link["source_name"] for link in response.json()["links"]] == [
        "Prometheus · p.example",
        "Prometheus · p.example (2)",
    ]


async def test_setup_refuses_bad_input_before_anything_is_audited(monitoring_app):
    http, _ = monitoring_app
    base = {"name": "Shop", "kind": "custom", "cluster_id": None, "sources": []}
    new = {"type": "prometheus", "reach": "url", "url": "http://p.example"}
    refusals = [
        (base | {"kind": "kubernetes"}, CLUSTER_NEEDED),
        (base | {"kind": "kubernetes", "cluster_id": "no-such-cluster"}, CLUSTER_NEEDED),
        (base | {"sources": [{"filter": ""}]}, ONE_SOURCE),
        (base | {"sources": [{"source_id": "x", "source": new}]}, ONE_SOURCE),
        (base | {"sources": [{"source": new, "filter": "cluster=prod"}]}, BAD_FILTER),
        (base | {"sources": [{"source": new | {"url": "http://u:p@p.example"}}]}, None),
        (
            base | {"sources": [{"source_id": "gone"}]},
            "One of the chosen sources no longer exists. Reload and pick again.",
        ),
        (base | {"name": "  "}, "Names are 1 to 80 characters, without line breaks."),
    ]
    for body, detail in refusals:
        response = await http.post(SETUP, json=body)
        assert response.status_code == 422, (body, response.text)
        if detail is not None:
            assert response.json() == {"detail": detail}, body
    assert await monitoring_records(http) == []
    assert (await http.get("/api/monitoring/projects")).json() == []


async def test_setup_refuses_the_same_source_twice(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    source = await add_source(http, fake_prometheus.url)
    twice = [{"source_id": source["id"]}, {"source_id": source["id"], "filter": 'a="b"'}]
    response = await http.post(
        SETUP, json={"name": "Shop", "kind": "custom", "cluster_id": None, "sources": twice}
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "Each source can be linked to a project only once."}


async def test_projects_are_never_created_automatically(monitoring_app, kube_cluster):
    http, _ = monitoring_app
    assert (await http.get("/api/monitoring/projects")).json() == []
    tree = (await http.get("/api/monitoring/tree")).json()
    assert tree == {"projects": [], "groups": [], "source_count": 0}
