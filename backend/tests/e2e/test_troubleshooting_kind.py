"""The troubleshooting flows against the real kind cluster `omnikrux-dev` (scripts/dev-kind.sh):
describe, logs, shells, debug containers and node shells, through the real app in-process."""

from urllib.parse import urlencode

import pytest

from tests.e2e.support import Reader, kubectl, wait_for

pytestmark = pytest.mark.kind

NODE_SHELL_LABEL = "omnikrux.dev/node-shell=true"


def logs_url(cluster: str, **params) -> str:
    return "/api/logs?" + urlencode({"cluster": cluster, "namespace": "demo", **params})


def exec_url(cluster: str, **params) -> str:
    return "/api/exec?" + urlencode({"cluster": cluster, "namespace": "demo", **params})


def log_lines(messages: list[dict]) -> list[dict]:
    return [line for m in messages if m["type"] == "lines" for line in m["lines"]]


def ended(message: dict) -> bool:
    return message["type"] == "closed" or message.get("state") in ("ended", "error")


def test_describe_oom_pod_shows_oomkilled(client, cluster):
    def oom_killed():
        body = client.get(f"/api/clusters/{cluster}/pods/demo/oom/describe").json()
        container = body["containers"][0]
        return body if "OOMKilled" in f"{container['state']} {container['last_state']}" else None

    body = wait_for(oom_killed, "the oom container to be OOMKilled", timeout=120)
    container = body["containers"][0]
    assert container["limits"]["memory"] == "32Mi"
    assert "memory" in container["limit_hit"]


def test_previous_logs_of_crasher_contain_boom(client, cluster):
    # The previous run exists once the container has crashed at least once.
    restarts = "jsonpath={.status.containerStatuses[0].restartCount}"
    wait_for(
        lambda: kubectl("-n", "demo", "get", "pod", "crasher", "-o", restarts) not in ("", "0"),
        "crasher to restart",
    )
    url = logs_url(cluster, pod="crasher", container="crasher", previous="true", follow="false")

    def previous_text() -> list[str] | None:
        # For about 70 s after each restart (the kubelet's 1-minute container GC) the pod's last
        # state names a container that is already removed, and the kubelet answers "unable to
        # retrieve container logs" (kubectl logs --previous too), sometimes as a log line
        # in a successful response rather than an error status. Ask again in either case.
        with client.websocket_connect(url) as ws:
            messages = Reader(ws).until(ended, "the previous logs to end")
        if any(m.get("state") == "error" for m in messages):
            return None
        texts = [line.get("text") for line in log_lines(messages)]
        if any(
            text.startswith("unable to retrieve container logs for containerd://") for text in texts
        ):
            return None
        return texts

    texts = wait_for(previous_text, "the previous logs of crasher", timeout=120, interval=1)
    assert "boom" in texts


def test_follow_logger_receives_ticks(client, cluster):
    with client.websocket_connect(logs_url(cluster, pod="logger", follow="true")) as ws:
        seen: list[dict] = []

        def enough(message):
            seen.append(message)
            return sum(str(ln.get("text", "")).startswith("tick ") for ln in log_lines(seen)) >= 3

        Reader(ws).until(enough, "three ticks")
    assert seen[0] == {"type": "status", "state": "streaming", "message": None}


def test_selector_logs_for_web_label(client, cluster):
    url = logs_url(cluster, selector="app=web", follow="false", tail_lines="5")
    with client.websocket_connect(url) as ws:
        messages = Reader(ws).until(ended, "the selector logs to end")
    assert not any(m.get("state") == "error" for m in messages), messages
    lines = [ln for ln in log_lines(messages) if "text" in ln]
    listed = kubectl("-n", "demo", "get", "pods", "-l", "app=web", "-o", "name").split()
    expected = {name.removeprefix("pod/") for name in listed}
    assert len(expected) >= 2
    assert {ln["pod"] for ln in lines} == expected  # every web pod contributes, tagged by name
    assert {ln["container"] for ln in lines} == {"nginx"}


def run_shell(client, url: str, script: list[str]) -> tuple[str, dict]:
    """Open the exec socket, send each script line, return all output and the final message."""
    with client.websocket_connect(url) as ws:
        for text in script:
            ws.send_json({"type": "stdin", "data": text})
        messages = Reader(ws).until(
            lambda m: m["type"] in ("exit", "error", "closed"), "the shell to end"
        )
    output = "".join(m["data"] for m in messages if m["type"] in ("stdout", "stderr"))
    return output, messages[-1]


