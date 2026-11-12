"""Read AWS CLI profiles and discover EKS clusters through regional AWS endpoints."""

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
from contextlib import ExitStack, closing
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import local

from botocore import UNSIGNED
from botocore.auth import SIGV4_TIMESTAMP, SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from botocore.credentials import (
    ConfigProvider,
    CredentialResolver,
    Credentials,
    SharedCredentialProvider,
    SSOProvider,
)
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectTimeoutError,
    ParamValidationError,
    ReadTimeoutError,
)
from botocore.loaders import Loader
from botocore.parsers import ResponseParserError
from botocore.session import Session
from botocore.tokens import TokenProviderChain

from omnikrux.cloud import messages
from omnikrux.cloud.adapters import (
    AccountIdentity,
    Choice,
    CliLoginInfo,
    ClusterAccess,
    DiscoveryResult,
)
from omnikrux.cloud.dirs import folder_state
from omnikrux.cloud.endpoints import CloudEndpoints, same_origin
from omnikrux.cloud.http import CLOUD_TIMEOUT_SECONDS, CloudError, cloud_error
from omnikrux.cloud.types import (
    AWS_REGION,
    PROFILE_NAME,
    AccountConfig,
    CloudClusterRef,
    DiscoveredCluster,
    NodePool,
)
from omnikrux.kube.tokens import BearerToken, TokenFetch, utcnow

# SDK diagnostics can include authorization headers, canonical requests and
# plaintext role credentials. Keep that namespace out of application logs.
_sdk_logger = logging.getLogger("botocore")
_sdk_logger.addHandler(logging.NullHandler())
_sdk_logger.propagate = False
for _name in ("auth", "credentials", "endpoint", "parsers"):
    logging.getLogger(f"botocore.{_name}").disabled = True

EKS_TOKEN_SECONDS = 840
_AWS_CLI = "AWS CLI"
_CLUSTER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
# SDK clients authenticate only with explicit credentials (or unsigned SSO). Drop
# session environment overrides so custom profiles, model paths and auth stay local.
_SDK_SESSION_VARS = {
    name: (None, None, default, convert)
    for name, (_, _, default, convert) in Session.SESSION_VARIABLES.items()
}
_SDK_THREAD = local()
_SDK_CONFIG = Config(
    connect_timeout=CLOUD_TIMEOUT_SECONDS,
    read_timeout=CLOUD_TIMEOUT_SECONDS,
    retries={"total_max_attempts": 1, "mode": "standard"},
    proxies={},
)


@dataclass(frozen=True)
class AwsKeys:
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)
    session_token: str | None = field(repr=False)


def _region(value: object) -> str:
    if not isinstance(value, str) or not AWS_REGION.fullmatch(value):
        raise CloudError("Choose a valid AWS region.")
    return value


def _cluster_name(value: object) -> str:
    if not isinstance(value, str) or not _CLUSTER_NAME.fullmatch(value):
        raise CloudError("AWS sent an invalid EKS cluster or node group name.")
    return value


def _sdk_session() -> Session:
    # Botocore sessions keep mutable client state. Each worker reuses only its
    # own session and service models, and each operation closes its own client.
    if not hasattr(_SDK_THREAD, "session"):
        session = Session(session_vars=_SDK_SESSION_VARS)
        session.set_config_variable("config_file", os.devnull)
        session.set_config_variable("credentials_file", os.devnull)
        session.register_component("credential_provider", CredentialResolver([]))
        session.register_component("token_provider", TokenProviderChain([]))
        session.register_component(
            "data_loader",
            Loader(
                extra_search_paths=[Loader.BUILTIN_DATA_PATH], include_default_search_paths=False
            ),
        )
        _SDK_THREAD.session = session
    return _SDK_THREAD.session


