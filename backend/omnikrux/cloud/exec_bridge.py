"""Resolve kubeconfig exec authentication against mounted cloud logins."""

import asyncio
import shutil
from collections.abc import Callable
from pathlib import PureWindowsPath

from omnikrux.cloud import messages
from omnikrux.cloud.aws import AwsProfileLogin, assume_role, eks_token
from omnikrux.cloud.azure import AzureCliLogin, AzureCliMissing, AzureCliUnavailable
from omnikrux.cloud.dirs import CloudDirs
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.oci import OciProfileLogin, oke_token
from omnikrux.cloud.types import AWS_REGION
from omnikrux.kube.tokens import (
    BearerToken,
    CloudClusterUnavailable,
    ClusterUnavailable,
    ExecPlan,
    NativeToken,
    RunPlugin,
    TokenFetch,
    utcnow,
)

_EKS = ("eks", "get-token")
_AUTHENTICATOR = ("token",)
_OKE = ("ce", "cluster", "generate-token")
_AWS_OPTIONS = {"--profile": "profile", "--region": "region"}
_EKS_OPTIONS = {
    **_AWS_OPTIONS,
    "--cluster-name": "cluster",
    "--cluster-id": "cluster",
    "--role-arn": "role",
    "--role": "role",
    "--output": "output",
}
_AUTHENTICATOR_OPTIONS = {**_AWS_OPTIONS, "-i": "cluster", "-r": "role"}
_OCI_OPTIONS = {
    "--cluster-id": "cluster",
    "--region": "region",
    "--profile": "profile",
    "--auth": "auth",
}
_AZURE_OPTIONS = {
    "--login": "login",
    "-l": "login",
    "--server-id": "server",
    "--tenant-id": "tenant",
}
_AZURE_MODES = {"azurecli", "devicecode", "interactive"}
_ADC_FLAG = "--use_application_default_credentials"
_CLOUD_COMMANDS = {"aws", "aws-iam-authenticator", "oci", "kubelogin", "gke-gcloud-auth-plugin"}


def _invalid_config(command: str) -> ClusterUnavailable:
    return ClusterUnavailable(
        messages.failed_exec(command, "the login command configuration is invalid")
    )


def _args(config: dict, command: str) -> list[str]:
    args = config.get("args")
    if args is None:
        return []
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        raise _invalid_config(command)
    return args


def _env(config: dict, command: str) -> dict[str, str]:
    entries = config.get("env")
    if entries is None:
        return {}
    if not isinstance(entries, list) or not all(
        isinstance(entry, dict)
        and isinstance(entry.get("name"), str)
        and isinstance(entry.get("value"), str)
        for entry in entries
    ):
        raise _invalid_config(command)
    return {entry["name"]: entry["value"] for entry in entries}


def _parse(
    args: list[str], names: dict[str, str], *, allow_extra: bool = False
) -> tuple[tuple[str, ...], dict[str, str]]:
    positionals = []
    options = {}
    remaining = iter(args)
    for arg in remaining:
        flag, equals, value = arg.partition("=")
        if flag in names:
            name = names[flag]
            if not equals:
                value = next(remaining, "")
            if not value or value.startswith("-") or name in options:
                raise ValueError
            options[name] = value
        elif not allow_extra:
            if arg.startswith("-"):
                raise ValueError
            positionals.append(arg)
    return tuple(positionals), options


def _unsupported(
    command: str, supported: tuple[str, ...], account: str, invoked: tuple[str, ...] = ()
) -> ClusterUnavailable:
    # Report known command words only. Arbitrary arguments can contain credentials.
    known = (
        supported,
        ("sts", "get-caller-identity"),
        ("sso", "login"),
        ("eks", "describe-cluster"),
    )
    subcommand = " ".join(invoked) if invoked in known else None
    return ClusterUnavailable(
        messages.unsupported_exec(command, subcommand, " ".join((command, *supported)), account)
    )


