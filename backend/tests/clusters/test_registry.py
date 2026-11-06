import pytest

from tests.clusters.test_kubeconfig import kc


async def test_reimport_is_idempotent_and_updates_credentials(registry):
    text = kc([("aks-prod-weu", "https://p.hcp.westeurope.azmk8s.io", None)])
    first = await registry.upsert_from_kubeconfig(text, rewrite_loopback=False)
    second = await registry.upsert_from_kubeconfig(text.replace("token: t", "token: t2"), rewrite_loopback=False)
    assert [c.id for c in first] == [c.id for c in second]
    assert len(await registry.list()) == 1
    assert (await registry.get_kubeconfig(first[0].id))["users"][0]["user"]["token"] == "t2"


async def test_list_orders_production_first(registry):
    await registry.upsert_from_kubeconfig(
        kc([("a-dev", "https://a", None), ("z-prod", "https://z", None)]), rewrite_loopback=False
    )
    assert [c.name for c in await registry.list()] == ["z-prod", "a-dev"]


async def test_get_unknown_raises_key_error(registry):
    with pytest.raises(KeyError):
        await registry.get("nope")
    with pytest.raises(KeyError):
        await registry.get_kubeconfig("nope")
