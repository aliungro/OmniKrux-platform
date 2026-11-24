"""Files for a Docker host or for servers: a docker-compose file, or a systemd install script,
that run the same tools OmniKrux installs into a cluster. OmniKrux only writes the text. It never
connects to the host, never asks for SSH keys and never mounts the Docker socket. The YAML is built
from dictionaries; the script is fixed text with values that were validated first (and quoted)."""

from __future__ import annotations

import ipaddress
import re
import shlex
from typing import Literal

import yaml
from pydantic import BaseModel, Field

from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.pins import ARCHES, IMAGES, SERVER_BINARIES

_HOSTNAME = re.compile(r"[A-Za-z0-9.-]{1,253}")
_PORT = re.compile(r"[0-9]{1,5}")
MAX_SERVERS = 50
NODE_PORT = 9100
PORTS = {"prometheus": 9090, "alertmanager": 9093, "loki": 3100}
RECEIVERS_NOTE = "Add receivers here. OmniKrux never writes secrets into tools it didn't install."


def _is_address(text: str) -> bool:
    if _HOSTNAME.fullmatch(text):
        return True
    try:
        ipaddress.ip_address(text)
    except ValueError:
        return False
    return True


def _is_server(text: str) -> bool:
    host, sep, port = text.partition(":")
    if not _HOSTNAME.fullmatch(host):
        return False
    return not sep or (_PORT.fullmatch(port) is not None and 1 <= int(port) <= 65535)


class GenerateIn(BaseModel):
    """What the files are for. The fields are checked by `check` (not by pydantic), so a
    problem comes back in words."""

    kind: Literal["docker", "servers"]
    address: str
    retention_days: int = 7
    servers: list[str] = Field(default_factory=list)


def problem_of(g: GenerateIn) -> str | None:
    """The first thing wrong with the input, in words, or None."""
    if not _is_address(g.address):
        return messages.GENERATE_ADDRESS
    if isinstance(g.retention_days, bool) or not 1 <= g.retention_days <= 90:
        return messages.SETTING_RETENTION
    if g.kind == "servers" and not 1 <= len(g.servers) <= MAX_SERVERS:
        return messages.GENERATE_SERVERS
    if g.kind == "servers" and not all(_is_server(entry) for entry in g.servers):
        return messages.GENERATE_SERVERS
    return None


def check(g: GenerateIn) -> None:
    """ValueError with the words when the input can't be written into a file."""
    if (problem := problem_of(g)) is not None:
        raise ValueError(problem)


class GeneratedFile(BaseModel):
    name: str
    content: str
    executable: bool


class GeneratedOut(BaseModel):
    kind: Literal["docker", "servers"]
    files: list[GeneratedFile]
    urls: dict[Literal["prometheus", "alertmanager", "loki"], str]
    ports: list[int]


def url_host(address: str) -> str:
    """The address as it is written in a URL (IPv6 literals in brackets)."""
    return f"[{address}]" if ":" in address else address


def scrape_targets(servers: list[str]) -> list[str]:
    """Each server as host:port, with the node exporter's port when none is given."""
    return [s if ":" in s else f"{s}:{NODE_PORT}" for s in servers]


# --- Configuration shared by both files -----------------------------------------------------------


class _Block(str):
    """Text dumped as a literal block, so a config reads as itself inside the compose file."""


class _Dumper(yaml.SafeDumper):
    pass


_Dumper.add_representer(
    _Block, lambda dumper, data: dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
)


def _dump(data: object) -> str:
    return yaml.dump(data, Dumper=_Dumper, sort_keys=False, default_flow_style=False, width=100)


def _prometheus_config(jobs: dict[str, list[str]], alertmanager: str) -> str:
    return _dump(
        {
            "global": {"scrape_interval": "30s", "evaluation_interval": "30s"},
            "alerting": {"alertmanagers": [{"static_configs": [{"targets": [alertmanager]}]}]},
            "scrape_configs": [
                {"job_name": job, "static_configs": [{"targets": targets}]}
                for job, targets in jobs.items()
            ],
        }
    )


def _alertmanager_config() -> str:
    body = _dump(
        {
            "route": {"receiver": "null", "group_by": ["alertname"]},
            "receivers": [{"name": "null"}],
        }
    )
    return f"# {RECEIVERS_NOTE}\n{body}"


