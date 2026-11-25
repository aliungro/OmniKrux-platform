"""The tools check: is the pinned Helm here, and are the pinned chart archives here, byte for byte?

The image ships both (`OMNIKRUX_HELM_BINARY`, `OMNIKRUX_CHARTS_DIR`); outside it,
`scripts/dev-monitoring-tools.sh` puts them in `.tools/`. The answer is checked once and kept
until `refresh()`."""

import asyncio
import hashlib
import os
import re
import shutil
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType

from omnikrux.config import Settings
from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.pins import CHARTS, HELM_VERSION

HELM_VERSION_TIMEOUT_SECONDS = 5.0
# What `helm version --template {{.Version}}` prints, e.g. v3.16.3 (or v3.16.3+gabc).
_HELM_VERSION = re.compile(r"v\d+\.\d+\.\d+\S*")
_STOP_SECONDS = 2.0


@dataclass(frozen=True)
class ToolsStatus:
    available: bool
    message: str | None
    helm: Path | None
    helm_version: str | None
    charts: Mapping[str, Path] = field(default_factory=lambda: MappingProxyType({}))


async def run_helm_version(path: Path) -> str:
    """`helm version --template {{.Version}}` within 5 seconds; OSError or TimeoutError when it
    can't run, fails or takes longer."""
    # OmniKrux's own settings (its secret key, database URL) never reach Helm.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("OMNIKRUX_")}
    proc = await asyncio.create_subprocess_exec(
        str(path),
        "version",
        "--template",
        "{{.Version}}",
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with asyncio.timeout(HELM_VERSION_TIMEOUT_SECONDS):
            stdout, _ = await proc.communicate()
    except BaseException:
        if proc.returncode is None:
            with suppress(ProcessLookupError):
                proc.kill()
            with suppress(TimeoutError):
                async with asyncio.timeout(_STOP_SECONDS):
                    await proc.wait()
        raise
    if proc.returncode != 0:
        raise OSError(f"helm version exited with status {proc.returncode}")
    return stdout.decode("utf-8", errors="replace")


def _find_helm(configured: Path | None) -> Path | None:
    """The configured file (or the same name with `.exe`, for a Windows host), or `helm` on PATH."""
    if configured is None:
        found = shutil.which("helm")
        return Path(found) if found else None
    for candidate in (configured, configured.with_name(configured.name + ".exe")):
        if candidate.is_file():
            return candidate
    return None


def _sha256(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as f:
            while chunk := f.read(1 << 20):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _check_charts(folder: Path) -> tuple[str | None, dict[str, Path]]:
    found: dict[str, Path] = {}
    for key, pin in CHARTS.items():
        path = folder / pin.file
        if _sha256(path) != pin.sha256:
            return messages.TOOLS_BAD_CHART.format(chart=key, dir=folder, version=pin.version), {}
        found[key] = path
    return None, found


class ToolsCheck:
    def __init__(
        self,
        settings: Settings,
        *,
        run_version: Callable[[Path], Awaitable[str]] | None = None,
    ):
        self._helm_binary = settings.helm_binary
        self._charts_dir = settings.charts_dir
        self._run_version = run_version or run_helm_version
        self._status: ToolsStatus | None = None
        self._lock = asyncio.Lock()

    async def status(self) -> ToolsStatus:
        if self._status is not None:
            return self._status
        async with self._lock:
            if self._status is None:
                self._status = await self._check()
            return self._status

    def refresh(self) -> None:
        self._status = None

    async def _check(self) -> ToolsStatus:
        helm = await asyncio.to_thread(_find_helm, self._helm_binary)
        if helm is None:
            where = f" at {self._helm_binary}" if self._helm_binary is not None else ""
            return ToolsStatus(False, messages.TOOLS_NO_HELM.format(where=where), None, None)
        expected = f"v{HELM_VERSION}"
        try:
            version: str | None = (await self._run_version(helm)).strip()
        except (OSError, TimeoutError, NotImplementedError, ValueError):
            # NotImplementedError: a selector event loop (Windows, `uvicorn --reload`) can't run
            # programs; ValueError: arguments the platform refuses.
            version = None
        if version is not None and _HELM_VERSION.fullmatch(version) is None:
            version = None  # what it printed isn't a version: never shown as one
        if version != expected:
            found = version or messages.TOOLS_HELM_NO_ANSWER
            message = messages.TOOLS_WRONG_HELM.format(expected=expected, path=helm, found=found)
            return ToolsStatus(False, message, helm, version)
        if self._charts_dir is None:
            return ToolsStatus(False, messages.TOOLS_NO_CHARTS_DIR, helm, version)
        problem, charts = await asyncio.to_thread(_check_charts, self._charts_dir)
        if problem is not None:
            return ToolsStatus(False, problem, helm, version)
        return ToolsStatus(True, None, helm, version, MappingProxyType(charts))
