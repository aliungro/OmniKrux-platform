"""KindCatalog: what each cluster serves, cached per cluster, and the union for GET /api/kinds."""

import asyncio
import dataclasses

import httpx
import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.kube.client import ClusterUnavailable
from omnikrux.kube.connections import ClusterConnections
from omnikrux.main import create_app
from omnikrux.resources import catalog as catalog_mod
from omnikrux.resources.catalog import KindCatalog, KindNotServed
from omnikrux.resources.kinds import HELM_RELEASES, KINDS, is_kind_key, kind_key
from tests.conftest import _cluster
from tests.fakekube import kubeconfig_for, serve_fake_api

WIDGETS = "widgets.example.omnikrux.dev"


class Registry:
    """Both halves the catalog needs: `list()` (for the union) and kubeconfigs (for connections)."""

    def __init__(self, servers: dict):
        self.servers = servers

    async def list(self):
        return [_cluster(cid) for cid in self.servers]

    async def get_kubeconfig(self, cluster_id):
        return kubeconfig_for(self.servers[cluster_id])


def catalog_for(servers: dict, **kwargs) -> KindCatalog:
    registry = Registry(servers)
    return KindCatalog(ClusterConnections(registry), registry, **kwargs)


def discoveries(server) -> int:
    return server.paths.count("/apis")


def test_kind_key_rules():
    assert kind_key("", "pods") == "pods"
    assert kind_key("apps", "deployments") == "deployments.apps"
    assert kind_key("example.omnikrux.dev", "widgets") == WIDGETS
    for key in ("pods", "deployments.apps", WIDGETS, HELM_RELEASES):
        assert is_kind_key(key), key
    for key in (
        "Deployments",
        "",
        "pods/log",
        "a..b",
        ".pods",
        "pods.",
        "x" * 254,
        "po ds",
        "pods\n",
    ):
        assert not is_kind_key(key), key


async def test_union_lists_clusters_serving_each_kind():
    async with serve_fake_api() as one, serve_fake_api() as two:
        two.resources = [r for r in two.resources if r.group != "example.omnikrux.dev"]
        catalog = catalog_for({"one": one, "two": two})
        out = await catalog.union()
    kinds = {k.key: k for k in out.kinds}
    assert kinds[WIDGETS].clusters == ["one"]
    assert kinds["pods"].clusters == ["one", "two"]
    assert kinds["deployments.apps"].clusters == ["one", "two"]
    assert out.clusters["one"].state == out.clusters["two"].state == "ok"
    assert out.clusters["one"].message is None and out.clusters["one"].failed_groups == {}

    pods = kinds["pods"]
    assert pods.builtin is True and pods.kind == "Pod" and pods.short_names == ["po"]
    assert "watch" in pods.verbs and pods.verbs == sorted(pods.verbs)
    assert pods.verbs_by_cluster == {"one": pods.verbs, "two": pods.verbs}
    assert pods.columns[0].key == "name"
    widget = kinds[WIDGETS]
    assert widget.builtin is False
    assert (widget.group, widget.version, widget.plural, widget.kind) == (
        "example.omnikrux.dev",
        "v1",
        "widgets",
        "Widget",
    )
    assert widget.label == "Widget" and widget.plural_label == "widgets"
    assert [c.key for c in widget.columns] == ["name", "namespace", "pc_size", "age"]
    assert [c.type for c in widget.columns] == ["text", "text", "number", "age"]
    nodes = kinds["nodes"]
    assert nodes.namespaced is False and nodes.columns[0].key == "name"
    # Curated kinds first (in KINDS order), then by label.
    keys = [k.key for k in out.kinds]
    curated = [k for k in KINDS if k in kinds]
    assert keys[: len(curated)] == curated
    labels = [k.label for k in out.kinds[len(curated) :]]
    assert labels == sorted(labels)
    assert "pods/log" not in kinds and "bindings" not in kinds


