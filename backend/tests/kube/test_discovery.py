"""discover() against the fake API server: what each cluster serves, and what it can't say."""

import logging
import time

import pytest
from aiohttp import web

from omnikrux.kube.client import ClusterUnavailable, make_api_client
from omnikrux.kube.discovery import ApiResource, discover
from tests.fakekube import VERSION, FakeResource, kubeconfig_for


@pytest.fixture
async def api(fake_api):
    client = await make_api_client(kubeconfig_for(fake_api))
    yield client
    await client.close()


def by_key(discovery) -> dict[tuple[str, str], ApiResource]:
    return {(r.group, r.plural): r for r in discovery.resources}


async def test_discovery_reads_version_and_tolerates_failure(api, fake_api, monkeypatch):
    initial = await discover(api)
    assert initial.version == VERSION["gitVersion"]
    route = fake_api._route

    async def broken_version(request):
        if request.path == "/version":
            return web.Response(status=403, text="untrusted version response")
        return await route(request)

    monkeypatch.setattr(fake_api, "_route", broken_version)
    result = await discover(api)
    assert result.version is None and result.resources == initial.resources
    assert result.failed_groups == {}


async def test_discovery_lists_core_and_group_resources(api, fake_api):
    found = by_key(await discover(api))
    assert found[("", "pods")] == ApiResource(
        group="",
        version="v1",
        plural="pods",
        kind="Pod",
        namespaced=True,
        verbs=frozenset({"create", "delete", "get", "list", "patch", "update", "watch"}),
        short_names=("po",),
    )
    assert found[("", "nodes")].namespaced is False
    assert found[("apps", "deployments")].version == "v1"
    assert found[("apps", "deployments")].short_names == ("deploy",)
    assert found[("batch", "cronjobs")].kind == "CronJob"
    assert found[("example.omnikrux.dev", "widgets")].kind == "Widget"
    assert ("", "secrets") in found and (
        "apiextensions.k8s.io",
        "customresourcedefinitions",
    ) in found
    assert {"/api/v1", "/apis", "/apis/apps/v1"} <= set(fake_api.paths)


async def test_discovery_reads_each_groups_preferred_version_only(api, fake_api):
    fake_api.resources.append(FakeResource("example.omnikrux.dev", "v2", "gadgets", "Gadget", True))
    found = by_key(await discover(api))
    assert ("example.omnikrux.dev", "gadgets") not in found  # v2 isn't preferred
    assert "/apis/example.omnikrux.dev/v2" not in fake_api.paths


async def test_discovery_skips_subresources_and_unwatchable(api, fake_api):
    fake_api.resources.append(
        FakeResource("example.omnikrux.dev", "v1", "reviews", "Review", False, ("create",))
    )
    fake_api.resources.append(
        FakeResource("example.omnikrux.dev", "v1", "listonly", "ListOnly", True, ("get", "list"))
    )
    found = by_key(await discover(api))
    plurals = {plural for _, plural in found}
    assert not [p for p in plurals if "/" in p]  # pods/log, pods/exec, deployments/scale
    assert "bindings" not in plurals  # create only
    assert "reviews" not in plurals and "listonly" not in plurals
    assert "widgets" in plurals


async def test_one_broken_api_group_does_not_hide_the_others(api, fake_api):
    fake_api.broken_groups = {"example.omnikrux.dev"}
    discovery = await discover(api)
    found = by_key(discovery)
    assert ("example.omnikrux.dev", "widgets") not in found
    assert ("apps", "deployments") in found and ("", "pods") in found
    assert list(discovery.failed_groups) == ["example.omnikrux.dev"]
    message = discovery.failed_groups["example.omnikrux.dev"]
    assert message == (
        "The example.omnikrux.dev API didn't answer (503: the server is currently unable to "
        "handle the request); its kinds are hidden until it does."
    )


async def test_discovery_401_plain_message(api, fake_api):
    fake_api.mode = "unauthorized"
    with pytest.raises(ClusterUnavailable) as info:
        await discover(api)
    assert info.value.message == "The cluster rejected the console's credentials: Unauthorized"