def test_exec_echo_in_web_pod(client, cluster):
    pod = kubectl(
        "-n", "demo", "get", "pods", "-l", "app=web", "--field-selector=status.phase=Running",
        "-o", "jsonpath={.items[0].metadata.name}",
    )  # fmt: skip
    assert pod, "no running web pod"
    output, last = run_shell(
        client,
        exec_url(cluster, pod=pod, container="nginx"),
        ["echo omnikrux-$((6*7))\n", "exit\n"],
    )
    assert "omnikrux-42" in output  # computed: a typed-in echo of the command is not enough
    assert last["type"] == "exit" and last["code"] == 0, last


def test_exec_command_that_cannot_run_says_why(client, cluster):
    """What a distroless image does to the default shell: the runtime can't start the command.
    The reason is kept and the browser is told, so it can offer a debug container."""
    pod = kubectl(
        "-n", "demo", "get", "pods", "-l", "app=web", "--field-selector=status.phase=Running",
        "-o", "jsonpath={.items[0].metadata.name}",
    )  # fmt: skip
    assert pod, "no running web pod"
    url = exec_url(cluster, pod=pod, container="nginx", command="/no/such/shell")
    _, last = run_shell(client, url, [])
    assert last["type"] == "exit" and last["cannot_run"] is True, last
    assert "no such file" in last["message"].lower(), last
    assert "Traceback" not in last["message"]


def test_exec_into_crasher_gives_plain_message(client, cluster):
    # Wait for a moment when crasher is between runs, so the refusal is deterministic.
    state = "jsonpath={.status.containerStatuses[0].state}"
    wait_for(
        lambda: "running" not in kubectl("-n", "demo", "get", "pod", "crasher", "-o", state),
        "crasher to be waiting or terminated",
        interval=0.2,
    )
    url = exec_url(cluster, pod="crasher", container="crasher")
    with client.websocket_connect(url) as ws:
        messages = Reader(ws).until(
            lambda m: m["type"] in ("error", "exit", "closed"), "the shell to be refused"
        )
    last = messages[-1]
    assert last["type"] == "error", messages
    assert "debug container" in last["message"]
    assert "Traceback" not in last["message"] and "{" not in last["message"]


def test_debug_container_into_crasher_runs_shell(client, cluster):
    response = client.post(
        f"/api/clusters/{cluster}/pods/demo/crasher/debug", json={"target": "crasher"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["container"]
    assert body["target"] in ("crasher", None)  # None: crasher wasn't running just then
    url = exec_url(cluster, pod="crasher", container=body["container"])
    output, last = run_shell(client, url, ["echo debug-$((6*7))\n", "exit\n"])
    assert "debug-42" in output  # computed: a typed-in echo of the command is not enough
    assert last["type"] == "exit" and last["code"] == 0, last


def node_shell_pod_present(namespace: str, pod: str) -> bool:
    """Whether this node-shell pod is still listed (the listing itself must succeed)."""
    listed = kubectl("-n", namespace, "get", "pods", "-l", NODE_SHELL_LABEL, "-o", "name")
    return f"pod/{pod}" in listed.split()


def test_node_shell_runs_hostname_and_cleans_up(client, cluster):
    node = kubectl("get", "nodes", "-o", "jsonpath={.items[0].metadata.name}")
    assert node
    response = client.post(f"/api/clusters/{cluster}/nodes/{node}/shell")
    assert response.status_code == 200, response.text
    shell = response.json()
    try:
        url = exec_url(
            cluster,
            namespace=shell["namespace"],
            pod=shell["pod"],
            container=shell["container"],
            cleanup_pod="true",
        )
        output, last = run_shell(client, url, ["hostname\n", "exit\n"])
        assert node in output  # the node's hostname, not the pod's
        assert last["type"] == "exit" and last["code"] == 0, last
        wait_for(
            lambda: not node_shell_pod_present(shell["namespace"], shell["pod"]),
            f"node-shell pod {shell['pod']} to be gone",
            timeout=30,
        )
    finally:
        kubectl(
            "-n", shell["namespace"], "delete", "pod", shell["pod"], "--wait=false",
            "--ignore-not-found",
        )  # fmt: skip