class ExecBridge:
    def __init__(
        self,
        dirs: CloudDirs,
        endpoints: CloudEndpoints,
        http: CloudHttp,
        *,
        which: Callable[[str], str | None] = shutil.which,
    ):
        self._dirs = dirs
        self._endpoints = endpoints
        self._http = http
        self._which = which
        self._refreshes: set[asyncio.Future[None]] = set()
        self._closed = False

    async def close(self) -> None:
        self._closed = True
        if self._refreshes:
            await asyncio.wait(tuple(self._refreshes))

    def _native(self, fetch: TokenFetch) -> NativeToken:
        async def token() -> BearerToken:
            if self._closed:
                raise CloudClusterUnavailable("The console is shutting down. Try again shortly.")
            # CachedToken shields this task even after every caller leaves or forgets the cluster.
            finished = asyncio.get_running_loop().create_future()
            self._refreshes.add(finished)
            try:
                return await fetch()
            except CloudError as exc:
                raise CloudClusterUnavailable(exc.message) from None
            finally:
                self._refreshes.remove(finished)
                finished.set_result(None)

        return NativeToken(token, cloud=True)

    def resolve(self, exec_cfg: dict) -> ExecPlan:
        command = exec_cfg.get("command")
        if not isinstance(command, str):
            return RunPlugin(exec_cfg)
        name = PureWindowsPath(command).name.casefold().removesuffix(".exe")
        if name in {"aws", "aws-iam-authenticator"} and self._which(name) is None:
            return self._aws(name, exec_cfg)
        if name == "oci" and self._which(name) is None:
            return self._oci(exec_cfg)
        if name == "kubelogin":
            # A real kubelogin with the Azure CLI beside it runs as-is; the bridge serves the rest.
            installed = self._which("kubelogin") is not None and self._which("az") is not None
            return self._azure(exec_cfg, bridge=not installed)
        if name == "gke-gcloud-auth-plugin" and self._which("gcloud") is None:
            return self._gke(exec_cfg)
        return RunPlugin(exec_cfg, cloud=name in _CLOUD_COMMANDS)

    def _aws(self, command: str, config: dict) -> NativeToken:
        authenticator = command == "aws-iam-authenticator"
        supported = _AUTHENTICATOR if authenticator else _EKS
        names = _AUTHENTICATOR_OPTIONS if authenticator else _EKS_OPTIONS
        args = _args(config, command)
        try:
            invoked, options = _parse(args, names)
        except ValueError:
            raise _unsupported(command, supported, "AWS account") from None
        cluster = options.get("cluster")
        if invoked != supported or not cluster or options.get("output", "json") != "json":
            raise _unsupported(command, supported, "AWS account", invoked)
        env = _env(config, command)
        profile = options.get("profile") or env.get("AWS_PROFILE") or "default"
        region = options.get("region") or env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION")
        role = options.get("role")
        login = AwsProfileLogin(self._dirs.aws, profile, self._endpoints)

        async def fetch() -> BearerToken:
            selected_region = region
            if not selected_region and authenticator:
                selected_region = await asyncio.to_thread(login.region)
            if not selected_region:
                raise _unsupported(command, supported, "AWS account", invoked)
            if not AWS_REGION.fullmatch(selected_region):
                raise ClusterUnavailable("Choose a valid AWS region.")
            keys = await login.keys()
            if role:
                keys = await assume_role(keys, role, selected_region, self._endpoints)
            return eks_token(keys, cluster, selected_region, self._endpoints, now=utcnow())

        return self._native(fetch)

    def _oci(self, config: dict) -> NativeToken:
        args = _args(config, "oci")
        try:
            invoked, options = _parse(args, _OCI_OPTIONS)
        except ValueError:
            raise _unsupported("oci", _OKE, "Oracle Cloud tenancy") from None
        cluster, region = options.get("cluster"), options.get("region")
        auth = options.get("auth", "api_key")
        if (
            invoked != _OKE
            or not cluster
            or not region
            or auth not in ("api_key", "security_token")
        ):
            raise _unsupported("oci", _OKE, "Oracle Cloud tenancy", invoked)

        def signer():
            return OciProfileLogin(self._dirs.oci, options.get("profile", "DEFAULT")).signer(
                auth=auth
            )

        async def fetch() -> BearerToken:
            return oke_token(
                await asyncio.to_thread(signer), cluster, region, self._endpoints, now=utcnow()
            )

        return self._native(fetch)

    def _azure(self, config: dict, *, bridge: bool) -> ExecPlan:
        plugin = RunPlugin(config, env={"AZURE_CONFIG_DIR": str(self._dirs.azure)}, cloud=True)
        args = _args(config, "kubelogin")
        if not bridge or not args or args[0] != "get-token":
            return plugin
        try:
            _, options = _parse(args[1:], _AZURE_OPTIONS, allow_extra=True)
        except ValueError:
            raise _invalid_config("kubelogin") from None
        mode = options.get("login") or _env(config, "kubelogin").get("AAD_LOGIN_METHOD")
        if mode not in _AZURE_MODES:
            return plugin
        server = options.get("server")
        if not server or not server.isascii() or not server.isprintable() or " " in server:
            raise _invalid_config("kubelogin")
        tenant = options.get("tenant")
        login = AzureCliLogin(self._dirs.azure, self._http, self._endpoints)

        async def fetch() -> BearerToken:
            try:
                selected_tenant = tenant
                if selected_tenant is None:
                    default = next(
                        (item for item in login.subscriptions() if item.is_default), None
                    )
                    if default is None:
                        raise ClusterUnavailable(messages.unsupported_kubelogin(mode))
                    selected_tenant = default.tenant_id
                return await login.token(selected_tenant, f"{server}/.default")
            except AzureCliMissing:
                raise ClusterUnavailable(messages.unsupported_kubelogin(mode)) from None
            except AzureCliUnavailable as exc:  # a login exists: say what is wrong with it
                raise ClusterUnavailable(exc.message) from None

        return self._native(fetch)

    def _gke(self, config: dict) -> RunPlugin:
        args = _args(config, "gke-gcloud-auth-plugin")
        adc = self._dirs.gcloud / "application_default_credentials.json"
        if not adc.is_file():
            raise ClusterUnavailable(messages.no_adc())
        if _ADC_FLAG not in args:
            config = {**config, "args": [*args, _ADC_FLAG]}
        return RunPlugin(config, env={"GOOGLE_APPLICATION_CREDENTIALS": str(adc)}, cloud=True)
