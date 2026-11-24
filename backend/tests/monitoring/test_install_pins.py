"""The pinned Helm and chart archives: the Dockerfile and the code agree, every download is
checked, and the tools check says in words what is missing or wrong."""

import hashlib
import re
from pathlib import Path
from types import MappingProxyType

import pytest

from omnikrux.config import Settings
from omnikrux.monitoring.install import messages, pins, tools
from omnikrux.monitoring.install.pins import CHARTS, HELM_VERSION, ChartPin
from omnikrux.monitoring.install.tools import ToolsCheck

REPO = Path(__file__).resolve().parents[3]

_ARG = re.compile(r"^ARG ([A-Z0-9_]+)=(\S+)\s*$", re.MULTILINE)


def dockerfile_args(path: Path) -> dict[str, str]:
    """`ARG NAME=value` lines of a Dockerfile (ARGs without a default are left out)."""
    return dict(_ARG.findall(path.read_text(encoding="utf-8")))


def monitoring_tools_stage(path: Path) -> str:
    """The `monitoring-tools` stage's text, with line continuations joined."""
    text = path.read_text(encoding="utf-8")
    start = text.index(" AS monitoring-tools")
    end = text.find("\nFROM ", start)
    return text[start : end if end != -1 else len(text)].replace("\\\n", " ")


def expand(text: str, args: dict[str, str]) -> str:
    return re.sub(r"\$\{([A-Z0-9_]+)\}", lambda m: args.get(m[1], m[0]), text)


def test_dockerfile_pins_match_the_code():
    args = dockerfile_args(REPO / "Dockerfile")
    assert args["HELM_VERSION"] == HELM_VERSION
    kps, loki, alloy = CHARTS["kube-prometheus-stack"], CHARTS["loki"], CHARTS["alloy"]
    assert (args["KPS_CHART_VERSION"], args["KPS_CHART_SHA256"]) == (kps.version, kps.sha256)
    assert (args["LOKI_CHART_VERSION"], args["LOKI_CHART_SHA256"]) == (loki.version, loki.sha256)
    assert (args["ALLOY_CHART_VERSION"], args["ALLOY_CHART_SHA256"]) == (
        alloy.version,
        alloy.sha256,
    )
    assert all(
        re.fullmatch(r"[0-9a-f]{64}", args[k]) for k in ("HELM_AMD64_SHA256", "HELM_ARM64_SHA256")
    )


def test_dockerfile_checks_every_download():
    args = dockerfile_args(REPO / "Dockerfile")
    stage = monitoring_tools_stage(REPO / "Dockerfile")
    assert stage.count("curl -fsSL --retry 3") == 4
    checks = [line for line in stage.splitlines() if "sha256sum --strict -c -" in line]
    assert len(checks) == 1
    check = checks[0]
    # Every downloaded file is named in the one checksum line, next to its own pinned sum.
    outputs = re.findall(r"curl -fsSL --retry 3 -o (\S+)", stage)
    assert len(outputs) == 4
    for name in outputs:
        assert name in check
    for var in ("$helm_sha", "$KPS_CHART_SHA256", "$LOKI_CHART_SHA256", "$ALLOY_CHART_SHA256"):
        assert f'"{var}"' in check
    assert "printf '%s  %s\\n'" in check
    # The chart archives come from the URLs the code pins, and Helm from get.helm.sh.
    expanded = expand(stage, args)
    for pin in CHARTS.values():
        assert pin.url in expanded
    assert "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" in stage
    assert "install -Dm755" in stage and "/out/helm" in stage
    assert "install -Dm644" in stage and "/out/charts" in stage


def test_image_ships_the_tools_where_settings_look():
    text = (REPO / "Dockerfile").read_text(encoding="utf-8")
    final = text[text.rindex("\nFROM ") :]
    assert "COPY --from=monitoring-tools /out/helm /usr/local/bin/helm" in final
    assert "COPY --from=monitoring-tools /out/charts /app/charts" in final
    assert "OMNIKRUX_HELM_BINARY=/usr/local/bin/helm" in final
    assert "OMNIKRUX_CHARTS_DIR=/app/charts" in final


def test_chart_urls_are_https_and_name_their_version():
    assert list(CHARTS) == ["kube-prometheus-stack", "loki", "alloy"]
    for key, pin in CHARTS.items():
        assert pin.key == key
        assert pin.file == f"{key}-{pin.version}.tgz"
        assert pin.url.startswith("https://")
        assert pin.url.endswith(f"/{pin.file}")
        assert re.fullmatch(r"[0-9a-f]{64}", pin.sha256)
        assert pin.app_version


