"""In-memory credentials for Kubernetes API requests."""

import asyncio
import json
import os
import shutil
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

NO_EXPIRY_CACHE_SECONDS = 300
# After a failed refresh, a still-valid token is served this long before the next attempt.
REFRESH_RETRY_SECONDS = 10
EXEC_PLUGIN_TIMEOUT_SECONDS = 20
EXEC_PLUGIN_CLEANUP_SECONDS = 1


class ClusterUnavailable(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class CloudClusterUnavailable(ClusterUnavailable):
    """A cloud cluster diagnostic that is safe to publish and log."""


@dataclass(frozen=True)
class BearerToken:
    value: str = field(repr=False)
    expires_at: datetime | None


TokenFetch = Callable[[], Awaitable[BearerToken]]
TokenSource = Callable[[], Awaitable[BearerToken]]


def reject_token(source: object, value: str) -> None:
    """The cluster answered 401 to `value`: a source that caches tokens drops it (once)."""
    reject = getattr(source, "reject", None)
    if callable(reject):
        reject(value)


@dataclass(frozen=True)
class CloudTokenSource:
    fetch: TokenSource

    async def __call__(self) -> BearerToken:
        return await self.fetch()

    def reject(self, value: str) -> None:
        reject_token(self.fetch, value)


def utcnow() -> datetime:
    return datetime.now(UTC)


def require_live_token(token: BearerToken, now: datetime) -> None:
    if token.expires_at is not None and token.expires_at <= now:
        raise ClusterUnavailable(
            "The cluster login returned an expired token. Check the login, then try again."
        )


def refresh_due(token: BearerToken, fetched_at: datetime, now: datetime) -> bool:
    if token.expires_at is None:
        return now - fetched_at >= timedelta(seconds=NO_EXPIRY_CACHE_SECONDS)
    lifetime = token.expires_at - fetched_at
    return token.expires_at - now <= min(timedelta(seconds=120), lifetime / 4)


class CachedToken:
    """Share one refresh, even when a request waiting on it is cancelled. A refresh that fails
    while the cached token is still valid serves that token, and tries again after
    REFRESH_RETRY_SECONDS; failures are never cached."""

    def __init__(self, fetch: TokenFetch, *, clock: Callable[[], datetime] = utcnow):
        self._fetch = fetch
        self._clock = clock
        self._cached: tuple[BearerToken, datetime] | None = None
        self._retry_at: datetime | None = None
        self._pending: tuple[asyncio.Task[BearerToken], int] | None = None
        self._generation = 0

    def _still_valid(self, now: datetime) -> BearerToken | None:
        if self._cached is None:
            return None
        token = self._cached[0]
        return token if token.expires_at is None or token.expires_at > now else None

    async def __call__(self) -> BearerToken:
        while True:
            if self._cached is not None:
                token, fetched_at = self._cached
                now = self._clock()
                if not refresh_due(token, fetched_at, now):
                    return token
                waiting = self._retry_at is not None and now < self._retry_at
                if waiting and self._still_valid(now) is token:
                    return token

            if self._pending is None:
                generation = self._generation
                pending = asyncio.create_task(self._refresh(generation))
                pending.add_done_callback(self._retrieve_exception)
                self._pending = pending, generation
            pending, generation = self._pending
            try:
                token = await asyncio.shield(pending)
            except Exception:
                if generation == self._generation:
                    if (valid := self._still_valid(self._clock())) is not None:
                        return valid
                    raise
            else:
                if generation == self._generation:
                    return token

    async def _refresh(self, generation: int) -> BearerToken:
        try:
            token = await self._fetch()
            fetched_at = self._clock()
            require_live_token(token, fetched_at)
            if generation == self._generation:
                self._cached = token, fetched_at
                self._retry_at = None
            return token
        except Exception:
            if generation == self._generation:
                self._retry_at = self._clock() + timedelta(seconds=REFRESH_RETRY_SECONDS)
            raise
        finally:
            self._pending = None

    @staticmethod
    def _retrieve_exception(task: asyncio.Task[BearerToken]) -> None:
        # A cancelled request can leave the shared refresh without a waiter.
        if not task.cancelled():
            task.exception()

    def invalidate(self) -> None:
        # An already running fetch may finish, but cannot repopulate the invalidated cache.
        self._generation += 1
        self._cached = None
        self._retry_at = None

    def reject(self, value: str) -> None:
        """The cluster refused `value` (401): the next request fetches a new token. A late 401
        for a token already replaced changes nothing."""
        if self._cached is not None and self._cached[0].value == value:
            self._cached = None
            self._retry_at = None


@dataclass(frozen=True)
class RunPlugin:
    exec_cfg: dict = field(repr=False)
    env: dict[str, str] = field(default_factory=dict, repr=False)
    cloud: bool = False


@dataclass(frozen=True)
class NativeToken:
    fetch: TokenFetch
    cloud: bool = False


ExecPlan = RunPlugin | NativeToken
ExecResolver = Callable[[dict], ExecPlan]


class UnsupportedPluginOutput(Exception):
    """The loader can use the returned certificate and key as TLS client credentials."""

    def __init__(self, certificate: str, key: str):
        super().__init__("The login command returned a client certificate.")
        self.certificate = certificate
        self.key = key


async def _stop_plugin(proc: asyncio.subprocess.Process) -> None:
    # Process has no public pipe-close API. Closing its transport releases the local pipe ends
    # and stops the login process even if a descendant inherited stdout or stderr.
    proc._transport.close()
    with suppress(TimeoutError):
        async with asyncio.timeout(EXEC_PLUGIN_CLEANUP_SECONDS):
            await proc.wait()


class ExecPluginToken:
    def __init__(self, plan: RunPlugin):
        self._plan = plan

    async def __call__(self) -> BearerToken:
        cfg = self._plan.exec_cfg
        command = cfg.get("command")
        if not isinstance(command, str) or not command:
            raise ClusterUnavailable(
                "This cluster's login command is missing. Check the kubeconfig."
            )
        executable = shutil.which(command)
        if executable is None:
            raise ClusterUnavailable(
                f"This cluster signs in with '{command}', which isn't installed in the console."
            )
        failure = f"This cluster signs in with '{command}', which failed: "
        version = cfg.get("apiVersion")
        args = cfg.get("args") or []
        if not isinstance(version, str) or not isinstance(args, list):
            raise ClusterUnavailable(failure + "the login command configuration is invalid")
        try:
            # The console's own settings (its secret key, database URL) never reach a plugin.
            env = {k: v for k, v in os.environ.items() if not k.upper().startswith("OMNIKRUX_")}
            env |= {item["name"]: item["value"] for item in (cfg.get("env") or [])}
            env.update(self._plan.env)
            env["KUBERNETES_EXEC_INFO"] = json.dumps(
                {"apiVersion": version, "kind": "ExecCredential", "spec": {"interactive": False}}
            )
        except (KeyError, TypeError, ValueError):
            raise ClusterUnavailable(
                failure + "the login command configuration is invalid"
            ) from None
        proc = None
        try:
            async with asyncio.timeout(EXEC_PLUGIN_TIMEOUT_SECONDS):
                proc = await asyncio.create_subprocess_exec(
                    executable,
                    *args,
                    env=env,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _stderr = await proc.communicate()
        except TimeoutError:
            if proc is not None:
                await _stop_plugin(proc)
            raise ClusterUnavailable(
                failure
                + f"the login command did not finish within {EXEC_PLUGIN_TIMEOUT_SECONDS:g} s"
            ) from None
        except asyncio.CancelledError:
            if proc is not None:
                await _stop_plugin(proc)
            raise
        except (TypeError, ValueError):
            raise ClusterUnavailable(
                failure + "the login command configuration is invalid"
            ) from None
        except (OSError, NotImplementedError):
            raise ClusterUnavailable(failure + "the login command could not be started") from None
        if proc.returncode != 0:
            raise ClusterUnavailable(
                failure + f"the login command exited with status {proc.returncode}"
            )
        try:
            return _parse_output(stdout, version)
        except (ValueError, TypeError, OverflowError, RecursionError):
            pass
        raise ClusterUnavailable(failure + "the login command returned invalid credentials")


def _parse_output(stdout: bytes, version: str) -> BearerToken:
    result = json.loads(stdout)
    if (
        not isinstance(result, dict)
        or result.get("kind") != "ExecCredential"
        or result.get("apiVersion") != version
        or not isinstance(status := result.get("status"), dict)
    ):
        raise ValueError("Invalid ExecCredential")

    token = status.get("token")
    if token is None:
        certificate, key = status.get("clientCertificateData"), status.get("clientKeyData")
        if isinstance(certificate, str) and certificate and isinstance(key, str) and key:
            raise UnsupportedPluginOutput(certificate, key)
    if not isinstance(token, str) or not token or not token.isascii() or not token.isprintable():
        raise ValueError("Invalid bearer token")
    if " " in token:
        raise ValueError("Invalid bearer token")

    expires_at = None
    if "expirationTimestamp" in status:
        expires_at = datetime.fromisoformat(status["expirationTimestamp"])
        if expires_at.tzinfo is None:
            raise ValueError("Expiry must include a time zone")
        expires_at = expires_at.astimezone(UTC)
    return BearerToken(token, expires_at)