def _loki_config(root: str, retention_days: int) -> str:
    return _dump(
        {
            "auth_enabled": False,
            "server": {"http_listen_port": 3100, "grpc_listen_port": 9096},
            "common": {
                "instance_addr": "127.0.0.1",
                "path_prefix": root,
                "storage": {
                    "filesystem": {
                        "chunks_directory": f"{root}/chunks",
                        "rules_directory": f"{root}/rules",
                    }
                },
                "replication_factor": 1,
                "ring": {"kvstore": {"store": "inmemory"}},
            },
            "schema_config": {
                "configs": [
                    {
                        "from": "2024-01-01",
                        "store": "tsdb",
                        "object_store": "filesystem",
                        "schema": "v13",
                        "index": {"prefix": "index_", "period": "24h"},
                    }
                ]
            },
            "limits_config": {"retention_period": f"{retention_days * 24}h"},
            "compactor": {
                "working_directory": f"{root}/retention",
                "retention_enabled": True,
                "delete_request_store": "filesystem",
            },
            "analytics": {"reporting_enabled": False},
        }
    )


def _alloy_docker_config(address: str) -> str:
    return f"""local.file_match "docker" {{
  path_targets = [{{"__path__" = "/var/lib/docker/containers/*/*-json.log", "job" = "docker"}}]
}}

loki.source.file "docker" {{
  targets    = local.file_match.docker.targets
  forward_to = [loki.process.docker.receiver]
}}

loki.process "docker" {{
  stage.docker {{}}
  forward_to = [loki.write.default.receiver]
}}

local.file_match "host" {{
  path_targets = [{{"__path__" = "/var/log/host/*.log", "job" = "varlogs"}}]
}}

loki.source.file "host" {{
  targets    = local.file_match.host.targets
  forward_to = [loki.write.default.receiver]
}}

loki.write "default" {{
  endpoint {{
    url = "http://loki:3100/loki/api/v1/push"
  }}
  external_labels = {{ host = "{address}" }}
}}
"""


# --- docker-compose.yml ---------------------------------------------------------------------------


def compose_file(g: GenerateIn) -> str:
    check(g)
    days = g.retention_days
    service = {"restart": "unless-stopped"}
    prometheus_jobs = {
        "prometheus": ["prometheus:9090"],
        "node-exporter": ["node-exporter:9100"],
        "alertmanager": ["alertmanager:9093"],
        "loki": ["loki:3100"],
    }
    doc = {
        "name": "omnikrux-monitoring",
        "services": {
            "prometheus": {
                "image": IMAGES["prometheus"],
                "command": [
                    "--config.file=/etc/prometheus/prometheus.yml",
                    "--storage.tsdb.path=/prometheus",
                    f"--storage.tsdb.retention.time={days}d",
                ],
                "volumes": ["prometheus-data:/prometheus"],
                "ports": ["9090:9090"],
                "configs": [{"source": "prometheus", "target": "/etc/prometheus/prometheus.yml"}],
                **service,
            },
            "alertmanager": {
                "image": IMAGES["alertmanager"],
                "command": [
                    "--config.file=/etc/alertmanager/alertmanager.yml",
                    "--storage.path=/alertmanager",
                ],
                "volumes": ["alertmanager-data:/alertmanager"],
                "ports": ["9093:9093"],
                "configs": [
                    {"source": "alertmanager", "target": "/etc/alertmanager/alertmanager.yml"}
                ],
                **service,
            },
            "node-exporter": {
                "image": IMAGES["node_exporter"],
                "command": ["--path.rootfs=/host"],
                "pid": "host",
                "volumes": ["/:/host:ro,rslave"],
                **service,
            },
            "loki": {
                "image": IMAGES["loki"],
                "command": ["-config.file=/etc/loki/loki.yml"],
                "volumes": ["loki-data:/loki"],
                "ports": ["3100:3100"],
                "configs": [{"source": "loki", "target": "/etc/loki/loki.yml"}],
                **service,
            },
            "alloy": {
                "image": IMAGES["alloy"],
                "command": [
                    "run",
                    "/etc/alloy/config.alloy",
                    "--storage.path=/var/lib/alloy/data",
                ],
                "volumes": [
                    "/var/lib/docker/containers:/var/lib/docker/containers:ro",
                    "/var/log:/var/log/host:ro",
                    "alloy-data:/var/lib/alloy/data",
                ],
                "configs": [{"source": "alloy", "target": "/etc/alloy/config.alloy"}],
                **service,
            },
        },
        "configs": {
            "prometheus": {
                "content": _Block(_prometheus_config(prometheus_jobs, "alertmanager:9093"))
            },
            "alertmanager": {"content": _Block(_alertmanager_config())},
            "loki": {"content": _Block(_loki_config("/loki", days))},
            "alloy": {"content": _Block(_alloy_docker_config(g.address))},
        },
        "volumes": {
            "prometheus-data": {},
            "alertmanager-data": {},
            "loki-data": {},
            "alloy-data": {},
        },
    }
    header = (
        "# OmniKrux monitoring for this Docker host: Prometheus, Alertmanager, node exporter, Loki\n"
        "# and Alloy, at pinned versions. Start it with: docker compose up -d\n"
        "# Stop it with: docker compose down (add -v to delete the data too).\n"
        f"# {messages.COMPOSE_NO_SIGN_IN}\n"
    )
    return header + _dump(doc)