async def test_discovery_403_plain_message(api, fake_api):
    fake_api.mode = "forbidden"
    with pytest.raises(ClusterUnavailable) as info:
        await discover(api)
    assert info.value.message.startswith("Not allowed to read the cluster's API list: ")


async def test_unexpected_discovery_answer_is_a_plain_cluster_unavailable(api, fake_api):
    fake_api.mode = "apis_unexpected"  # /apis answers 200 with something that isn't a group list
    with pytest.raises(ClusterUnavailable) as info:
        await discover(api)
    assert (
        info.value.message
        == "The cluster's API discovery failed: it answered with something unexpected"
    )


async def test_a_silent_api_times_out_within_the_bound(api, fake_api):
    fake_api.mode = "hang"
    started = time.monotonic()
    with pytest.raises(ClusterUnavailable) as info:
        await discover(api, timeout=0.5)
    assert time.monotonic() - started < 5
    assert info.value.message == "The cluster API did not respond within 0.5 s"


async def test_crd_printer_columns_read(api, fake_api):
    discovery = await discover(api)
    assert discovery.printer_columns[("example.omnikrux.dev", "widgets")] == [
        {"name": "Size", "type": "integer", "jsonPath": ".spec.size"},
        {"name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp"},
    ]


async def test_crd_list_refused_keeps_generic_columns(api, fake_api):
    fake_api.forbidden_kinds.add("customresourcedefinitions.apiextensions.k8s.io")
    discovery = await discover(api)
    assert discovery.printer_columns == {}
    assert ("example.omnikrux.dev", "widgets") in by_key(discovery)
    assert discovery.failed_groups == {}


async def test_hanging_groups_are_bounded_by_one_deadline(api, fake_api):
    # More hanging groups than run at once, plus a hanging CRD list: the whole discovery still
    # ends within its one deadline, with every other kind present.
    slow = [f"g{n}.example.dev" for n in range(10)]
    fake_api.resources += [FakeResource(g, "v1", "things", "Thing", True) for g in slow]
    fake_api.hanging_groups = {*slow, "apiextensions.k8s.io"}
    started = time.monotonic()
    discovery = await discover(api, timeout=0.5)
    assert time.monotonic() - started < 0.9
    found = by_key(discovery)
    assert ("apps", "deployments") in found and ("example.omnikrux.dev", "widgets") in found
    assert set(discovery.failed_groups) == {*slow, "apiextensions.k8s.io"}
    assert discovery.failed_groups["g0.example.dev"] == (
        "The g0.example.dev API didn't answer within 0.5 s; its kinds are hidden until it does."
    )
    assert discovery.printer_columns == {}


async def test_an_unexpected_error_in_one_group_is_only_that_groups(api, monkeypatch, caplog):
    from omnikrux.kube import discovery as discovery_mod

    real = discovery_mod._resources

    def resources(group, version, body):
        if group == "batch":
            raise KeyError("surprise")
        return real(group, version, body)

    monkeypatch.setattr(discovery_mod, "_resources", resources)
    with caplog.at_level(logging.WARNING, logger="omnikrux.kube.discovery"):
        discovery = await discover(api)
    assert discovery.failed_groups == {
        "batch": "The batch API couldn't be read (KeyError); its kinds are hidden until it does."
    }
    assert ("apps", "deployments") in by_key(discovery)
    [record] = caplog.records
    assert "batch" in record.getMessage() and "KeyError" in record.getMessage()


async def test_crd_items_that_are_not_a_list_keep_generic_columns(api, monkeypatch):
    from omnikrux.kube import discovery as discovery_mod

    real = discovery_mod._get

    async def get(api, path, timeout=30, *, cloud=False):
        if path == discovery_mod.CRDS_PATH:
            return {"items": 5}
        return await real(api, path, timeout, cloud=cloud)

    monkeypatch.setattr(discovery_mod, "_get", get)
    discovery = await discover(api)
    assert discovery.printer_columns == {}
    assert ("example.omnikrux.dev", "widgets") in by_key(discovery)
