import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from omnikrux.clusters.kubeconfig import parse_kubeconfig
from omnikrux.kube.client import make_api_client
from omnikrux.kube.source import KubeResourceSource
from omnikrux.resources.kinds import KINDS

pytestmark = pytest.mark.kind

CONTEXT = "kind-omnikrux-dev"
REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "scripts" / "fixtures" / "workloads.yaml"


def find_kind() -> str | None:
    """kind on PATH, else the repo's pinned copy in .tools/ (where scripts/dev-kind.sh finds it)."""
    if found := shutil.which("kind"):
        return found
    for candidate in (REPO / ".tools" / "kind.exe", REPO / ".tools" / "kind"):
        if candidate.is_file():
            return str(candidate)
    return None


@pytest.fixture
async def api():
    if (kind := find_kind()) is None:
        pytest.skip("kind is not installed")
    text = await asyncio.to_thread(
        subprocess.run,
        [kind, "get", "kubeconfig", "--name", "omnikrux-dev"],
        check=False,
        capture_output=True,
        text=True,
    )
    if text.returncode != 0:
        pytest.skip("kind cluster omnikrux-dev not running (scripts/dev-kind.sh)")
    client = await make_api_client(
        parse_kubeconfig(text.stdout, rewrite_loopback=False)[0].standalone
    )
    yield client
    await client.close()


async def test_lists_fixture_pods(api):
    items, rv = await KubeResourceSource(api, KINDS["pods"]).list()
    names = {i["metadata"]["name"] for i in items if i["metadata"]["namespace"] == "demo"}
    assert {"crasher", "stuck"} <= names and rv


def kubectl(*args: str) -> None:
    subprocess.run(
        ["kubectl", "--context", CONTEXT, *args], check=True, capture_output=True, text=True
    )


async def test_watch_sees_pod_deletion(api):
    if shutil.which("kubectl") is None:
        pytest.skip("kubectl is not installed")
    source = KubeResourceSource(api, KINDS["pods"])
    _, rv = await source.list()
    events = source.watch(rv)

    async def stuck_event():
        async for event in events:
            md = event.object["metadata"]
            if (md["namespace"], md["name"]) == ("demo", "stuck") and event.type in (
                "MODIFIED",
                "DELETED",
            ):
                return event

    try:
        await asyncio.to_thread(kubectl, "delete", "pod", "-n", "demo", "stuck", "--wait=false")
        event = await asyncio.wait_for(stuck_event(), 30)
        assert isinstance(event.object, dict) and event.object["kind"] == "Pod"
    finally:
        await events.aclose()
        await asyncio.to_thread(
            kubectl, "wait", "--for=delete", "pod/stuck", "-n", "demo", "--timeout=60s"
        )
        await asyncio.to_thread(kubectl, "apply", "-f", str(FIXTURES))
