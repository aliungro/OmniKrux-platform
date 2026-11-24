"""The Helm runner and Helm's kubeconfig: arguments are only ever built here, credentials live in
one private file per call and leave with it, and nothing Helm says carries a secret out."""

import asyncio
import base64
import inspect
import json
import logging
import os
import stat
import sys
import time
from pathlib import Path

import pytest
import yaml

from omnikrux.kube.connections import ClusterConnections
from omnikrux.monitoring.install import helm as helm_module
from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.helm import (
    TIMEOUT_MARK,
    HelmResult,
    SubprocessHelm,
    helm_error_message,
    show_crds_args,
    template_args,
    timed_out,
    uninstall_args,
    upgrade_args,
    version_args,
)
from omnikrux.monitoring.install.kubeconfig import (
    helm_kubeconfig,
    hosts_of,
    kubeconfig_from_configuration,
    secrets_and_hosts,
    secrets_of,
)
from omnikrux.monitoring.install.pins import HELM_VERSION
from tests.fakekube import TOKEN, kubeconfig_for
from tests.kube.test_connections import FakeRegistry
from tests.monitoring.fake_helm import FakeHelm, pinned_tools
from tests.monitoring.fakes import make_tls_material

STUB = Path(__file__).with_name("helm_stub.py")
EXEC_PLUGIN = Path(__file__).resolve().parents[1] / "kube" / "fake_exec_plugin.py"
MIB = 1024 * 1024