async def test_spec_for_absent_kind_raises_not_served(fake_api):
    fake_api.resources = [r for r in fake_api.resources if r.group != "example.omnikrux.dev"]
    catalog = catalog_for({"c1": fake_api})
    with pytest.raises(KindNotServed) as info:
        await catalog.spec("c1", WIDGETS)
    assert info.value.message == f"This cluster doesn't serve {WIDGETS}."
    with pytest.raises(KeyError):
        await catalog.spec("unknown", "pods")
    spec = await catalog.spec("c1", "pods")
    assert spec.to_row is KINDS["pods"].to_row and "watch" in spec.verbs


async def test_spec_raises_cluster_unavailable_and_does_not_cache_it(fake_api):
    catalog = catalog_for({"c1": fake_api})
    fake_api.mode = "unauthorized"
    with pytest.raises(ClusterUnavailable):
        await catalog.spec("c1", "pods")
    fake_api.mode = "ok"
    assert (await catalog.spec("c1", "pods")).key == "pods"


async def test_discovery_cached_for_ttl_and_refreshed(fake_api):
    catalog = catalog_for({"c1": fake_api}, ttl=0.2)
    first = await catalog.cluster("c1")
    assert await catalog.cluster("c1") is first and discoveries(fake_api) == 1
    await catalog.spec("c1", "pods")
    assert discoveries(fake_api) == 1
    refreshed = await catalog.cluster("c1", refresh=True)
    assert refreshed is not first and discoveries(fake_api) == 2
    await asyncio.sleep(0.3)
    await catalog.cluster("c1")
    assert discoveries(fake_api) == 3
    catalog.forget("c1")
    await catalog.cluster("c1")
    assert discoveries(fake_api) == 4


async def test_concurrent_lookups_share_one_discovery(fake_api):
    catalog = catalog_for({"c1": fake_api})
    results = await asyncio.gather(
        catalog.cluster("c1"),
        catalog.spec("c1", "pods"),
        catalog.spec("c1", WIDGETS),
        catalog.union(),
    )
    assert discoveries(fake_api) == 1
    assert results[1].key == "pods" and results[2].key == WIDGETS


async def test_a_cancelled_lookup_does_not_cancel_the_shared_discovery(fake_api):
    fake_api.mode = "hang"
    catalog = catalog_for({"c1": fake_api})
    first = asyncio.create_task(catalog.cluster("c1"))
    second = asyncio.create_task(catalog.cluster("c1"))
    await asyncio.sleep(0.1)
    first.cancel()
    fake_api.mode = "ok"
    fake_api.release.set()
    kinds = await asyncio.wait_for(second, 5)
    assert "pods" in kinds.specs and discoveries(fake_api) == 1


async def test_curated_kind_takes_the_clusters_verbs_and_helm_follows_secrets(
    fake_api, monkeypatch
):
    helm = dataclasses.replace(
        KINDS["pods"], key=HELM_RELEASES, plural="secrets", kind="Secret", label="Helm release"
    )
    monkeypatch.setitem(catalog_mod.KINDS, HELM_RELEASES, helm)
    fake_api.resources = [
        dataclasses.replace(r, verbs=("get", "list", "watch")) if r.plural == "pods" else r
        for r in fake_api.resources
    ]
    catalog = catalog_for({"c1": fake_api})
    assert (await catalog.spec("c1", "pods")).verbs == frozenset({"get", "list", "watch"})
    helm_spec = await catalog.spec("c1", HELM_RELEASES)
    assert helm_spec.verbs == frozenset(
        {"get", "list", "watch"}
    )  # read-only, whatever secrets allow
    fake_api.resources = [r for r in fake_api.resources if r.plural != "secrets"]
    catalog.forget("c1")
    with pytest.raises(KindNotServed):
        await catalog.spec("c1", HELM_RELEASES)


async def test_failed_groups_reported_per_cluster(fake_api):
    fake_api.broken_groups = {"example.omnikrux.dev"}
    out = await catalog_for({"c1": fake_api}).union()
    assert list(out.clusters["c1"].failed_groups) == ["example.omnikrux.dev"]
    assert WIDGETS not in {k.key for k in out.kinds}


