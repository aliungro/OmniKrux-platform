"""The files for a Docker host or for servers, and probing the tools they start: the compose file
and the script are valid and run the pinned versions, the script checks every download before it
installs anything, inputs are checked in words, and the probe tells each tool's answer."""

import asyncio
import re
import shutil
import socket
import subprocess

import pytest
import yaml
from aiohttp import web
from aiohttp.test_utils import TestServer

from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.generate import (
    GenerateIn,
    compose_file,
    generate,
    server_script,
)
from omnikrux.monitoring.install.pins import (
    ARCHES,
    CHART_IMAGE_VERSIONS,
    CHARTS,
    IMAGES,
    SERVER_BINARIES,
)

GENERATE = "/api/monitoring/install/generate"
PROBE = "/api/monitoring/install/probe"
SERVERS = GenerateIn(kind="servers", address="central.example", servers=["10.0.0.5", "db-1:9200"])


def docker_input(**over) -> GenerateIn:
    return GenerateIn(kind="docker", address="docker-host.example", **over)


def test_compose_pins_images_and_never_mounts_the_docker_socket():
    doc = yaml.safe_load(compose_file(docker_input(retention_days=14)))
    assert doc["name"] == "omnikrux-monitoring"
    assert set(doc["services"]) == {"prometheus", "alertmanager", "node-exporter", "loki", "alloy"}
    assert doc["services"]["prometheus"]["image"] == IMAGES["prometheus"]
    assert doc["services"]["node-exporter"]["image"] == IMAGES["node_exporter"]
    assert "--storage.tsdb.retention.time=14d" in doc["services"]["prometheus"]["command"]
    assert "docker.sock" not in yaml.safe_dump(doc)
    assert "docker.sock" not in compose_file(docker_input())
    assert "336h" in doc["configs"]["loki"]["content"]
    for service in doc["services"].values():
        assert service["restart"] == "unless-stopped"
    published = {n: s.get("ports") for n, s in doc["services"].items() if s.get("ports")}
    assert published == {
        "prometheus": ["9090:9090"],
        "alertmanager": ["9093:9093"],
        "loki": ["3100:3100"],
    }
    assert 'host = "docker-host.example"' in doc["configs"]["alloy"]["content"]
    assert (
        "# Add receivers here. OmniKrux never writes secrets"
        in (doc["configs"]["alertmanager"]["content"])
    )
    assert "ports (9090, 9093, 3100) have no sign-in" in compose_file(docker_input())