def _client(service, region, endpoints, action, keys: AwsKeys | None = None):
    endpoint = endpoints.url(f"aws_{service}", _region(region))
    if not same_origin(endpoint, endpoint):
        raise CloudError("AWS has an invalid endpoint. Check the cloud endpoint.")
    session = _sdk_session()
    if keys is None:
        client = session.create_client(
            service,
            region_name=region,
            endpoint_url=endpoint,
            verify=True,
            config=_SDK_CONFIG.merge(Config(signature_version=UNSIGNED)),
        )
    else:
        client = session.create_client(
            service,
            region_name=region,
            endpoint_url=endpoint,
            verify=True,
            config=_SDK_CONFIG,
            aws_access_key_id=keys.access_key_id,
            aws_secret_access_key=keys.secret_access_key,
            aws_session_token=keys.session_token,
        )

    def protect_origin(request, **_kwargs):
        if not same_origin(request.url, endpoint):
            raise CloudError("AWS tried to change the cloud endpoint. Check the cloud endpoint.")

    def validate_response(operation_model, response_dict, **_kwargs):
        status = response_dict["status_code"]
        if status >= 300:
            # The status is sufficient for safe copy. Do not let botocore model
            # or log arbitrary upstream error text and error codes.
            raise cloud_error("AWS", action, status=status)
        field = {"ListClusters": "clusters", "ListNodegroups": "nodegroups"}.get(
            operation_model.name
        )
        if service == "eks" and field is not None:
            try:
                body = json.loads(response_dict["body"])
            except (ValueError, TypeError, RecursionError):
                raise _unreadable_reply(action) from None
            if not isinstance(body, dict) or not isinstance(body.get(field), list):
                raise _unreadable_reply(action)

    client.meta.events.register_first("before-send", protect_origin)
    client.meta.events.register_first("before-parse", validate_response)
    return client


def _call(service, operation, action, region, endpoints, keys, **params):
    try:
        with closing(_client(service, region, endpoints, action, keys)) as client:
            return getattr(client, operation)(**params)
    except ClientError as exc:
        response = exc.response
        code = response.get("Error", {}).get("Code")
        raise cloud_error(
            "AWS",
            action,
            status=response["ResponseMetadata"]["HTTPStatusCode"],
            reason=code if isinstance(code, str) else None,
        ) from None
    except (ConnectTimeoutError, ReadTimeoutError):
        raise cloud_error("AWS", action, timed_out=True) from None
    except ParamValidationError:
        raise CloudError(
            f"AWS has invalid settings while trying to {action}. Check the AWS settings."
        ) from None
    except (ResponseParserError, ValueError, KeyError, TypeError):
        raise _unreadable_reply(action) from None
    except BotoCoreError:
        raise cloud_error("AWS", action) from None


def _unreadable_reply(action: str) -> CloudError:
    return CloudError(
        f"AWS sent an unreadable reply while trying to {action}. Try again in a minute."
    )


def _missing(directory: Path) -> CloudError:
    return CloudError(messages.aws_missing_login(directory))


def _expired():
    return CloudError(messages.expired_login(_AWS_CLI, "aws sso login"))


def _assume_role(keys, role_arn, region, endpoints):
    response = _call(
        "sts",
        "assume_role",
        "assume the AWS role",
        region,
        endpoints,
        keys,
        RoleArn=role_arn,
        RoleSessionName="omnikrux",
    )
    try:
        credentials = response["Credentials"]
        return AwsKeys(
            credentials["AccessKeyId"], credentials["SecretAccessKey"], credentials["SessionToken"]
        )
    except (KeyError, TypeError):
        raise _unreadable_reply("assume the AWS role") from None


async def assume_role(keys, role_arn, region, endpoints) -> AwsKeys:
    return await asyncio.to_thread(_assume_role, keys, role_arn, region, endpoints)


