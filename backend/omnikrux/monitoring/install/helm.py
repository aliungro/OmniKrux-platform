"""Running Helm: the only argument builders, a subprocess runner that keeps Helm away from the
console's environment and stops it on cancel or timeout, and Helm's errors in words that carry
no token, client key or (for cloud clusters) address.

Credentials never travel in arguments or environment values: Helm reads them from the private
kubeconfig file `kubeconfig.helm_kubeconfig` writes for the call, named by `KUBECONFIG`."""

import asyncio
import logging
import os
import re
import shutil
import tempfile
from base64 import b64encode
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from omnikrux.monitoring.install import messages

log = logging.getLogger(__name__)

MAX_OUTPUT = 4 * 1024 * 1024
STOP_GRACE_SECONDS = 20.0
_KILL_WAIT_SECONDS = 5.0
_DRAIN_SECONDS = 5.0
TIMEOUT_CODE = 124
# The end of a timed-out call's stderr (see `timed_out`).
TIMEOUT_MARK = "\n[omnikrux: Helm ran past its time limit and was stopped]"
MAX_REASON = 300
MASK = "•••"
_RUN_PREFIX = "omnikrux-helm-run-"
_READ_CHUNK = 64 * 1024

# Helm's own release errors: words about the release or the chart, never about the transport.
_RELEASE_ERRORS = (
    "release",
    "rendered manifests contain",
    "chart requires kubeVersion",
    "INSTALLATION FAILED",
    "UPGRADE FAILED",
)
_BEARER = re.compile(r"(?i)\b(bearer)\s+[^\s\"',;)]+")
# What looks like an address: a URL, an IP address, a host name with a port, a dial. (A bare
# dotted name is not: CRD names such as `prometheuses.monitoring.coreos.com` are Helm's words.)
_ADDRESS = re.compile(
    r"://|\b\d{1,3}(?:\.\d{1,3}){3}\b|\[[0-9a-fA-F:]+\]|\b[\w.-]+\.[A-Za-z]{2,}:\d+\b"
    r"|\bdial tcp\b"
)


@dataclass(frozen=True)
class HelmResult:
    code: int
    stdout: str
    stderr: str
    # Set on a timed-out call (`timed_out`): the time limit in seconds.
    timeout: float | None = None
    # True when Helm printed more than `max_output` bytes on stdout or stderr and the rest was
    # dropped. A cut multi-document YAML can still parse, so any caller that reads the output
    # (`template`, `show crds`) must refuse a truncated answer rather than use part of it.
    truncated: bool = False


def timed_out(stdout: str, stderr: str, timeout: float, *, truncated: bool = False) -> HelmResult:
    """The answer of a call stopped at its time limit: code 124, stderr ending in TIMEOUT_MARK."""
    return HelmResult(
        TIMEOUT_CODE, stdout, stderr + TIMEOUT_MARK, timeout=timeout, truncated=truncated
    )


class HelmRunner(Protocol):
    async def run(
        self,
        args: Sequence[str],
        *,
        kubeconfig: Path | None,
        timeout: float,
        max_output: int = MAX_OUTPUT,
    ) -> HelmResult:
        """Run Helm with these arguments. Cancelling the awaiting task stops the process."""
        ...


# ---- argument builders (pure; the only way Helm's arguments are made) ----


def template_args(
    release: str,
    chart: Path,
    namespace: str,
    values: Path,
    *,
    kube_version: str,
    api_versions: Sequence[str],
) -> list[str]:
    args = ["template", release, str(chart), "--namespace", namespace, "--values", str(values)]
    args += ["--kube-version", kube_version]
    for version in api_versions:
        args += ["--api-versions", version]
    return args


def upgrade_args(
    release: str, chart: Path, namespace: str, values: Path, *, timeout_s: int
) -> list[str]:
    return [
        "upgrade",
        "--install",
        release,
        str(chart),
        "--namespace",
        namespace,
        "--values",
        str(values),
        "--timeout",
        f"{timeout_s}s",
    ]


def uninstall_args(release: str, namespace: str, *, timeout_s: int) -> list[str]:
    return ["uninstall", release, "--namespace", namespace, "--timeout", f"{timeout_s}s"]