# --- omnikrux-monitoring.sh -----------------------------------------------------------------------

_UNIT = """[Unit]
Description=OmniKrux monitoring: {what}
After=network-online.target
Wants=network-online.target

[Service]
User=omnikrux-monitoring
ExecStart={exec}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
"""

_BIN = "/usr/local/bin"
_ETC = "/etc/omnikrux-monitoring"
_VAR = "/var/lib/omnikrux-monitoring"


def _unit(name: str, what: str, exec_start: str) -> str:
    text = _UNIT.format(what=what, exec=exec_start)
    return f"cat > /etc/systemd/system/omnikrux-{name}.service <<'OMNIKRUX_UNIT'\n{text}OMNIKRUX_UNIT\n"


def _fetch_lines() -> str:
    arms = []
    for arch in ARCHES:
        lines = [f"    {arch})"]
        for tool, pin in SERVER_BINARIES.items():
            lines.append(
                f'      want {tool} "{pin.file(arch)}" "{pin.url(arch)}" "{pin.sha256[arch]}"'
            )
        lines.append("      ;;")
        arms.append("\n".join(lines))
    return "\n".join(arms)


_SCRIPT = r"""#!/usr/bin/env bash
# OmniKrux monitoring for servers.
#
# Installs, as systemd services: Prometheus @@PROMETHEUS@@, Alertmanager @@ALERTMANAGER@@ and
# Loki @@LOKI@@ (role central), and node exporter @@NODE_EXPORTER@@ and Alloy @@ALLOY@@ (both roles).
# Every download is checked against the SHA-256 sum written in this file before anything is installed.
# Binaries go to @@BIN@@ (named omnikrux-*), configuration to @@ETC@@, data to @@VAR@@.
#
# Run it as root:  ./omnikrux-monitoring.sh --role central     (on the server that keeps the data)
#                  ./omnikrux-monitoring.sh --role agent       (on every other server; --central <address>)
# Remove it with:  ./omnikrux-monitoring.sh --uninstall        (add --purge to delete the data too)
#
# @@NO_SIGN_IN@@

set -euo pipefail

CENTRAL=@@ADDRESS@@
RETENTION_DAYS=@@DAYS@@
ROLE=""
UNINSTALL=0
PURGE=0
SERVICE_USER=omnikrux-monitoring
CENTRAL_UNITS="omnikrux-prometheus omnikrux-alertmanager omnikrux-loki"
ALL_UNITS="$CENTRAL_UNITS omnikrux-node-exporter omnikrux-alloy"

die() {
  echo "$*" >&2
  exit 1
}

usage() {
  die "@@USAGE@@"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --role) [ $# -ge 2 ] || usage; ROLE="$2"; shift 2 ;;
    --central) [ $# -ge 2 ] || usage; CENTRAL="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    *) usage ;;
  esac
done

if [ "$UNINSTALL" -eq 0 ]; then
  case "$ROLE" in central | agent) ;; *) usage ;; esac
fi
[[ "$CENTRAL" =~ ^[A-Za-z0-9.:-]{1,253}$ ]] || die "@@ADDRESS_RULE@@"

[ "$(id -u)" -eq 0 ] || die "@@NOT_ROOT@@"

if [ "$UNINSTALL" -eq 1 ]; then
  required="systemctl"
else
  required="curl tar unzip sha256sum systemctl"
fi
for tool in $required; do
  command -v "$tool" > /dev/null 2>&1 || die "@@MISSING@@"
done

if [ "$UNINSTALL" -eq 1 ]; then
  for unit in $ALL_UNITS; do
    systemctl disable --now "$unit" > /dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit.service" "@@BIN@@/$unit"
  done
  systemctl daemon-reload
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "@@ETC@@" "@@VAR@@"
    userdel "$SERVICE_USER" > /dev/null 2>&1 || true
    echo "OmniKrux monitoring is removed, with its configuration and data."
  else
    echo "OmniKrux monitoring is removed. Its data is kept in @@VAR@@; add --purge to delete it."
  fi
  exit 0
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "@@ARCH@@" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
WANTED=""

# want TOOL FILE URL SHA256: download FILE and check it; stop before anything is installed.
want() {
  local tool="$1" file="$2" url="$3" sum="$4"
  if [ "$ROLE" = agent ] && [ "$tool" != node_exporter ] && [ "$tool" != alloy ]; then
    return 0
  fi
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$file" "$url" || die "@@DOWNLOAD@@"
  if ! (cd "$TMP" && echo "$sum  $file" | sha256sum -c --status -); then
    die "@@CHECKSUM@@"
  fi
  WANTED="$WANTED $tool"
}

case "$ARCH" in
@@FETCH@@
esac

# Everything is downloaded and checked. Only now is anything installed.
for tool in $WANTED; do
  case "$tool" in
@@UNPACK@@
  esac
done

id -u "$SERVICE_USER" > /dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
for group in systemd-journal adm; do
  if getent group "$group" > /dev/null 2>&1; then
    usermod -aG "$group" "$SERVICE_USER"
  fi
done

mkdir -p "@@ETC@@" "@@VAR@@/prometheus" "@@VAR@@/alertmanager" "@@VAR@@/loki" "@@VAR@@/alloy"
chown -R "$SERVICE_USER": "@@VAR@@"

HOST_NAME="$(hostname | tr -c 'A-Za-z0-9.\n-' '_')"
if [ "$ROLE" = central ]; then
  PUSH_HOST="127.0.0.1"
else
  PUSH_HOST="$CENTRAL"
fi
case "$PUSH_HOST" in *:*) PUSH_HOST="[$PUSH_HOST]" ;; esac

cat > "@@ETC@@/alloy.alloy" <<ALLOY_CONFIG
loki.source.journal "journal" {
  forward_to = [loki.write.central.receiver]
  labels     = { job = "journal", host = "$HOST_NAME" }
}

loki.write "central" {
  endpoint {
    url = "http://$PUSH_HOST:3100/loki/api/v1/push"
  }
}
ALLOY_CONFIG

@@NODE_UNIT@@
@@ALLOY_UNIT@@
units="omnikrux-node-exporter omnikrux-alloy"

if [ "$ROLE" = central ]; then
cat > "@@ETC@@/prometheus.yml" <<'OMNIKRUX_CONFIG'
@@PROMETHEUS_CONFIG@@OMNIKRUX_CONFIG
cat > "@@ETC@@/alertmanager.yml" <<'OMNIKRUX_CONFIG'
@@ALERTMANAGER_CONFIG@@OMNIKRUX_CONFIG
cat > "@@ETC@@/loki.yml" <<'OMNIKRUX_CONFIG'
@@LOKI_CONFIG@@OMNIKRUX_CONFIG
@@PROMETHEUS_UNIT@@
@@ALERTMANAGER_UNIT@@
@@LOKI_UNIT@@
  units="$CENTRAL_UNITS $units"
fi

systemctl daemon-reload
for unit in $units; do
  systemctl enable --now "$unit"
done

echo "OmniKrux monitoring is running ($ROLE)."
echo "@@NO_SIGN_IN@@"
"""