class AwsProfileLogin:
    def __init__(self, dir: Path, profile: str, endpoints: CloudEndpoints):
        self._dir = dir
        self._profile = profile
        self._endpoints = endpoints

    def _session(self) -> Session:
        session = Session(session_vars=_SDK_SESSION_VARS)
        session.set_config_variable("config_file", str(self._dir / "config"))
        session.set_config_variable("credentials_file", str(self._dir / "credentials"))
        return session

    def _config(self):
        session = self._session()
        try:
            return session.full_config
        except PermissionError as exc:
            raise CloudError(messages.unreadable_login(Path(exc.filename or self._dir))) from None
        except BotoCoreError:
            raise _missing(self._dir) from None

    def profiles(self) -> list[str]:
        return sorted(name for name in self._config()["profiles"] if PROFILE_NAME.fullmatch(name))

    def region(self) -> str | None:
        if not PROFILE_NAME.fullmatch(self._profile):
            raise _missing(self._dir)
        profiles = self._config()["profiles"]
        if self._profile not in profiles:
            raise _missing(self._dir)
        return profiles[self._profile].get("region")

    async def keys(self) -> AwsKeys:
        return await asyncio.to_thread(self._keys)

    def _keys(self) -> AwsKeys:
        config = self._config()
        try:
            return self._profile_keys(config, self._profile, set())
        except PermissionError as exc:
            raise CloudError(messages.unreadable_login(Path(exc.filename or self._dir))) from None
        except BotoCoreError:
            raise _missing(self._dir) from None

    def _profile_keys(self, config, name, visited):
        if not PROFILE_NAME.fullmatch(name) or name in visited or name not in config["profiles"]:
            raise _missing(self._dir)
        profile = config["profiles"][name]
        if "credential_process" in profile:
            raise CloudError(messages.credential_process(name))
        for provider in (
            SharedCredentialProvider(str(self._dir / "credentials"), name),
            ConfigProvider(str(self._dir / "config"), name),
        ):
            credentials = provider.load()
            if credentials is not None:
                frozen = credentials.get_frozen_credentials()
                return AwsKeys(frozen.access_key, frozen.secret_key, frozen.token)
        if any(
            key in profile
            for key in ("sso_session", "sso_start_url", "sso_account_id", "sso_role_name")
        ):
            return self._sso_keys(config, name, profile)
        if "role_arn" in profile and "source_profile" in profile:
            source = profile["source_profile"]
            keys = self._profile_keys(config, source, visited | {name})
            region = (
                profile.get("region") or config["profiles"][source].get("region") or "us-east-1"
            )
            return _assume_role(keys, profile["role_arn"], region, self._endpoints)
        raise _missing(self._dir)

    def _sso_keys(self, config, name, profile):
        # Resolve the named session ourselves so the SDK cannot instantiate its
        # OIDC refresh provider. Only the referenced token is read from disk.
        try:
            session_name = profile.get("sso_session")
            sso = dict(profile)
            if session_name:
                session = config["sso_sessions"][session_name]
                for key in ("sso_start_url", "sso_region"):
                    if key in profile and profile[key] != session[key]:
                        raise ValueError
                    sso[key] = session[key]
                del sso["sso_session"]
            start_url = sso["sso_start_url"]
            filename = hashlib.sha1((session_name or start_url).encode()).hexdigest()
            token = json.loads((self._dir / "sso" / "cache" / f"{filename}.json").read_bytes())
            if not isinstance(token["accessToken"], str) or not token["accessToken"]:
                raise ValueError
            expires = datetime.fromisoformat(token["expiresAt"].replace("UTC", "+00:00"))
            if expires <= utcnow():
                raise ValueError
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise _expired() from None

        with ExitStack() as clients:

            def sso_client(service, *, config):
                return clients.enter_context(
                    closing(
                        _client(
                            service,
                            config.region_name,
                            self._endpoints,
                            "read the AWS SSO role credentials",
                        )
                    )
                )

            try:
                provider = SSOProvider(
                    lambda: {"profiles": {name: sso}},
                    sso_client,
                    name,
                    token_cache={hashlib.sha1(start_url.encode()).hexdigest(): token},
                )
                credentials = provider.load().get_frozen_credentials()
            except (
                BotoCoreError,
                ClientError,
                CloudError,
                ResponseParserError,
                KeyError,
                AttributeError,
                TypeError,
                ValueError,
            ):
                raise _expired() from None
        return AwsKeys(credentials.access_key, credentials.secret_key, credentials.token)


@dataclass(frozen=True)
class AwsAccessKey:
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)

    async def keys(self) -> AwsKeys:
        return AwsKeys(self.access_key_id, self.secret_access_key, None)