def show_crds_args(chart: Path) -> list[str]:
    return ["show", "crds", str(chart)]


def version_args() -> list[str]:
    return ["version", "--template", "{{.Version}}"]


# ---- the subprocess runner ----


class _Capped:
    """Reads a stream to its end, keeping at most `limit` bytes (the rest is read and dropped,
    so Helm never blocks on a full pipe)."""

    def __init__(self, limit: int):
        self.limit = limit
        self.kept = bytearray()
        self.cut = False

    async def pump(self, stream: asyncio.StreamReader) -> None:
        while chunk := await stream.read(_READ_CHUNK):
            room = self.limit - len(self.kept)
            if len(chunk) > room:
                self.cut = True
            if room > 0:
                self.kept += chunk[:room]

    def text(self) -> str:
        return self.kept.decode("utf-8", errors="replace")


def _environment(work: Path, kubeconfig: Path | None) -> dict[str, str]:
    """Only what Helm needs; its home, caches and temporary files inside the call's own folder.
    No OmniKrux setting, proxy, kube context or the user's own kubeconfig reaches it."""
    home = work / "home"
    temp = work / "tmp"
    home.mkdir()
    temp.mkdir()
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "HELM_CACHE_HOME": str(work / "cache"),
        "HELM_CONFIG_HOME": str(work / "config"),
        "HELM_DATA_HOME": str(work / "data"),
    }
    if os.name == "nt":
        env["TMP"] = env["TEMP"] = str(temp)
        # Windows programs (Go's network stack among them) can't start sockets without it.
        if systemroot := os.environ.get("SYSTEMROOT"):
            env["SYSTEMROOT"] = systemroot
    else:
        env["TMPDIR"] = str(temp)
    if kubeconfig is not None:
        env["KUBECONFIG"] = str(kubeconfig)
    return env


async def _stop(proc: asyncio.subprocess.Process) -> None:
    """terminate(), up to STOP_GRACE_SECONDS for it to end, then kill() (also when cancelled
    while waiting)."""
    if proc.returncode is not None:
        return
    with suppress(ProcessLookupError):
        proc.terminate()
    try:
        async with asyncio.timeout(STOP_GRACE_SECONDS):
            await proc.wait()
    except TimeoutError:
        pass
    finally:
        if proc.returncode is None:
            with suppress(ProcessLookupError):
                proc.kill()
    if proc.returncode is None:
        with suppress(TimeoutError):
            async with asyncio.timeout(_KILL_WAIT_SECONDS):
                await proc.wait()


async def _drain(readers: Sequence[asyncio.Task]) -> bool:
    """Let the readers reach the end of the closed pipes; cancel any still waiting (a child of
    Helm's holding a pipe open). False when one had to be cancelled: the output is incomplete."""
    pending = [r for r in readers if not r.done()]
    if pending:
        await asyncio.wait(pending, timeout=_DRAIN_SECONDS)
    complete = all(r.done() and not r.cancelled() for r in readers)
    for reader in readers:
        reader.cancel()
    await asyncio.gather(*readers, return_exceptions=True)
    return complete