def _unpack_lines() -> str:
    lines = []
    for tool, pin in SERVER_BINARIES.items():
        name = tool.replace("_", "-")
        if pin.url_template.endswith(".zip"):
            source = f"$TMP/{tool}-linux-$ARCH"
            extract = f'unzip -q -o "$TMP/{tool}-linux-$ARCH.zip" -d "$TMP"'
        else:
            source = f"$TMP/{tool}-{pin.version}.linux-$ARCH/{tool}"
            extract = f'tar -xzf "$TMP/{tool}-{pin.version}.linux-$ARCH.tar.gz" -C "$TMP"'
        lines.append(
            f'    {tool}) {extract}\n       install -m 0755 "{source}" "{_BIN}/omnikrux-{name}" ;;'
        )
    return "\n".join(lines)


def server_script(g: GenerateIn) -> str:
    check(g)
    targets = scrape_targets(g.servers) if g.kind == "servers" else []
    prometheus_jobs = {
        "prometheus": ["localhost:9090"],
        "alertmanager": ["localhost:9093"],
        "loki": ["localhost:3100"],
        "node": targets,
    }
    versions = {tool: pin.version for tool, pin in SERVER_BINARIES.items()}
    pieces = {
        "PROMETHEUS": f"v{versions['prometheus']}",
        "ALERTMANAGER": f"v{versions['alertmanager']}",
        "LOKI": f"v{versions['loki']}",
        "NODE_EXPORTER": f"v{versions['node_exporter']}",
        "ALLOY": f"v{versions['alloy']}",
        "BIN": _BIN,
        "ETC": _ETC,
        "VAR": _VAR,
        "NO_SIGN_IN": messages.SCRIPT_NO_SIGN_IN,
        "ADDRESS": shlex.quote(g.address),
        "DAYS": str(g.retention_days),
        "USAGE": messages.SCRIPT_USAGE,
        "ADDRESS_RULE": messages.GENERATE_ADDRESS,
        "NOT_ROOT": messages.SCRIPT_NOT_ROOT,
        "MISSING": messages.SCRIPT_MISSING_TOOL,
        "ARCH": messages.SCRIPT_ARCH,
        "DOWNLOAD": messages.SCRIPT_DOWNLOAD,
        "CHECKSUM": messages.SCRIPT_CHECKSUM,
        "FETCH": _fetch_lines(),
        "UNPACK": _unpack_lines(),
        "PROMETHEUS_CONFIG": _prometheus_config(prometheus_jobs, "localhost:9093"),
        "ALERTMANAGER_CONFIG": _alertmanager_config(),
        "LOKI_CONFIG": _loki_config(f"{_VAR}/loki", g.retention_days),
        "NODE_UNIT": _unit(
            "node-exporter",
            "node exporter",
            f"{_BIN}/omnikrux-node-exporter --web.listen-address=:9100",
        ),
        "ALLOY_UNIT": _unit(
            "alloy",
            "Alloy",
            f"{_BIN}/omnikrux-alloy run {_ETC}/alloy.alloy --storage.path={_VAR}/alloy",
        ),
        "PROMETHEUS_UNIT": _unit(
            "prometheus",
            "Prometheus",
            f"{_BIN}/omnikrux-prometheus --config.file={_ETC}/prometheus.yml"
            f" --storage.tsdb.path={_VAR}/prometheus"
            f" --storage.tsdb.retention.time={g.retention_days}d --web.listen-address=:9090",
        ),
        "ALERTMANAGER_UNIT": _unit(
            "alertmanager",
            "Alertmanager",
            f"{_BIN}/omnikrux-alertmanager --config.file={_ETC}/alertmanager.yml"
            f" --storage.path={_VAR}/alertmanager --web.listen-address=:9093"
            " --cluster.listen-address=",
        ),
        "LOKI_UNIT": _unit("loki", "Loki", f"{_BIN}/omnikrux-loki -config.file={_ETC}/loki.yml"),
    }
    text = _SCRIPT
    # Longest names first, so @@PROMETHEUS_UNIT@@ is never read as @@PROMETHEUS@@.
    for key in sorted(pieces, key=len, reverse=True):
        text = text.replace(f"@@{key}@@", pieces[key])
    return text


def generate(g: GenerateIn) -> GeneratedOut:
    check(g)
    host = url_host(g.address)
    urls: dict[Literal["prometheus", "alertmanager", "loki"], str] = {
        "prometheus": f"http://{host}:9090",
        "alertmanager": f"http://{host}:9093",
        "loki": f"http://{host}:3100",
    }
    if g.kind == "docker":
        files = [
            GeneratedFile(name="docker-compose.yml", content=compose_file(g), executable=False)
        ]
        ports = list(PORTS.values())
    else:
        files = [
            GeneratedFile(name="omnikrux-monitoring.sh", content=server_script(g), executable=True)
        ]
        ports = [*PORTS.values(), NODE_PORT]
    return GeneratedOut(kind=g.kind, files=files, urls=urls, ports=ports)