@pytest.mark.compose
def test_compose_passes_docker_compose_config(tmp_path):
    if shutil.which("docker") is None:
        pytest.skip("Docker isn't installed")
    try:
        version = subprocess.run(
            ["docker", "compose", "version"], capture_output=True, timeout=60, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        pytest.skip("docker compose isn't available")
    if version.returncode != 0:
        pytest.skip("docker compose isn't available")
    path = tmp_path / "docker-compose.yml"
    path.write_text(compose_file(docker_input()), encoding="utf-8")
    done = subprocess.run(
        ["docker", "compose", "-f", str(path), "config", "--quiet"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr


def test_script_is_valid_bash(tmp_path):
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash isn't available")
    path = tmp_path / "omnikrux-monitoring.sh"
    path.write_bytes(server_script(SERVERS).encode("utf-8"))
    done = subprocess.run(
        [bash, "-n", str(path)], capture_output=True, text=True, timeout=60, check=False
    )
    assert done.returncode == 0, done.stderr


def test_script_checks_every_download():
    script = server_script(SERVERS)
    lines = script.splitlines()
    for pin in SERVER_BINARIES.values():
        for arch in ARCHES:
            near = [ln for ln in lines if pin.file(arch) in ln and pin.sha256[arch] in ln]
            assert near, (pin.tool, arch)
            assert pin.url(arch) in near[0]
    # `want` downloads and checks one file; every call comes before the first install line
    assert script.index("sha256sum -c") > script.index("curl -fsSL")
    last_call = script.rindex("\n      want ")
    assert script.index("install -m") > last_call
    assert script.index("systemctl enable") > last_call
    assert "Checksum mismatch for $file. Nothing was installed." in script


def test_script_stops_in_words_and_never_mounts_the_socket():
    script = server_script(SERVERS)
    assert "Missing $tool. Install it, then run this again." in script
    assert "This script supports amd64 and arm64 servers." in script
    assert "set -euo pipefail" in script
    assert "docker.sock" not in script
    assert "no sign-in" in script
    for text in ("--role", "--central", "--uninstall", "--purge", "loki.source.journal"):
        assert text in script
    for unit in ("prometheus", "alertmanager", "loki", "node-exporter", "alloy"):
        assert f"omnikrux-{unit}.service" in script
    assert script.count("Restart=on-failure") == 5


def test_script_names_servers_to_scrape():
    script = server_script(SERVERS)
    marker = "prometheus.yml\" <<'OMNIKRUX_CONFIG'" + chr(10)
    config = yaml.safe_load(script.split(marker)[1].split("OMNIKRUX_CONFIG")[0])
    jobs = {j["job_name"]: j["static_configs"][0]["targets"] for j in config["scrape_configs"]}
    assert jobs["node"] == ["10.0.0.5:9100", "db-1:9200"]


def test_script_keeps_the_retention():
    script = server_script(GenerateIn(**{**SERVERS.model_dump(), "retention_days": 30}))
    assert "--storage.tsdb.retention.time=30d" in script
    assert "retention_period: 720h" in script


@pytest.mark.parametrize(
    ("body", "words"),
    [
        ({"kind": "docker", "address": "http://x:1"}, messages.GENERATE_ADDRESS),
        ({"kind": "docker", "address": "host.example:9090"}, messages.GENERATE_ADDRESS),
        ({"kind": "docker", "address": "fe80::1%eth0"}, messages.GENERATE_ADDRESS),
        ({"kind": "docker", "address": "10.0.0.5%eth0"}, messages.GENERATE_ADDRESS),
        ({"kind": "servers", "address": "central.example"}, messages.GENERATE_SERVERS),
        (
            {"kind": "servers", "address": "central.example", "servers": ["a b"]},
            messages.GENERATE_SERVERS,
        ),
        (
            {"kind": "servers", "address": "central.example", "servers": ["a:99999"]},
            messages.GENERATE_SERVERS,
        ),
        ({"kind": "servers", "address": "central.example", "servers": ["a"] * 51}, None),
        (
            {"kind": "docker", "address": "x.example", "retention_days": 0},
            messages.SETTING_RETENTION,
        ),
        (
            {"kind": "docker", "address": "x.example", "retention_days": 91},
            messages.SETTING_RETENTION,
        ),
    ],
)
async def test_generate_validation_words(monitoring_app, body, words):
    http, _ = monitoring_app
    r = await http.post(GENERATE, json=body)
    assert r.status_code == 422
    if words:
        assert r.json()["detail"] == words


async def test_generate_accepts_ip_literals(monitoring_app):
    http, _ = monitoring_app
    for address in ("10.0.0.5", "fd00::5"):
        r = await http.post(GENERATE, json={"kind": "docker", "address": address})
        assert r.status_code == 200, r.text
    assert r.json()["urls"]["prometheus"] == "http://[fd00::5]:9090"


async def test_generate_route_returns_files_and_urls(monitoring_app):
    http, _ = monitoring_app
    r = await http.post(GENERATE, json={"kind": "docker", "address": "docker-host.example"})
    assert r.status_code == 200
    body = r.json()
    assert [f["name"] for f in body["files"]] == ["docker-compose.yml"]
    assert body["files"][0]["executable"] is False
    assert body["urls"] == {
        "prometheus": "http://docker-host.example:9090",
        "alertmanager": "http://docker-host.example:9093",
        "loki": "http://docker-host.example:3100",
    }
    assert body["ports"] == [9090, 9093, 3100]
    r = await http.post(
        GENERATE, json={"kind": "servers", "address": "central.example", "servers": ["a"]}
    )
    out = r.json()
    assert [f["name"] for f in out["files"]] == ["omnikrux-monitoring.sh"]
    assert out["files"][0]["executable"] is True
    assert out["files"][0]["content"].startswith("#!/usr/bin/env bash")


def test_generate_matches_the_file_builders():
    assert generate(docker_input()).files[0].content == compose_file(docker_input())


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def test_probe_reports_each_tool(monitoring_app, fake_prometheus, fake_alertmanager):
    http, _ = monitoring_app
    closed = f"http://127.0.0.1:{free_port()}"
    r = await http.post(
        PROBE,
        json={
            "tools": [
                {"type": "prometheus", "url": fake_prometheus.url},
                {"type": "alertmanager", "url": fake_alertmanager.url},
                {"type": "loki", "url": closed},
            ]
        },
    )
    assert r.status_code == 200, r.text
    by_type = {x["type"]: x for x in r.json()["results"]}
    assert by_type["prometheus"]["ok"] is True
    assert by_type["prometheus"]["version"] == "3.1.0"
    assert by_type["alertmanager"]["ok"] is True
    assert by_type["alertmanager"]["version"] == "0.27.0"
    assert by_type["loki"]["ok"] is False
    assert by_type["loki"]["message"] == (
        "Can't reach Loki: the connection was refused. Check the address and that the tool is running."
    )


async def test_probe_never_follows_a_redirect(monitoring_app, fake_prometheus):
    http, _ = monitoring_app

    async def elsewhere(request: web.Request) -> web.StreamResponse:
        raise web.HTTPFound(fake_prometheus.url + request.path)

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", elsewhere)
    async with TestServer(app, host="127.0.0.1") as server:
        r = await http.post(
            PROBE, json={"tools": [{"type": "prometheus", "url": str(server.make_url(""))}]}
        )
    result = r.json()["results"][0]
    assert result["ok"] is False
    assert fake_prometheus.requests == []


async def test_probe_runs_the_tools_together(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    fake_prometheus.mode = "hang"
    try:
        r = await asyncio.wait_for(
            http.post(
                PROBE,
                json={"tools": [{"type": "prometheus", "url": fake_prometheus.url}] * 3},
            ),
            timeout=30,
        )
    finally:
        fake_prometheus.release.set()
    results = r.json()["results"]
    assert len(results) == 3
    assert all(x["ok"] is False for x in results)


async def test_probe_words_a_bad_address(monitoring_app):
    http, _ = monitoring_app
    r = await http.post(PROBE, json={"tools": [{"type": "prometheus", "url": "ftp://a.example"}]})
    assert r.status_code == 422
    assert r.json()["detail"] == (
        "Use an http or https address with a host, like http://prometheus.example:9090."
    )


@pytest.mark.parametrize(
    "tools",
    [
        [],
        [{"type": "prometheus", "url": "http://a.example"}] * 4,
        [{"type": "grafana", "url": "http://a.example"}],
    ],
)
async def test_probe_checks_its_input(monitoring_app, tools):
    http, _ = monitoring_app
    r = await http.post(PROBE, json={"tools": tools})
    assert r.status_code == 422


def test_image_versions_follow_the_charts():
    for tool, tag in IMAGES.items():
        assert tag.endswith(CHART_IMAGE_VERSIONS[tool]), tool
        assert SERVER_BINARIES[tool].version == CHART_IMAGE_VERSIONS[tool]
    assert CHART_IMAGE_VERSIONS["loki"] == CHARTS["loki"].app_version
    assert f"v{CHART_IMAGE_VERSIONS['alloy']}" == CHARTS["alloy"].app_version
    for pin in SERVER_BINARIES.values():
        for arch in ARCHES:
            assert re.fullmatch(r"[0-9a-f]{64}", pin.sha256[arch])


def test_a_rerun_restarts_every_unit_after_enabling_it():
    script = server_script(SERVERS)
    assert script.index("systemctl daemon-reload", script.index("OMNIKRUX_UNIT")) < script.index(
        'systemctl enable --now "$unit"'
    )
    assert script.index('systemctl enable --now "$unit"') < script.index(
        'systemctl restart "$unit"'
    )


def test_script_needs_hostname_and_refuses_purge_alone():
    script = server_script(SERVERS)
    assert "sha256sum systemctl hostname" in script
    assert 'die "--purge only works together with --uninstall."' in script
    assert "RETENTION_DAYS" not in script
