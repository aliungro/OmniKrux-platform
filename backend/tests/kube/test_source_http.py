"""KubeResourceSource against a real local HTTP server standing in for the Kubernetes API.

Unlike test_source.py, nothing here is mocked inside kubernetes_asyncio: discovery, the probe and
the list go through its real REST client, so timeouts and error mapping are exercised end to end.
"""

import time

import pytest

from omnikrux.kube.client import ClusterUnavailable
from tests.fakekube import POD, TOKEN, source_for


async def test_happy_path_lists_pods_through_real_discovery(fake_api):
    source = await source_for(fake_api)
    try:
        items, rv = await source.list()
    finally:
        await source.aclose()
    assert items == [POD] and rv == "42"
    assert fake_api.paths[0] == "/api"  # the probe runs before discovery
    assert "/api/v1/pods" in fake_api.paths
    assert fake_api.auth == {f"Bearer {TOKEN}"}


async def test_unauthorized_during_discovery_gives_the_credentials_message(fake_api):
    fake_api.mode = "unauthorized"
    source = await source_for(fake_api)
    try:
        with pytest.raises(ClusterUnavailable) as info:
            await source.list()
    finally:
        await source.aclose()
    assert info.value.message == "The cluster rejected the console's credentials: Unauthorized"


async def test_unexpected_discovery_answer_is_a_plain_cluster_unavailable(fake_api):
    fake_api.mode = "apis_unauthorized"  # the probe passes, discovery then trips over a Status body
    source = await source_for(fake_api)
    try:
        with pytest.raises(ClusterUnavailable) as info:
            await source.list()
    finally:
        await source.aclose()
    assert (
        info.value.message
        == "The cluster's API discovery failed: it answered with something unexpected"
    )
    assert "NoneType" not in info.value.message


async def test_a_silent_api_times_out_within_the_bound(fake_api):
    fake_api.mode = "hang"
    source = await source_for(fake_api, discovery_timeout=0.5)
    started = time.monotonic()
    try:
        with pytest.raises(ClusterUnavailable) as info:
            await source.list()
    finally:
        await source.aclose()
    assert time.monotonic() - started < 5
    assert info.value.message == "The cluster API did not respond within 0.5 s"
