"""KubeResourceSource against a real local HTTP server standing in for the Kubernetes API.

Unlike test_source.py, nothing here is mocked inside kubernetes_asyncio: the probe, the list and
the watch go through its real REST client. Discovery failures are tested in test_discovery.py.
"""

import asyncio
import dataclasses

from omnikrux.kube.client import make_api_client
from omnikrux.kube.discovery import ApiResource
from omnikrux.kube.source import KubeResourceSource
from omnikrux.resources.kinds import generic_spec
from tests.fakekube import POD, TOKEN, kubeconfig_for, source_for

WIDGETS = ApiResource(
    group="example.omnikrux.dev",
    version="v1",
    plural="widgets",
    kind="Widget",
    namespaced=True,
    verbs=frozenset({"get", "list", "watch"}),
    short_names=(),
)


def widget(name, ns="demo", labels=None):
    return {"metadata": {"name": name, "namespace": ns, "uid": f"u-{name}", "labels": labels or {}}}


async def test_happy_path_lists_pods(fake_api):
    source = await source_for(fake_api)
    try:
        items, rv = await source.list()
    finally:
        await source.aclose()
    assert items == [POD] and rv == "42"
    assert fake_api.paths[0] == "/api"  # the probe runs first
    assert "/api/v1/pods" in fake_api.paths
    assert fake_api.auth == {f"Bearer {TOKEN}"}


async def test_lists_and_watches_any_kind_with_its_label_selector(fake_api):
    widgets = fake_api.objects["widgets.example.omnikrux.dev"]
    widgets[("demo", "a")] = widget("a", labels={"app": "web"})
    widgets[("other", "b")] = widget("b", ns="other", labels={"app": "db"})
    spec = dataclasses.replace(generic_spec(WIDGETS, None), label_selector="app=web")
    source = KubeResourceSource(await make_api_client(kubeconfig_for(fake_api)), spec)
    try:
        items, rv = await source.list()
        assert [i["metadata"]["name"] for i in items] == ["a"] and rv == "42"
        events = source.watch(rv)
        event = await asyncio.wait_for(anext(events), 5)
        assert (event.type, event.object["metadata"]["name"]) == ("ADDED", "a")
        await events.aclose()
    finally:
        await source.aclose()
    lists = [q for m, p, q in fake_api.requests if p == "/apis/example.omnikrux.dev/v1/widgets"]
    assert [q.get("labelSelector") for q in lists] == ["app=web", "app=web"]
    assert lists[1]["watch"] == "true" and lists[1]["resourceVersion"] == "42"