async def test_kinds_route_lists_union_and_cluster_errors(tmp_path):
    async with serve_fake_api() as good, serve_fake_api() as refusing:
        refusing.mode = "unauthorized"
        app = create_app(
            Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
        )
        async with app.router.lifespan_context(app):
            ids = {}
            for name, server in (("good", good), ("refusing", refusing)):
                config = kubeconfig_for(server)
                config["contexts"][0]["name"] = config["current-context"] = name
                [info] = await app.state.registry.upsert_from_kubeconfig(
                    yaml.safe_dump(config), rewrite_loopback=False, source=SOURCE_UPLOAD
                )
                ids[name] = info.id
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
                r = await http.get("/api/kinds")
                assert r.status_code == 200
                body = r.json()
                assert body["clusters"][ids["good"]] == {
                    "state": "ok",
                    "message": None,
                    "failed_groups": {},
                }
                assert body["clusters"][ids["refusing"]] == {
                    "state": "error",
                    "message": "The cluster rejected the console's credentials: Unauthorized",
                    "failed_groups": {},
                }
                kinds = {k["key"]: k for k in body["kinds"]}
                assert kinds[WIDGETS]["clusters"] == [ids["good"]]
                assert set(kinds["pods"]) >= {
                    "key",
                    "group",
                    "version",
                    "kind",
                    "plural",
                    "label",
                    "namespaced",
                    "short_names",
                    "columns",
                    "sort",
                    "builtin",
                    "verbs",
                    "verbs_by_cluster",
                    "clusters",
                }
                assert kinds["pods"]["columns"][0] == {
                    "key": "name",
                    "label": "Name",
                    "type": "text",
                    "width": "l",
                }
                before = discoveries(good)
                assert (await http.get("/api/kinds")).status_code == 200
                assert discoveries(good) == before  # cached
                assert (await http.get("/api/kinds?refresh=true")).status_code == 200
                assert discoveries(good) == before + 1


async def test_forget_cancels_an_inflight_discovery(fake_api):
    fake_api.mode = "hang"
    catalog = catalog_for({"c1": fake_api})
    waiter = asyncio.create_task(catalog.cluster("c1"))
    await asyncio.sleep(0.1)
    [inflight] = catalog._inflight.values()
    catalog.forget("c1")
    with pytest.raises(KeyError):  # forgotten while asked: as for a removed cluster
        await asyncio.wait_for(waiter, 2)
    await asyncio.sleep(0)
    assert inflight.cancelled() and catalog._inflight == {} and catalog._entries == {}


async def test_close_cancels_inflight_discoveries_and_drops_entries(fake_api):
    catalog = catalog_for({"c1": fake_api, "c2": fake_api})
    await catalog.cluster("c1")
    fake_api.mode = "hang"
    waiter = asyncio.create_task(catalog.cluster("c2"))
    await asyncio.sleep(0.1)
    [inflight] = catalog._inflight.values()
    await catalog.close()
    assert inflight.done() and catalog._inflight == {} and catalog._entries == {}
    with pytest.raises(KeyError):
        await asyncio.wait_for(waiter, 2)


async def test_a_cancelled_caller_is_still_cancelled(fake_api):
    fake_api.mode = "hang"
    catalog = catalog_for({"c1": fake_api})
    waiter = asyncio.create_task(catalog.cluster("c1"))
    await asyncio.sleep(0.1)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    await catalog.close()


async def test_app_shutdown_closes_the_catalog(fake_api, tmp_path):
    fake_api.mode = "hang"
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        waiter = asyncio.create_task(app.state.catalog.cluster(info.id))
        await asyncio.sleep(0.1)
        [inflight] = app.state.catalog._inflight.values()
    assert inflight.done() and app.state.catalog._inflight == {}
    with pytest.raises(KeyError):
        await waiter
