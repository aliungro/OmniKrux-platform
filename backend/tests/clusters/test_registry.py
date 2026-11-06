import logging

import pytest

from tests.clusters.test_kubeconfig import kc


async def test_reimport_is_idempotent_and_updates_credentials(registry):
    text = kc([("aks-prod-weu", "https://p.hcp.westeurope.azmk8s.io", None)])
    first = await registry.upsert_from_kubeconfig(text, rewrite_loopback=False, source="file")
    second = await registry.upsert_from_kubeconfig(
        text.replace("token: t", "token: t2"), rewrite_loopback=False, source="file"
    )
    assert [c.id for c in first] == [c.id for c in second]
    assert len(await registry.list()) == 1
    assert (await registry.get_kubeconfig(first[0].id))["users"][0]["user"]["token"] == "t2"


async def test_list_orders_production_first(registry):
    await registry.upsert_from_kubeconfig(
        kc([("a-dev", "https://a", None), ("z-prod", "https://z", None)]),
        rewrite_loopback=False,
        source="file",
    )
    assert [c.name for c in await registry.list()] == ["z-prod", "a-dev"]


async def test_get_unknown_raises_key_error(registry):
    with pytest.raises(KeyError):
        await registry.get("nope")
    with pytest.raises(KeyError):
        await registry.get_kubeconfig("nope")


async def test_original_server_is_stored_and_follows_reimport(registry):
    text = kc([("kind-dev", "https://127.0.0.1:6443", None)])
    [info] = await registry.upsert_from_kubeconfig(text, rewrite_loopback=True, source="file")
    assert info.server == "https://host.docker.internal:6443"
    assert info.original_server == "https://127.0.0.1:6443"
    assert (await registry.list())[0].original_server == "https://127.0.0.1:6443"
    assert (await registry.get(info.id)).original_server == "https://127.0.0.1:6443"
    [plain] = await registry.upsert_from_kubeconfig(
        kc([("lab", "https://k8s.lab:6443", None)]), rewrite_loopback=True, source="file"
    )
    assert plain.original_server is None


async def test_recreated_kind_cluster_updates_server_in_place(registry):
    [first] = await registry.upsert_from_kubeconfig(
        kc([("kind-dev", "https://127.0.0.1:41001", None)]), rewrite_loopback=False, source="file"
    )
    [second] = await registry.upsert_from_kubeconfig(
        kc([("kind-dev", "https://127.0.0.1:52002", None)]), rewrite_loopback=False, source="file"
    )
    [only] = await registry.list()
    assert second.id == first.id == only.id
    assert only.server == "https://127.0.0.1:52002"
    kubeconfig = await registry.get_kubeconfig(only.id)
    assert kubeconfig["clusters"][0]["cluster"]["server"] == "https://127.0.0.1:52002"


async def test_same_context_from_file_and_upload_are_separate_clusters(registry):
    text = kc([("kind-dev", "https://127.0.0.1:6443", None)])
    [file] = await registry.upsert_from_kubeconfig(text, rewrite_loopback=False, source="file")
    [upload] = await registry.upsert_from_kubeconfig(text, rewrite_loopback=False, source="upload")
    assert file.id != upload.id and len(await registry.list()) == 2


async def test_reconcile_removes_vanished_file_contexts_only(registry):
    files = await registry.upsert_from_kubeconfig(
        kc([("kept", "https://k", None), ("gone", "https://g", None)]),
        rewrite_loopback=False,
        source="file",
    )
    [upload] = await registry.upsert_from_kubeconfig(
        kc([("uploaded", "https://u", None)]), rewrite_loopback=False, source="upload"
    )
    gone_id = next(c.id for c in files if c.context_name == "gone")
    assert await registry.reconcile_files({"kept"}) == [gone_id]
    assert sorted(c.name for c in await registry.list()) == ["kept", "uploaded"]
    assert (await registry.get(upload.id)).name == "uploaded"
    assert await registry.reconcile_files({"kept"}) == []


async def test_delete_removes_the_cluster(registry):
    [info] = await registry.upsert_from_kubeconfig(
        kc([("lab", "https://k8s.lab:6443", None)]), rewrite_loopback=False, source="upload"
    )
    await registry.delete(info.id)
    assert await registry.list() == []
    with pytest.raises(KeyError):
        await registry.get(info.id)


async def test_delete_unknown_is_keyerror(registry):
    with pytest.raises(KeyError):
        await registry.delete("nope")


async def test_upload_of_a_known_context_on_another_server_conflicts(registry):
    from omnikrux.clusters.registry import ClusterConflict

    [original] = await registry.upsert_from_kubeconfig(
        kc([("lab", "https://lab-a:6443", None)]), rewrite_loopback=False, source="upload"
    )
    with pytest.raises(ClusterConflict) as caught:
        await registry.upsert_from_kubeconfig(
            kc([("other", "https://other:6443", None), ("lab", "https://lab-b:6443", None)]),
            rewrite_loopback=False,
            source="upload",
        )
    assert isinstance(caught.value, ValueError)
    assert str(caught.value) == (
        "A cluster called lab was already uploaded for https://lab-a:6443."
        " Delete it first to replace it."
    )
    # The whole upload is rejected: nothing from it is stored, the original is untouched.
    assert [(c.id, c.server) for c in await registry.list()] == [
        (original.id, "https://lab-a:6443")
    ]


async def test_upload_of_a_known_context_on_the_same_server_updates_in_place(registry):
    text = kc([("lab", "https://lab-a:6443", None)])
    [first] = await registry.upsert_from_kubeconfig(text, rewrite_loopback=False, source="upload")
    [second] = await registry.upsert_from_kubeconfig(
        text.replace("token: t", "token: t2"), rewrite_loopback=False, source="upload"
    )
    assert second.id == first.id and len(await registry.list()) == 1
    assert (await registry.get_kubeconfig(first.id))["users"][0]["user"]["token"] == "t2"


async def test_reconcile_logs_the_removed_context_names(registry, caplog):
    await registry.upsert_from_kubeconfig(
        kc([("kept", "https://k", None), ("gone", "https://g", None)]),
        rewrite_loopback=False,
        source="file",
    )
    with caplog.at_level(logging.WARNING, logger="omnikrux.clusters.registry"):
        await registry.reconcile_files({"kept"})
    [warning] = [r for r in caplog.records if r.name == "omnikrux.clusters.registry"]
    assert warning.levelno == logging.WARNING and "gone" in warning.getMessage()
    assert "kept" not in warning.getMessage()