def stub_helm() -> SubprocessHelm:
    return SubprocessHelm([sys.executable, "-I", str(STUB)])


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def gone_within(pid: int, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        await asyncio.sleep(0.05)
    return not alive(pid)


async def pid_from(path: Path, seconds: float = 20) -> int:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists() and (text := path.read_text(encoding="utf-8")):
            return int(text)
        await asyncio.sleep(0.05)
    raise AssertionError("the stub never started")


def tls_kubeconfig(tls, **cluster) -> dict:
    """A client-certificate cluster (as kind's are), never contacted."""
    return {
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": "kind",
        "clusters": [
            {
                "name": "kind",
                "cluster": {
                    "server": "https://127.0.0.1:6443",
                    "certificate-authority-data": b64(tls.ca_pem),
                    **cluster,
                },
            }
        ],
        "users": [
            {
                "name": "kind",
                "user": {
                    "client-certificate-data": b64(tls.client_cert_pem),
                    "client-key-data": b64(tls.client_key_pem),
                },
            }
        ],
        "contexts": [{"name": "kind", "context": {"cluster": "kind", "user": "kind"}}],
    }


@pytest.fixture(scope="module")
def tls():
    return make_tls_material()


# ---- argument builders ----


def test_argument_builders_are_exact():
    chart, values = Path("/c/loki-6.1.0.tgz"), Path("/t/v.yaml")
    assert upgrade_args("omnikrux-loki", chart, "monitoring", values, timeout_s=600) == [
        "upgrade",
        "--install",
        "omnikrux-loki",
        str(chart),
        "--namespace",
        "monitoring",
        "--values",
        str(values),
        "--timeout",
        "600s",
    ]
    assert template_args(
        "omnikrux-loki",
        chart,
        "monitoring",
        values,
        kube_version="v1.33.1",
        api_versions=("monitoring.coreos.com/v1", "monitoring.coreos.com/v1alpha1"),
    ) == [
        "template",
        "omnikrux-loki",
        str(chart),
        "--namespace",
        "monitoring",
        "--values",
        str(values),
        "--kube-version",
        "v1.33.1",
        "--api-versions",
        "monitoring.coreos.com/v1",
        "--api-versions",
        "monitoring.coreos.com/v1alpha1",
    ]
    assert uninstall_args("omnikrux-loki", "monitoring", timeout_s=300) == [
        "uninstall",
        "omnikrux-loki",
        "--namespace",
        "monitoring",
        "--timeout",
        "300s",
    ]
    assert show_crds_args(chart) == ["show", "crds", str(chart)]
    assert version_args() == ["version", "--template", "{{.Version}}"]


def test_no_builder_takes_a_credential_or_a_server():
    for builder in (template_args, upgrade_args, uninstall_args, show_crds_args, version_args):
        names = " ".join(inspect.signature(builder).parameters).lower()
        for word in ("token", "server", "host", "kubeconfig", "key", "cert"):
            assert word not in names, (builder.__name__, word)


# ---- the kubeconfig handed to Helm ----


async def test_helm_kubeconfig_is_private_and_removed(fake_api, kube_cluster, connections):
    async with helm_kubeconfig(connections, kube_cluster) as path:
        doc = yaml.safe_load(path.read_text())
        user = doc["users"][0]["user"]
        assert user["token"] == TOKEN and "exec" not in user and "auth-provider" not in user
        assert doc["clusters"][0]["cluster"]["server"] == fake_api.url
        assert doc["current-context"] == "omnikrux"
        if os.name == "posix":
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        parent = path.parent
        assert parent.name.startswith("omnikrux-helm-")
    assert not parent.exists()


async def test_helm_kubeconfig_is_removed_on_failure_and_cancel(
    fake_api, kube_cluster, connections
):
    seen: list[Path] = []
    with pytest.raises(RuntimeError):
        async with helm_kubeconfig(connections, kube_cluster) as path:
            seen.append(path.parent)
            raise RuntimeError("helm failed")

    inside = asyncio.Event()

    async def held():
        async with helm_kubeconfig(connections, kube_cluster) as path:
            seen.append(path.parent)
            inside.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(held())
    await asyncio.wait_for(inside.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(seen) == 2 and seen[0] != seen[1]
    assert not any(folder.exists() for folder in seen)


async def test_kubeconfig_from_an_exec_cluster_carries_a_token_not_the_plugin(fake_api, tmp_path):
    config = kubeconfig_for(fake_api)
    config["users"][0]["user"] = {
        "exec": {
            "command": sys.executable,
            "apiVersion": "client.authentication.k8s.io/v1beta1",
            "args": [str(EXEC_PLUGIN)],
            "env": [
                {"name": "FAKE_PLUGIN_STATE", "value": str(tmp_path / "counter")},
                {"name": "FAKE_PLUGIN_TTL", "value": "300"},
            ],
        }
    }
    connections = ClusterConnections(FakeRegistry({"c1": config}))
    async with helm_kubeconfig(connections, "c1") as path:
        text = path.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    assert doc["users"][0]["user"] == {"token": "exec-1"}
    assert "exec:" not in text and "auth-provider" not in text
    assert EXEC_PLUGIN.name not in text and "FAKE_PLUGIN" not in text


async def test_kubeconfig_carries_tls_material_as_data(tls):
    config = tls_kubeconfig(tls, **{"tls-server-name": "kube.internal.example"})
    connections = ClusterConnections(FakeRegistry({"kind": config}))
    cfg = await connections.configuration("kind")
    doc = kubeconfig_from_configuration(cfg)
    cluster, user = doc["clusters"][0]["cluster"], doc["users"][0]["user"]
    assert cluster == {
        "server": "https://127.0.0.1:6443",
        "certificate-authority-data": b64(tls.ca_pem),
        "tls-server-name": "kube.internal.example",
    }
    assert user == {
        "client-certificate-data": b64(tls.client_cert_pem),
        "client-key-data": b64(tls.client_key_pem),
    }
    assert secrets_of(cfg) == [tls.client_key_pem]
    assert hosts_of(cfg) == ["127.0.0.1", "kube.internal.example"]
    async with helm_kubeconfig(connections, "kind") as path:
        assert secrets_and_hosts(path) == (secrets_of(cfg), hosts_of(cfg))


async def test_kubeconfig_keeps_insecure_and_proxy_only_when_set(fake_api):
    config = kubeconfig_for(fake_api)
    config["clusters"][0]["cluster"]["insecure-skip-tls-verify"] = True
    config["clusters"][0]["cluster"]["proxy-url"] = "http://proxy.example:3128"
    connections = ClusterConnections(FakeRegistry({"c1": config, "c2": kubeconfig_for(fake_api)}))
    cluster = kubeconfig_from_configuration(await connections.configuration("c1"))["clusters"][0]
    assert cluster["cluster"]["insecure-skip-tls-verify"] is True
    assert cluster["cluster"]["proxy-url"] == "http://proxy.example:3128"
    assert "certificate-authority-data" not in cluster["cluster"]
    plain = kubeconfig_from_configuration(await connections.configuration("c2"))["clusters"][0]
    assert set(plain["cluster"]) == {"server"}
    assert secrets_of(await connections.configuration("c2")) == [TOKEN]


async def test_token_is_never_an_argument(fake_api, kube_cluster, connections, tmp_path):
    fake = FakeHelm()
    chart, values = tmp_path / "loki.tgz", tmp_path / "values.yaml"
    async with helm_kubeconfig(connections, kube_cluster) as path:
        assert secrets_and_hosts(path)[0] == [TOKEN]
        for args in (
            template_args(
                "omnikrux-loki",
                chart,
                "monitoring",
                values,
                kube_version="v1.33.1",
                api_versions=(),
            ),
            upgrade_args("omnikrux-loki", chart, "monitoring", values, timeout_s=600),
            uninstall_args("omnikrux-loki", "monitoring", timeout_s=300),
        ):
            await fake.run(args, kubeconfig=path, timeout=600)
        # The real runner, through the stub: the token isn't in its arguments or environment.
        answer = await stub_helm().run(
            upgrade_args("omnikrux-loki", chart, "monitoring", values, timeout_s=600),
            kubeconfig=path,
            timeout=60,
        )
    assert len(fake.calls) == 3
    for call in fake.calls:
        assert not any(TOKEN in arg for arg in call.args)
        assert TOKEN in (call.kubeconfig_text or "")
    dump = json.loads(answer.stdout)
    assert not any(TOKEN in arg for arg in dump["args"])
    assert not any(TOKEN in value for value in dump["env"].values())


async def test_client_key_is_never_an_argument_or_in_the_environment(tls, tmp_path):
    connections = ClusterConnections(FakeRegistry({"kind": tls_kubeconfig(tls)}))
    key_lines = [line for line in tls.client_key_pem.splitlines() if "PRIVATE KEY" not in line]
    async with helm_kubeconfig(connections, "kind") as path:
        assert b64(tls.client_key_pem) in path.read_text(encoding="utf-8")
        answer = await stub_helm().run(
            upgrade_args(
                "omnikrux-loki", tmp_path / "c.tgz", "monitoring", tmp_path / "v.yaml", timeout_s=60
            ),
            kubeconfig=path,
            timeout=60,
        )
    dump = json.loads(answer.stdout)
    seen = " ".join([*dump["args"], *dump["env"].values()])
    assert b64(tls.client_key_pem) not in seen
    assert not any(line in seen for line in key_lines)


# ---- the subprocess runner ----


async def test_subprocess_runner_runs_and_caps_output():
    answer = await stub_helm().run(version_args(), kubeconfig=None, timeout=60)
    assert answer.code == 0 and answer.stderr == ""
    assert json.loads(answer.stdout)["args"] == version_args()

    big = await stub_helm().run(["big", str(5 * MIB)], kubeconfig=None, timeout=60)
    assert big.code == 0
    assert len(big.stdout) == 4 * MIB and len(big.stderr) == 4 * MIB

    larger = await stub_helm().run(
        ["big", str(5 * MIB)], kubeconfig=None, timeout=60, max_output=8 * MIB
    )
    assert len(larger.stdout) == 5 * MIB


async def test_subprocess_runner_env_is_minimal(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIKRUX_SECRET_KEY", "never-in-helm")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:3128")
    monkeypatch.setenv("HELM_KUBECONTEXT", "someone-elses")
    monkeypatch.setenv("KUBECONFIG", str(tmp_path / "the-users-own"))
    kubeconfig = tmp_path / "kubeconfig"
    kubeconfig.write_text("{}", encoding="utf-8")

    answer = await stub_helm().run(["env"], kubeconfig=kubeconfig, timeout=60)
    env = json.loads(answer.stdout)["env"]
    allowed = {"PATH", "HOME", "HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME"}
    allowed |= {"KUBECONFIG", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"}
    assert set(env) <= allowed
    assert env["KUBECONFIG"] == str(kubeconfig)
    assert "OMNIKRUX_SECRET_KEY" not in env and "HTTPS_PROXY" not in env
    assert "HELM_KUBECONTEXT" not in env
    private = Path(env["HOME"]).parent
    assert private.name.startswith("omnikrux-helm-run-")
    for name in ("HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME"):
        assert Path(env[name]).parent == private
    assert not private.exists()

    without = json.loads((await stub_helm().run(["env"], kubeconfig=None, timeout=60)).stdout)
    assert "KUBECONFIG" not in without["env"]


async def test_cancel_terminates_the_process(tmp_path):
    pidfile = tmp_path / "pid"
    task = asyncio.create_task(
        stub_helm().run(["sleep", "600", str(pidfile)], kubeconfig=None, timeout=600)
    )
    pid = await pid_from(pidfile)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await gone_within(pid, 25)


async def test_a_process_that_ignores_terminate_is_killed(tmp_path, monkeypatch):
    monkeypatch.setattr(helm_module, "STOP_GRACE_SECONDS", 0.5)
    pidfile = tmp_path / "pid"
    task = asyncio.create_task(
        stub_helm().run(["ignore-term", "600", str(pidfile)], kubeconfig=None, timeout=600)
    )
    pid = await pid_from(pidfile)
    await asyncio.sleep(0.3)  # the stub has set its SIGTERM handler before it wrote the pid
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await gone_within(pid, 5)


async def test_timeout_returns_124(tmp_path):
    pidfile = tmp_path / "pid"
    answer = await stub_helm().run(["sleep", "600", str(pidfile)], kubeconfig=None, timeout=1)
    assert answer.code == 124 and answer.stderr.endswith(TIMEOUT_MARK)
    assert answer.timeout == 1
    assert await gone_within(int(pidfile.read_text(encoding="utf-8")), 25)
    assert (
        helm_error_message(
            timed_out("", "", 600), step="install omnikrux-loki", secrets=[], hosts=[], cloud=True
        )
        == "Helm didn't finish install omnikrux-loki within 10 minutes."
    )


async def test_a_failure_keeps_helms_words_and_logs_only_the_step(caplog):
    caplog.set_level(logging.DEBUG)
    answer = await stub_helm().run(
        ["fail", "1", "Error: INSTALLATION FAILED: Bearer tok-SECRET-9 refused\n"],
        kubeconfig=None,
        timeout=60,
    )
    assert answer == HelmResult(1, "", "Error: INSTALLATION FAILED: Bearer tok-SECRET-9 refused\n")
    assert "tok-SECRET-9" not in caplog.text
    assert "exit code 1" in caplog.text


# ---- words ----


def test_helm_errors_never_carry_secrets():
    r = HelmResult(
        1,
        "",
        'Error: Kubernetes cluster unreachable: Get "https://10.1.2.3:6443/version": '
        "Authorization: Bearer tok-SECRET-9\n",
    )
    msg = helm_error_message(
        r, step="install omnikrux-loki", secrets=["tok-SECRET-9"], hosts=["10.1.2.3"], cloud=False
    )
    assert "tok-SECRET-9" not in msg and "10.1.2.3" not in msg
    assert msg.startswith("Helm couldn't install omnikrux-loki: ")
    assert helm_error_message(
        r, step="install omnikrux-loki", secrets=[], hosts=[], cloud=True
    ) == (
        "Helm couldn't install omnikrux-loki: the cluster refused or didn't answer. "
        "Check the cloud login and the network, then try again."
    )


def test_a_bearer_value_is_hidden_even_when_not_named():
    r = HelmResult(1, "", "Error: Authorization: Bearer some-other-token was refused\n")
    msg = helm_error_message(r, step="install omnikrux-loki", secrets=[], hosts=[], cloud=False)
    assert "some-other-token" not in msg and "Bearer •••" in msg


def test_a_line_of_the_client_key_is_hidden(tls):
    line = next(line for line in tls.client_key_pem.splitlines() if "PRIVATE KEY" not in line)
    r = HelmResult(1, "", f"Error: bad key data {line}\n")
    msg = helm_error_message(
        r, step="install omnikrux-loki", secrets=[tls.client_key_pem], hosts=[], cloud=False
    )
    assert line not in msg and "•••" in msg


def test_the_last_error_line_is_the_reason_and_it_is_short():
    r = HelmResult(
        1,
        "",
        "level=WARN msg=something\nError: first\nmore words\n"
        f"Error: UPGRADE FAILED: {'x' * 400}\ntrailing note\n",
    )
    msg = helm_error_message(r, step="upgrade omnikrux-loki", secrets=[], hosts=[], cloud=False)
    assert msg == f"Helm couldn't upgrade omnikrux-loki: UPGRADE FAILED: {'x' * 284}"
    no_error = HelmResult(1, "", "first\nthe last words\n\n")
    assert helm_error_message(
        no_error, step="read the loki chart", secrets=[], hosts=[], cloud=False
    ) == ("Helm couldn't read the loki chart: the last words")
    silent = HelmResult(2, "", "")
    assert helm_error_message(
        silent, step="read the loki chart", secrets=[], hosts=[], cloud=False
    ) == ("Helm couldn't read the loki chart: it stopped with exit code 2 and gave no reason")


@pytest.mark.parametrize(
    "reason",
    [
        "release: not found",
        "rendered manifests contain a resource that already exists. Unable to continue",
        "chart requires kubeVersion: >=1.25.0-0 which is incompatible with Kubernetes v1.24.0",
        "INSTALLATION FAILED: context deadline exceeded",
        "UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress",
    ],
)
def test_cloud_clusters_keep_helms_own_release_errors(reason):
    r = HelmResult(1, "", f"Error: {reason}\n")
    msg = helm_error_message(r, step="install omnikrux-loki", secrets=[], hosts=[], cloud=True)
    assert msg == messages.HELM_FAILED.format(step="install omnikrux-loki", reason=reason)


@pytest.mark.parametrize(
    "reason",
    [
        "INSTALLATION FAILED: Kubernetes cluster unreachable: Get https://aks.example/version",
        "INSTALLATION FAILED: dial tcp 10.1.2.3:443: i/o timeout",
        "UPGRADE FAILED: query to my-cluster.hcp.westeurope.azmk8s.io refused",
        "Kubernetes cluster unreachable",
    ],
)
def test_cloud_clusters_never_show_transport_words(reason):
    r = HelmResult(1, "", f"Error: {reason}\n")
    msg = helm_error_message(
        r,
        step="install omnikrux-loki",
        secrets=[],
        hosts=["my-cluster.hcp.westeurope.azmk8s.io"],
        cloud=True,
    )
    assert msg == messages.HELM_FAILED_CLOUD.format(step="install omnikrux-loki")


# ---- the fake ----


async def test_fake_helm_records_scripts_and_hangs(tmp_path):
    fake = FakeHelm(rendered={"omnikrux-loki": "kind: Service\n"})
    fake.releases[("omnikrux-alloy", "monitoring")] = 2
    kubeconfig = tmp_path / "kubeconfig"
    kubeconfig.write_text("token: x", encoding="utf-8")
    chart, values = tmp_path / "c.tgz", tmp_path / "v.yaml"
    rendered = await fake.run(
        template_args(
            "omnikrux-loki", chart, "monitoring", values, kube_version="v1", api_versions=()
        ),
        kubeconfig=None,
        timeout=60,
    )
    assert rendered == HelmResult(0, "kind: Service\n", "")
    await fake.run(
        upgrade_args("omnikrux-alloy", chart, "monitoring", values, timeout_s=600),
        kubeconfig=kubeconfig,
        timeout=600,
    )
    assert fake.releases[("omnikrux-alloy", "monitoring")] == 3
    assert fake.calls[1].kubeconfig_text == "token: x"
    gone = await fake.run(
        uninstall_args("omnikrux-loki", "monitoring", timeout_s=300), kubeconfig=None, timeout=300
    )
    assert gone.code == 1 and "not found" in gone.stderr
    version = await fake.run(version_args(), kubeconfig=None, timeout=5)
    assert version.stdout == f"v{HELM_VERSION}"

    fake.script["show"] = HelmResult(0, "kind: CustomResourceDefinition\n", "")
    assert (await fake.run(show_crds_args(chart), kubeconfig=None, timeout=60)).code == 0

    fake.hang.add("upgrade")
    task = asyncio.create_task(
        fake.run(
            upgrade_args("omnikrux-loki", chart, "monitoring", values, timeout_s=600),
            kubeconfig=None,
            timeout=600,
        )
    )
    await asyncio.sleep(0.05)
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_fake_helm_fixture_is_the_apps_runner(monitoring_app, fake_helm):
    _, app = monitoring_app
    services = app.state.monitoring
    assert services.helm is fake_helm
    status = await services.install_tools.status()
    assert status.available and status.helm_version == f"v{HELM_VERSION}"
    assert set(status.charts) == {"kube-prometheus-stack", "loki", "alloy"}


# ---- the pinned Helm ----


@pytest.mark.helm
async def test_pinned_helm_answers_through_the_runner():
    helm, _ = pinned_tools()
    answer = await SubprocessHelm([str(helm)]).run(version_args(), kubeconfig=None, timeout=60)
    assert answer == HelmResult(0, f"v{HELM_VERSION}", "")
