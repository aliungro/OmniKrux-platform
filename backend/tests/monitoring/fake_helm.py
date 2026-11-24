"""A Helm runner for tests: it records every call (with the kubeconfig text as it was during the
call) and answers from a script, so no test needs a real Helm or a real cluster."""

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType

import pytest

from omnikrux.config import Settings
from omnikrux.monitoring.install.helm import HelmResult, HelmRunner
from omnikrux.monitoring.install.pins import CHARTS, HELM_VERSION
from omnikrux.monitoring.install.tools import ToolsCheck, ToolsStatus

REPO = Path(__file__).resolve().parents[3]

NO_PINNED_TOOLS = (
    "The pinned Helm and charts aren't in .tools/ (run scripts/dev-monitoring-tools.sh)."
)

Answer = HelmResult | Callable[[list[str]], Awaitable[HelmResult]]


@dataclass(frozen=True)
class FakeCall:
    args: list[str]
    kubeconfig_text: str | None
    # Where the kubeconfig was during the call (its folder must be gone once the call ended),
    # and the time limit the caller gave.
    kubeconfig: Path | None = None
    timeout: float | None = None


@dataclass
class FakeHelm(HelmRunner):
    """`script` answers by the first argument (`template`, `upgrade`, `uninstall`, `show`, …);
    calls whose first argument is in `hang` wait until they are cancelled. Without a script entry:
    `template` answers `rendered[release]` (empty when unknown), `upgrade` adds a revision to
    `releases[(release, namespace)]`, `uninstall` removes it (Helm's "not found" error when
    there is none), `version` answers the pinned version, and anything else succeeds silently.
    A successful scripted `upgrade` adds a revision too."""

    calls: list[FakeCall] = field(default_factory=list)
    script: dict[str, Answer] = field(default_factory=dict)
    hang: set[str] = field(default_factory=set)
    releases: dict[tuple[str, str], int] = field(default_factory=dict)
    rendered: dict[str, str] = field(default_factory=dict)

    async def run(
        self,
        args: Sequence[str],
        *,
        kubeconfig: Path | None,
        timeout: float,
        max_output: int = 4 * 1024 * 1024,
    ) -> HelmResult:
        args = [str(a) for a in args]
        text = kubeconfig.read_text(encoding="utf-8") if kubeconfig is not None else None
        self.calls.append(FakeCall(args, text, kubeconfig, timeout))
        command = args[0] if args else ""
        if command in self.hang:
            await asyncio.Event().wait()
        answer = self.script.get(command)
        if answer is None:
            result = self._default(command, args)
        elif isinstance(answer, HelmResult):
            result = answer
        else:
            result = await answer(args)
        if command == "upgrade" and result.code == 0 and answer is not None:
            self._add_revision(args)
        return result

    def _default(self, command: str, args: list[str]) -> HelmResult:
        if command == "template":
            return HelmResult(0, self.rendered.get(args[1], ""), "")
        if command == "upgrade":
            self._add_revision(args)
            return HelmResult(0, "", "")
        if command == "uninstall":
            key = (args[1], _namespace(args))
            if self.releases.pop(key, None) is None:
                return HelmResult(
                    1, "", f"Error: uninstall: Release not loaded: {args[1]}: release: not found\n"
                )
            return HelmResult(0, f'release "{args[1]}" uninstalled\n', "")
        if command == "version":
            return HelmResult(0, f"v{HELM_VERSION}", "")
        return HelmResult(0, "", "")

    def _add_revision(self, args: list[str]) -> None:
        key = (args[2], _namespace(args))
        self.releases[key] = self.releases.get(key, 0) + 1


def _namespace(args: list[str]) -> str:
    return args[args.index("--namespace") + 1] if "--namespace" in args else "default"


class AvailableTools(ToolsCheck):
    """A tools check that reports the pinned Helm and charts available, at placeholder paths."""

    def __init__(self):
        super().__init__(Settings(kubeconfig="", in_container=False))

    async def _check(self) -> ToolsStatus:
        charts = {key: Path("/charts") / pin.file for key, pin in CHARTS.items()}
        return ToolsStatus(True, None, Path("/helm"), f"v{HELM_VERSION}", MappingProxyType(charts))


def pinned_tools() -> tuple[Path, Path]:
    """The worktree's `.tools/` Helm (`helm` or `helm.exe`) and charts folder, found here because
    the test settings never carry OMNIKRUX_* variables; the test is skipped when they're absent."""
    tools = REPO / ".tools"
    helm = next((p for p in (tools / "helm", tools / "helm.exe") if p.is_file()), None)
    charts = tools / "charts"
    if helm is None or not all((charts / pin.file).is_file() for pin in CHARTS.values()):
        pytest.skip(NO_PINNED_TOOLS)
    return helm, charts