def test_dev_script_reads_the_dockerfile_pins():
    script = (REPO / "scripts" / "dev-monitoring-tools.sh").read_text(encoding="utf-8")
    for arg in ("HELM_VERSION", "KPS_CHART_VERSION", "LOKI_CHART_VERSION", "ALLOY_CHART_VERSION"):
        assert f"s/^ARG {arg}=//p" in script
    assert "HELM_DEV_SHA256_windows_amd64=" in script
    assert "Checksum mismatch for" in script
    assert "Nothing was installed." in script


# --- the tools check ---------------------------------------------------------------------------


def settings(**values) -> Settings:
    return Settings(data_dir=Path("unused"), **values)


def fake_helm(tmp_path: Path) -> Path:
    helm = tmp_path / "helm"
    helm.write_bytes(b"not really helm")
    return helm


def answers(version: str):
    calls: list[Path] = []

    async def run_version(path: Path) -> str:
        calls.append(path)
        return version

    return run_version, calls


def write_charts(folder: Path, monkeypatch, *, wrong: str | None = None) -> dict[str, Path]:
    """One archive per pinned chart, with `CHARTS` patched to their sums (`wrong` gets other
    bytes than its sum)."""
    folder.mkdir(parents=True, exist_ok=True)
    patched: dict[str, ChartPin] = {}
    paths: dict[str, Path] = {}
    for key, pin in CHARTS.items():
        body = f"chart {key}".encode()
        path = folder / pin.file
        path.write_bytes(b"tampered" if key == wrong else body)
        patched[key] = ChartPin(
            key=pin.key,
            version=pin.version,
            app_version=pin.app_version,
            sha256=hashlib.sha256(body).hexdigest(),
            url=pin.url,
        )
        paths[key] = path
    monkeypatch.setattr(pins, "CHARTS", MappingProxyType(patched))
    monkeypatch.setattr(tools, "CHARTS", MappingProxyType(patched))
    return paths