class SubprocessHelm(HelmRunner):
    """Runs the Helm binary (`command`, e.g. `["/usr/local/bin/helm"]`) without a shell, with a
    minimal environment, stdin closed and each output capped. Only the subcommand and exit code
    are logged, never what Helm printed."""

    def __init__(self, command: Sequence[str]):
        if not command:
            raise ValueError("SubprocessHelm needs the Helm command")
        self._command = [str(part) for part in command]

    async def run(
        self,
        args: Sequence[str],
        *,
        kubeconfig: Path | None,
        timeout: float,
        max_output: int = MAX_OUTPUT,
    ) -> HelmResult:
        args = [str(a) for a in args]
        step = args[0] if args else "helm"
        work = Path(tempfile.mkdtemp(prefix=_RUN_PREFIX))
        try:
            return await self._run(work, args, step, kubeconfig, timeout, max_output)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    async def _run(
        self,
        work: Path,
        args: list[str],
        step: str,
        kubeconfig: Path | None,
        timeout: float,
        max_output: int,
    ) -> HelmResult:
        proc = await asyncio.create_subprocess_exec(
            *self._command,
            *args,
            env=_environment(work, kubeconfig),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = _Capped(max_output), _Capped(max_output)
        assert proc.stdout is not None and proc.stderr is not None
        readers = (
            asyncio.create_task(out.pump(proc.stdout)),
            asyncio.create_task(err.pump(proc.stderr)),
        )
        limit = asyncio.timeout(timeout)
        try:
            try:
                async with limit:
                    await asyncio.wait(readers)
                    await proc.wait()
            except TimeoutError:
                await _stop(proc)
                if not limit.expired():
                    raise
                complete = await _drain(readers)
                log.warning("Helm %s ran past its %g s limit and was stopped", step, timeout)
                return timed_out(
                    out.text(), err.text(), timeout, truncated=out.cut or err.cut or not complete
                )
            except BaseException:
                log.info("Helm %s was stopped before it finished", step)
                await _stop(proc)
                raise
            complete = await _drain(readers)
            code = proc.returncode if proc.returncode is not None else -1
            log.info("Helm %s ended with exit code %d", step, code)
            return HelmResult(
                code, out.text(), err.text(), truncated=out.cut or err.cut or not complete
            )
        finally:
            # Every ending (also a cancel during the terminate grace) leaves no reader behind.
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)


# ---- words ----


def _scrub_values(secrets: Sequence[str]) -> list[str]:
    """Each secret, its base64 form, and each line of a multi-line one (a PEM key), longest
    first so no shorter piece leaves part of a longer one behind."""
    values: set[str] = set()
    for secret in secrets:
        if not secret:
            continue
        values.add(secret)
        values.add(b64encode(secret.encode()).decode())
        for line in secret.splitlines():
            line = line.strip()
            if len(line) >= 16 and "PRIVATE KEY" not in line:
                values.add(line)
    return sorted(values, key=len, reverse=True)


def _scrub(text: str, secrets: Sequence[str], hosts: Sequence[str]) -> str:
    for value in _scrub_values(secrets):
        text = text.replace(value, MASK)
    for host in sorted((h for h in hosts if h), key=len, reverse=True):
        text = re.sub(re.escape(host), MASK, text, flags=re.IGNORECASE)
    return _BEARER.sub(rf"\1 {MASK}", text)


def _one_line(text: str) -> str:
    return " ".join("".join(c if c.isprintable() else " " for c in text).split())


def _reason(stderr: str) -> str | None:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("Error:")]
    if errors:
        return errors[-1].removeprefix("Error:").strip() or None
    return lines[-1] if lines else None


def _mentions_an_address(reason: str, secrets: Sequence[str], hosts: Sequence[str]) -> bool:
    lowered = reason.lower()
    if any(h and h.lower() in lowered for h in hosts):
        return True
    if any(value in reason for value in _scrub_values(secrets)):
        return True
    return _ADDRESS.search(reason) is not None


def helm_error_message(
    result: HelmResult,
    *,
    step: str,
    secrets: Sequence[str],
    hosts: Sequence[str],
    cloud: bool,
) -> str:
    """Helm's failure in plain words: its last `Error:` line (else its last line), with every
    secret and host as `•••`, at most 300 characters. A cloud cluster keeps the cloud privacy
    rule: only Helm's own release errors that name no address are shown, anything else reads
    as the cluster refusing or not answering."""
    if result.timeout is not None:
        return messages.HELM_TIMEOUT.format(step=step, minutes=f"{result.timeout / 60:g}")
    raw = _reason(result.stderr)
    if raw is None:
        return messages.HELM_FAILED.format(
            step=step, reason=messages.HELM_NO_REASON.format(code=result.code)
        )
    if cloud and (not raw.startswith(_RELEASE_ERRORS) or _mentions_an_address(raw, secrets, hosts)):
        return messages.HELM_FAILED_CLOUD.format(step=step)
    reason = _one_line(_scrub(raw, secrets, hosts))[:MAX_REASON]
    return messages.HELM_FAILED.format(step=step, reason=reason)
