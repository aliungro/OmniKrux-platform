"""PortForwardChannel against the fake API's port-forward WebSocket."""

import asyncio

import pytest
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.kube.connections import ClusterConnections
from omnikrux.portforward.channel import ForwardError, PortForwardChannel
from tests.fakekube import kubeconfig_for
from tests.portforward.conftest import SECONDS, until

# What the kubelet's error channel says when nothing in the pod listens on the port.
KUBELET_REFUSED = (
    "error forwarding port 8080 to pod 3f1c, uid : failed to execute portforward in network "
    'namespace "/var/run/netns/cni-1": failed to connect to localhost:8080 inside namespace '
    '"3f1c", IPv4: dial tcp4 127.0.0.1:8080: connect: connection refused IPv6 dial tcp6 '
    "[::1]:8080: connect: connection refused "
)


class OneCluster:
    def __init__(self, fake):
        self.fake = fake

    async def get_kubeconfig(self, cluster_id: str) -> dict:
        if cluster_id != "c1":
            raise KeyError(cluster_id)
        return kubeconfig_for(self.fake)


def open_channel(fake, pod: str = "web-1", port: int = 8080, cluster: str = "c1"):
    connections = ClusterConnections(OneCluster(fake))
    return PortForwardChannel.open(connections, cluster, "demo", pod, port)


async def test_channel_strips_port_prefix_and_relays(fake_api):
    channel = await open_channel(fake_api)
    try:
        # Each channel opens with 8080 as two bytes (b"\x90\x1f"): never part of the data.
        await channel.write(b"hello")
        assert await asyncio.wait_for(channel.read(), SECONDS) == b"hello"
        await channel.write(b"again")
        assert await asyncio.wait_for(channel.read(), SECONDS) == b"again"
    finally:
        await channel.close()
    assert fake_api.forwards == [
        {"namespace": "demo", "pod": "web-1", "ports": [8080], "protocol": "v4.channel.k8s.io"}
    ]
    await until(lambda: fake_api.forwards_open == 0)
    await channel.close()  # safe to repeat


async def test_channel_error_frame_plain(fake_api):
    fake_api.forward_fail = KUBELET_REFUSED
    channel = await open_channel(fake_api)
    try:
        with pytest.raises(ForwardError) as refused:
            await asyncio.wait_for(channel.read(), SECONDS)
    finally:
        await channel.close()
    assert refused.value.message == (
        "Nothing in pod web-1 is listening on port 8080 (connection refused)."
    )

    fake_api.forward_fail = "the runtime said no"
    channel = await open_channel(fake_api)
    try:
        with pytest.raises(ForwardError) as failed:
            await asyncio.wait_for(channel.read(), SECONDS)
    finally:
        await channel.close()
    assert (
        failed.value.message
        == "The port-forward to pod web-1 port 8080 failed: the runtime said no"
    )


async def test_channel_open_refused_for_missing_pod_or_cluster(fake_api):
    with pytest.raises(ApiException) as missing:
        await open_channel(fake_api, pod="gone")
    assert missing.value.status == 404
    with pytest.raises(KeyError):
        await open_channel(fake_api, cluster="other")