async def test_tools_check_reports_missing_helm(tmp_path):
    missing = tmp_path / "nope"
    run_version, calls = answers(f"v{HELM_VERSION}")
    check = ToolsCheck(settings(helm_binary=missing, charts_dir=tmp_path), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.helm is None
    assert status.message == messages.TOOLS_NO_HELM.format(where=f" at {missing}")
    assert calls == []


async def test_tools_check_reports_helm_missing_from_path(tmp_path, monkeypatch):
    monkeypatch.setattr(tools.shutil, "which", lambda name: None)
    run_version, _ = answers(f"v{HELM_VERSION}")
    check = ToolsCheck(settings(charts_dir=tmp_path), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.message == messages.TOOLS_NO_HELM.format(where="")


async def test_tools_check_finds_helm_exe(tmp_path, monkeypatch):
    exe = tmp_path / "helm.exe"
    exe.write_bytes(b"not really helm")
    write_charts(tmp_path / "charts", monkeypatch)
    run_version, calls = answers(f"v{HELM_VERSION}")
    check = ToolsCheck(
        settings(helm_binary=tmp_path / "helm", charts_dir=tmp_path / "charts"),
        run_version=run_version,
    )
    status = await check.status()
    assert status.available is True
    assert status.helm == exe
    assert calls == [exe]


async def test_tools_check_reports_a_wrong_version(tmp_path):
    helm = fake_helm(tmp_path)
    run_version, _ = answers("v3.19.0")
    check = ToolsCheck(settings(helm_binary=helm, charts_dir=tmp_path), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.helm == helm
    assert status.helm_version == "v3.19.0"
    assert status.message == messages.TOOLS_WRONG_HELM.format(
        expected=f"v{HELM_VERSION}", path=helm, found="v3.19.0"
    )


async def test_tools_check_reports_a_helm_that_wont_answer(tmp_path):
    helm = fake_helm(tmp_path)

    async def run_version(path: Path) -> str:
        raise OSError("exec format error")

    check = ToolsCheck(settings(helm_binary=helm, charts_dir=tmp_path), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.message == messages.TOOLS_WRONG_HELM.format(
        expected=f"v{HELM_VERSION}", path=helm, found=messages.TOOLS_HELM_NO_ANSWER
    )


@pytest.mark.parametrize("error", [NotImplementedError(), ValueError("embedded null byte")])
async def test_tools_check_reports_a_helm_that_cant_be_started(tmp_path, error):
    # A selector event loop (Windows, `uvicorn --reload`) can't start programs at all.
    helm = fake_helm(tmp_path)

    async def run_version(path: Path) -> str:
        raise error

    check = ToolsCheck(settings(helm_binary=helm, charts_dir=tmp_path), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.helm_version is None
    assert status.message == messages.TOOLS_WRONG_HELM.format(
        expected=f"v{HELM_VERSION}", path=helm, found=messages.TOOLS_HELM_NO_ANSWER
    )


@pytest.mark.parametrize("printed", ["Usage: helm [command]", "3.16.3", "v3.16"])
async def test_tools_check_never_shows_other_output_as_a_version(tmp_path, printed):
    helm = fake_helm(tmp_path)
    run_version, _ = answers(printed)
    check = ToolsCheck(settings(helm_binary=helm, charts_dir=tmp_path), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.helm_version is None
    assert status.message == messages.TOOLS_WRONG_HELM.format(
        expected=f"v{HELM_VERSION}", path=helm, found=messages.TOOLS_HELM_NO_ANSWER
    )


def test_contacts_secret_line_counts_in_words():
    assert messages.contacts_secret_line(1) == (
        "Secret omnikrux-contact-points holds 1 value; it is hidden here and never shown again."
    )
    assert messages.contacts_secret_line(3) == (
        "Secret omnikrux-contact-points holds 3 values; they are hidden here and never shown again."
    )


async def test_tools_check_reports_no_charts_dir(tmp_path):
    helm = fake_helm(tmp_path)
    run_version, _ = answers(f"v{HELM_VERSION}")
    check = ToolsCheck(settings(helm_binary=helm), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.message == messages.TOOLS_NO_CHARTS_DIR


async def test_tools_check_reports_a_bad_archive(tmp_path, monkeypatch):
    helm = fake_helm(tmp_path)
    charts = tmp_path / "charts"
    write_charts(charts, monkeypatch, wrong="loki")
    run_version, _ = answers(f"v{HELM_VERSION}")
    check = ToolsCheck(settings(helm_binary=helm, charts_dir=charts), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.message == messages.TOOLS_BAD_CHART.format(
        chart="loki", dir=charts, version=CHARTS["loki"].version
    )


async def test_tools_check_reports_a_missing_archive(tmp_path, monkeypatch):
    helm = fake_helm(tmp_path)
    charts = tmp_path / "charts"
    paths = write_charts(charts, monkeypatch)
    paths["alloy"].unlink()
    run_version, _ = answers(f"v{HELM_VERSION}")
    check = ToolsCheck(settings(helm_binary=helm, charts_dir=charts), run_version=run_version)
    status = await check.status()
    assert status.available is False
    assert status.message == messages.TOOLS_BAD_CHART.format(
        chart="alloy", dir=charts, version=CHARTS["alloy"].version
    )


async def test_tools_check_accepts_pinned_files(tmp_path, monkeypatch):
    helm = fake_helm(tmp_path)
    charts = tmp_path / "charts"
    paths = write_charts(charts, monkeypatch)
    run_version, calls = answers(f"v{HELM_VERSION}\n")
    check = ToolsCheck(settings(helm_binary=helm, charts_dir=charts), run_version=run_version)
    status = await check.status()
    assert status.available is True
    assert status.message is None
    assert status.helm == helm
    assert status.helm_version == f"v{HELM_VERSION}"
    assert dict(status.charts) == paths
    # Checked once and cached; refresh() checks again.
    assert await check.status() is status
    assert calls == [helm]
    check.refresh()
    assert (await check.status()).available is True
    assert calls == [helm, helm]


@pytest.mark.parametrize(
    ("name", "template"),
    [
        ("TOOLS_NO_HELM", "{where}"),
        ("TOOLS_WRONG_HELM", "{expected}"),
        ("TOOLS_NO_CHARTS_DIR", "OMNIKRUX_CHARTS_DIR"),
        ("TOOLS_BAD_CHART", "{chart}"),
    ],
)
def test_tools_copy_points_at_the_dev_script(name, template):
    text = getattr(messages, name)
    assert template in text
    assert "scripts/dev-monitoring-tools.sh" in text