class _DatedQueryAuth(SigV4QueryAuth):
    def add_auth(self, request):
        # The SDK's add_auth always overwrites the request timestamp.
        self._modify_request_before_signing(request)
        canonical = self.canonical_request(request)
        signature = self.signature(self.string_to_sign(request, canonical), request)
        self._inject_signature_to_request(request, signature)


def eks_token(
    keys: AwsKeys, cluster_name: str, region: str, endpoints: CloudEndpoints, *, now: datetime
) -> BearerToken:
    endpoint = endpoints.url("aws_sts", _region(region))
    if not same_origin(endpoint, endpoint):
        raise CloudError("AWS has an invalid STS endpoint. Check the cloud endpoint.")
    request = AWSRequest(
        method="GET",
        url=f"{endpoint.rstrip('/')}/?Action=GetCallerIdentity&Version=2011-06-15",
        headers={"x-k8s-aws-id": _cluster_name(cluster_name)},
    )
    request.context["timestamp"] = now.astimezone(UTC).strftime(SIGV4_TIMESTAMP)
    credentials = Credentials(keys.access_key_id, keys.secret_access_key, keys.session_token)
    _DatedQueryAuth(credentials, "sts", region, expires=60).add_auth(request)
    encoded = base64.urlsafe_b64encode(request.url.encode()).decode().rstrip("=")
    return BearerToken(f"k8s-aws-v1.{encoded}", now + timedelta(seconds=EKS_TOKEN_SECONDS))


class AwsAdapter:
    provider = "aws"

    def __init__(self, endpoints: CloudEndpoints, directory: Path):
        self._endpoints = endpoints
        self._dir = directory

    async def cli_login(self) -> CliLoginInfo:
        def inspect_login():
            folder = folder_state(self._dir, ("config", "credentials"))
            if folder.state == "unreadable":
                return CliLoginInfo(
                    "aws",
                    str(folder.path),
                    "unreadable",
                    messages.unreadable_login(folder.path),
                    [],
                )
            if folder.state == "found":
                try:
                    profiles = AwsProfileLogin(self._dir, "default", self._endpoints).profiles()
                except CloudError as error:
                    return CliLoginInfo("aws", str(folder.path), "unreadable", str(error), [])
                return CliLoginInfo(
                    "aws", str(folder.path), "found", None, [Choice(p, p) for p in profiles]
                )
            return CliLoginInfo("aws", str(folder.path), "missing", None, [])

        return await asyncio.to_thread(inspect_login)

    async def _credentials(self, account):
        if account.source == "workload":
            raise CloudError(messages.WORKLOAD)
        regions = account.settings.get("regions", [])
        if not isinstance(regions, list):
            raise CloudError("Choose at least one AWS region.")
        if account.source == "cli":
            profile = account.settings.get("profile")
            if not isinstance(profile, str) or not PROFILE_NAME.fullmatch(profile):
                raise _missing(self._dir)
            login = AwsProfileLogin(self._dir, profile, self._endpoints)
            if not regions:
                region = await asyncio.to_thread(login.region)
                regions = [region] if region else []
        else:
            access_key = account.settings.get("access_key_id")
            secret = (account.secret or {}).get("secret_access_key")
            if (
                not isinstance(access_key, str)
                or not access_key
                or not isinstance(secret, str)
                or not secret
            ):
                raise CloudError("Enter an AWS access key ID and secret access key.")
            login = AwsAccessKey(access_key, secret)
        if not regions:
            raise CloudError("Choose at least one AWS region.")
        return login, list(dict.fromkeys(_region(region) for region in regions))

    async def _read(self, service, operation, action, region, keys, **params):
        return await asyncio.to_thread(
            _call, service, operation, action, region, self._endpoints, keys, **params
        )

    async def verify(self, account: AccountConfig) -> AccountIdentity:
        login, regions = await self._credentials(account)
        result = await self._read(
            "sts", "get_caller_identity", "verify the AWS login", regions[0], await login.keys()
        )
        try:
            return AccountIdentity(result["Account"], f"AWS {result['Account']}", result["Arn"])
        except KeyError:
            raise _unreadable_reply("verify the AWS login") from None

    async def discover(self, account: AccountConfig) -> DiscoveryResult:
        result = DiscoveryResult([], [])
        try:
            async with asyncio.timeout(60):
                login, regions = await self._credentials(account)
                keys = await login.keys()
                slots = asyncio.Semaphore(4)

                async def discover_region(region):
                    async with slots:
                        try:
                            await self._discover_region(region, keys, result.clusters)
                        except CloudError as error:
                            result.problems.append(messages.region_problem(region, str(error)))
                        except (KeyError, TypeError):
                            error = _unreadable_reply("read EKS cluster details")
                            result.problems.append(messages.region_problem(region, str(error)))

                await asyncio.gather(*(discover_region(region) for region in regions))
        except TimeoutError:
            result.problems.append(
                "AWS cluster discovery didn't finish within 60 s. Try again in a minute."
            )
        return result

    async def _names(self, operation, action, field, region, keys, **params):
        seen_tokens = set()
        while True:
            page = await self._read("eks", operation, action, region, keys, **params)
            for name in page[field]:
                yield name
            token = page.get("nextToken")
            if token is not None and not isinstance(token, str):
                raise _unreadable_reply(action)
            if not token:
                return
            if token in seen_tokens:
                raise CloudError(
                    "AWS repeated a page while listing EKS resources. Try again in a minute."
                )
            seen_tokens.add(token)
            params["nextToken"] = token

    async def _describe(self, name, region, keys):
        response = await self._read(
            "eks",
            "describe_cluster",
            "describe the EKS cluster",
            region,
            keys,
            name=_cluster_name(name),
        )
        cluster = response.get("cluster")
        if not isinstance(cluster, dict) or not isinstance(cluster.get("endpoint"), str):
            raise _unreadable_reply("describe the EKS cluster")
        return cluster

    async def _discover_region(self, region, keys, found):
        async for name in self._names(
            "list_clusters", "list EKS clusters", "clusters", region, keys
        ):
            cluster = await self._describe(name, region, keys)
            pools = []
            async for group in self._names(
                "list_nodegroups",
                "list EKS node groups",
                "nodegroups",
                region,
                keys,
                clusterName=name,
            ):
                response = await self._read(
                    "eks",
                    "describe_nodegroup",
                    "describe the EKS node group",
                    region,
                    keys,
                    clusterName=name,
                    nodegroupName=_cluster_name(group),
                )
                pool = response["nodegroup"]
                pools.append(
                    NodePool(
                        pool["nodegroupName"],
                        pool.get("scalingConfig", {}).get("desiredSize"),
                        next(iter(pool.get("instanceTypes", ())), None),
                        pool.get("version"),
                    )
                )
            private = not cluster.get("resourcesVpcConfig", {}).get("endpointPublicAccess", False)
            count = (
                sum(pool.count for pool in pools)
                if pools and all(pool.count is not None for pool in pools)
                else None
            )
            found.append(
                DiscoveredCluster(
                    cluster["arn"],
                    name,
                    region,
                    cluster.get("version"),
                    tuple(pools),
                    count,
                    cluster.get("tags", {}),
                    private,
                    messages.PRIVATE if private else None,
                    {
                        "region": region,
                        "endpoint": cluster["endpoint"],
                        "ca": cluster.get("certificateAuthority", {}).get("data"),
                    },
                )
            )

    async def access(self, account: AccountConfig, found: DiscoveredCluster) -> ClusterAccess:
        login, _ = await self._credentials(account)
        cluster = await self._describe(found.name, found.region, await login.keys())
        return ClusterAccess(
            cluster["endpoint"], cluster.get("certificateAuthority", {}).get("data")
        )

    def token_fetch(self, account: AccountConfig, ref: CloudClusterRef) -> TokenFetch:
        async def fetch():
            login, _ = await self._credentials(account)
            keys = await login.keys()
            return await asyncio.to_thread(
                eks_token, keys, ref.name, ref.region, self._endpoints, now=utcnow()
            )

        return fetch

    def forget(self, account_id: str) -> None:
        pass
