import asyncio
import base64
import hashlib
import json
from collections.abc import AsyncIterator
from configparser import ConfigParser
from configparser import Error as ConfigError
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path, PureWindowsPath
from urllib.parse import quote, urlencode, urlsplit

import yaml
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from yarl import URL

from omnikrux.cloud import messages
from omnikrux.cloud.adapters import (
    AccountIdentity,
    Choice,
    CliLoginInfo,
    ClusterAccess,
    DiscoveryResult,
)
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.types import (
    OCI_OCID,
    OCI_REGION,
    PROFILE_NAME,
    AccountConfig,
    CloudClusterRef,
    DiscoveredCluster,
    NodePool,
)
from omnikrux.kube.tokens import BearerToken, TokenFetch, utcnow

OKE_TOKEN_SECONDS = 240
_CLOUD = "Oracle Cloud"
_CLI = "OCI CLI"
_LOGIN = "oci setup config"
_IDENTITY_API = "/20160918"
_ENGINE_API = "/20180222"
_BASE_HEADERS = ("date", "(request-target)", "host")
_BODY_HEADERS = ("content-length", "content-type", "x-content-sha256")


class OciSigner:
    def __init__(self, key_id: str, private_key: rsa.RSAPrivateKey):
        self._key_id = key_id
        self._private_key = private_key

    def sign(
        self, method: str, url: str, headers: dict[str, str], body: bytes = b""
    ) -> dict[str, str]:
        parsed = urlsplit(url)
        target = parsed.path or "/"
        if parsed.query:
            target += f"?{parsed.query}"
        verb = method.lower()
        outgoing = {name.lower(): value for name, value in headers.items()}
        if "date" not in outgoing:
            outgoing["date"] = format_datetime(utcnow(), usegmt=True)
        outgoing["host"] = parsed.netloc
        signed_headers = _BASE_HEADERS
        if verb in ("post", "put", "patch"):
            signed_headers += _BODY_HEADERS
            outgoing["content-length"] = str(len(body))
            outgoing.setdefault("content-type", "application/json")
            outgoing["x-content-sha256"] = base64.b64encode(hashlib.sha256(body).digest()).decode()

        values = {**outgoing, "(request-target)": f"{verb} {target}"}
        signing_string = "\n".join(f"{name}: {values[name]}" for name in signed_headers)
        signature = self._private_key.sign(
            signing_string.encode(), padding.PKCS1v15(), hashes.SHA256()
        )
        encoded_signature = base64.b64encode(signature).decode()
        header_list = " ".join(signed_headers)
        # OCI CLI v3.96.2 uses OCI SDK 2.191.0, whose order is also part of the OKE token bytes.
        outgoing["authorization"] = (
            f'Signature algorithm="rsa-sha256",headers="{header_list}",'
            f'keyId="{self._key_id}",signature="{encoded_signature}",version="1"'
        )
        return outgoing


def _private_key(pem: bytes, passphrase: str | None) -> rsa.RSAPrivateKey:
    try:
        key = serialization.load_pem_private_key(pem, passphrase.encode() if passphrase else None)
    except (TypeError, ValueError, UnsupportedAlgorithm):
        raise CloudError(messages.UNREADABLE_OCI_PRIVATE_KEY) from None
    if not isinstance(key, rsa.RSAPrivateKey):
        raise CloudError(messages.UNREADABLE_OCI_PRIVATE_KEY)
    return key


@dataclass(frozen=True)
class OciApiKey:
    tenancy: str
    user: str
    fingerprint: str
    private_key_pem: str | bytes = field(repr=False)
    passphrase: str | None = field(default=None, repr=False)

    def signer(self) -> OciSigner:
        pem = self.private_key_pem
        return OciSigner(
            _key_id(self.tenancy, self.user, self.fingerprint),
            _private_key(pem.encode() if isinstance(pem, str) else pem, self.passphrase),
        )


def _key_id(tenancy: str, user: str, fingerprint: str) -> str:
    if not OCI_OCID.fullmatch(tenancy) or not OCI_OCID.fullmatch(user):
        raise CloudError("Check the tenancy and user OCIDs for this Oracle Cloud login.")
    if not fingerprint or not all(char in "abcdefABCDEF0123456789:" for char in fingerprint):
        raise CloudError("Check the API key fingerprint for this Oracle Cloud login.")
    return f"{tenancy}/{user}/{fingerprint}"


class OciProfileLogin:
    def __init__(self, dir: Path, profile: str = "DEFAULT"):
        if not PROFILE_NAME.fullmatch(profile):
            raise CloudError("Choose a valid OCI CLI profile.")
        self._dir = dir.resolve()
        self._profile = profile
        self._config = ConfigParser(interpolation=None)
        path = self._dir / "config"
        try:
            if not path.resolve().is_relative_to(self._dir):
                raise FileNotFoundError
            with path.open(encoding="utf-8-sig") as handle:
                self._config.read_file(handle)
        except FileNotFoundError:
            raise CloudError(messages.missing_login(_CLI, dir, _LOGIN)) from None
        except PermissionError:
            raise CloudError(messages.unreadable_login(path)) from None
        except (OSError, RuntimeError, UnicodeError, ConfigError):
            raise CloudError(
                "The OCI config can't be read. Check the config file, then try again."
            ) from None

    def profiles(self) -> list[str]:
        defaults = ["DEFAULT"] if self._config.defaults() else []
        return [
            *defaults,
            *(name for name in self._config.sections() if PROFILE_NAME.fullmatch(name)),
        ]

    def _settings(self):
        if self._profile not in self.profiles():
            raise CloudError(
                "The OCI CLI profile wasn't found. Choose a profile from the mounted config."
            )
        return self._config[self._profile]

    def region(self) -> str:
        return _region(self._settings().get("region", ""))

    def tenancy(self) -> str:
        return _ocid(self._settings().get("tenancy", ""), "tenancy")

    def user(self) -> str | None:
        user = self._settings().get("user")
        return _ocid(user, "user") if user else None

    def _credential_file(self, path: str) -> bytes:
        parts = PureWindowsPath(path.replace("/", "\\")).parts
        basename = PureWindowsPath(path).name
        guidance = messages.oci_key_file(self._profile, path, basename or "the file")
        resolved = self._dir / basename
        try:
            written = Path(path.replace("\\", "/"))
            candidate = written if written.is_absolute() else self._dir / written
            resolved = candidate.resolve()
            if resolved.is_relative_to(self._dir):
                if resolved.is_file():
                    return resolved.read_bytes()
            # A path redirected outside the mount, including through a dangling
            # symlink, must never select a different credential through fallback.
            elif (
                candidate.is_relative_to(self._dir)
                or resolved != candidate.absolute()
                or candidate.exists()
                or ".." in parts
            ):
                raise CloudError(guidance)

            mount_indexes = [index for index, part in enumerate(parts) if part.lower() == ".oci"]
            paths = [self._dir.joinpath(*parts[mount_indexes[-1] + 1 :])] if mount_indexes else []
            if basename:
                paths.append(self._dir / basename)
            for fallback in paths:
                resolved = fallback.resolve()
                if not resolved.is_relative_to(self._dir):
                    raise CloudError(guidance)
                if resolved.is_file():
                    return resolved.read_bytes()
        except PermissionError:
            raise CloudError(messages.unreadable_login(resolved)) from None
        except (OSError, RuntimeError, ValueError):
            raise CloudError(guidance) from None
        raise CloudError(guidance)

    def signer(self) -> OciSigner:
        settings = self._settings()
        key = _private_key(
            self._credential_file(settings.get("key_file", "")), settings.get("pass_phrase")
        )
        if token_file := settings.get("security_token_file"):
            try:
                token = self._credential_file(token_file).decode("ascii").strip()
                if not token or not all(char.isalnum() or char in "-_.=" for char in token):
                    raise ValueError
            except (UnicodeError, ValueError):
                raise CloudError(messages.expired_login(_CLI, _LOGIN)) from None
            key_id = f"ST${token}"
        else:
            key_id = _key_id(self.tenancy(), self.user() or "", settings.get("fingerprint", ""))
        return OciSigner(key_id, key)


def _region(value: str) -> str:
    if not isinstance(value, str) or not OCI_REGION.fullmatch(value):
        raise CloudError("Check the region for this Oracle Cloud login.")
    return value


def _ocid(value: str, kind: str) -> str:
    if not isinstance(value, str) or not OCI_OCID.fullmatch(value):
        raise CloudError(f"Check the {kind} OCID for this Oracle Cloud login.")
    return value


def oke_token(
    signer: OciSigner, cluster_id: str, region: str, endpoints: CloudEndpoints, *, now: datetime
) -> BearerToken:
    cluster_id = quote(_ocid(cluster_id, "cluster"), safe="")
    url = f"{endpoints.url('oci_cluster_request', _region(region))}/cluster_request/{cluster_id}"
    headers = signer.sign("GET", url, {"date": format_datetime(now.astimezone(UTC), usegmt=True)})
    # Match OCI CLI v3.96.2: form-encode authorization then date and retain base64 padding.
    query = urlencode([("authorization", headers["authorization"]), ("date", headers["date"])])
    encoded = base64.urlsafe_b64encode(f"{url}?{query}".encode()).decode()
    return BearerToken(encoded, now + timedelta(seconds=OKE_TOKEN_SECONDS))


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _object(value: object) -> dict:
    return value if isinstance(value, dict) else {}


class OciAdapter:
    provider = "oci"

    def __init__(self, http: CloudHttp, endpoints: CloudEndpoints, dir: Path):
        self._http = http
        self._endpoints = endpoints
        self._dir = dir

    async def cli_login(self) -> CliLoginInfo:
        path = self._dir / "config"
        try:
            if not path.resolve().is_relative_to(self._dir.resolve()) or not path.exists():
                return CliLoginInfo("oci", str(self._dir), "missing", None, [])
            choices = [Choice(name, name) for name in OciProfileLogin(self._dir).profiles()]
        except CloudError as error:
            return CliLoginInfo("oci", str(self._dir), "unreadable", error.message, [])
        except (OSError, RuntimeError):
            return CliLoginInfo(
                "oci", str(self._dir), "unreadable", messages.unreadable_login(path), []
            )
        return CliLoginInfo("oci", str(self._dir), "found", None, choices)

    def _profile(self, account: AccountConfig) -> OciProfileLogin:
        profile = account.settings.get("profile", "DEFAULT")
        if not isinstance(profile, str):
            raise CloudError("Choose a valid OCI CLI profile.")
        return OciProfileLogin(self._dir, profile)

    def _entered(self, account: AccountConfig) -> OciApiKey:
        settings = account.settings
        secret = account.secret or {}
        pem = _string(secret.get("private_key"))
        if pem is None:
            raise CloudError(messages.UNREADABLE_OCI_PRIVATE_KEY)
        return OciApiKey(
            _ocid(settings.get("tenancy_ocid"), "tenancy"),
            _ocid(settings.get("user_ocid"), "user"),
            _string(settings.get("fingerprint")) or "",
            pem,
            _string(secret.get("passphrase")),
        )

    def _signer(self, account: AccountConfig) -> OciSigner:
        if account.source == "workload":
            raise CloudError(messages.WORKLOAD)
        if account.source == "cli":
            return self._profile(account).signer()
        return self._entered(account).signer()

    def _regions(self, account: AccountConfig, default: str | None = None) -> list[str]:
        values = account.settings.get("regions") or ([default] if default else [])
        if not isinstance(values, list) or not values:
            raise CloudError("Choose at least one region for this Oracle Cloud login.")
        return list(dict.fromkeys(_region(value) for value in values))

    def _base(self, name: str, region: str) -> str:
        return self._endpoints.url(name, _region(region)).rstrip("/")

    async def verify(self, account: AccountConfig) -> AccountIdentity:
        if account.source == "workload":
            raise CloudError(messages.WORKLOAD)
        if account.source == "cli":
            profile = self._profile(account)
            region, tenancy = profile.region(), profile.tenancy()
            principal = profile.user() or account.settings.get("profile", "DEFAULT")
            signer = profile.signer()
        else:
            api_key = self._entered(account)
            region, tenancy, principal = self._regions(account)[0], api_key.tenancy, api_key.user
            signer = api_key.signer()
        url = f"{self._base('oci_identity', region)}{_IDENTITY_API}/tenancies/{quote(tenancy, safe='')}"
        data = await self._http.json(
            "GET",
            URL(url, encoded=True),
            cloud=_CLOUD,
            action="read the tenancy",
            headers=signer.sign("GET", url, {}),
            id_label="tenancy OCID",
        )
        return AccountIdentity(tenancy, _string(data.get("name")) or tenancy, principal)

    async def _pages(
        self, url: str, params: dict[str, str], signer: OciSigner, action: str
    ) -> AsyncIterator[dict]:
        seen = set()
        while True:
            request_url = f"{url}?{urlencode(params)}"
            rows, next_page = await self._http.array_page(
                "GET",
                URL(request_url, encoded=True),
                cloud=_CLOUD,
                action=action,
                headers=signer.sign("GET", request_url, {}),
            )
            for row in rows:
                yield row
            if not next_page:
                return
            if next_page in seen:
                raise CloudError(
                    "Oracle Cloud repeated a page while listing resources. Try again in a minute."
                )
            seen.add(next_page)
            params = {**params, "page": next_page}

    async def _cluster(
        self, row: dict, region: str, compartment: str, base: str, signer: OciSigner
    ) -> tuple[DiscoveredCluster, str | None]:
        resource_id = _ocid(row.get("id"), "cluster")
        pools = []
        problem = None
        try:
            async for pool in self._pages(
                f"{base}/nodePools",
                {"compartmentId": compartment, "clusterId": resource_id},
                signer,
                "list node pools",
            ):
                size = _object(pool.get("nodeConfigDetails")).get("size")
                pools.append(
                    NodePool(
                        _string(pool.get("name")) or "Node pool",
                        size if type(size) is int and size >= 0 else None,
                        _string(pool.get("nodeShape")),
                        _string(pool.get("kubernetesVersion")),
                    )
                )
        except CloudError as error:
            problem = error.message
        private = not bool(_object(row.get("endpoints")).get("publicEndpoint"))
        tags = {
            key: value
            for key, value in _object(row.get("freeformTags")).items()
            if isinstance(value, str)
        }
        counts = [pool.count for pool in pools if pool.count is not None]
        return DiscoveredCluster(
            resource_id,
            _string(row.get("name")) or resource_id,
            region,
            _string(row.get("kubernetesVersion")),
            tuple(pools),
            sum(counts) if not problem and len(counts) == len(pools) else None,
            tags,
            private,
            messages.PRIVATE if private else None,
            {"region": region, "compartment_id": compartment},
        ), problem

    async def _discover_region(
        self, region: str, tenancy: str, signer: OciSigner, result: DiscoveryResult
    ) -> None:
        identity = self._base("oci_identity", region)
        engine = f"{self._base('oci_containerengine', region)}{_ENGINE_API}"
        compartments = {tenancy: None}
        try:
            async for row in self._pages(
                f"{identity}{_IDENTITY_API}/compartments",
                {
                    "compartmentId": tenancy,
                    "compartmentIdInSubtree": "true",
                    "accessLevel": "ACCESSIBLE",
                    "lifecycleState": "ACTIVE",
                },
                signer,
                "list compartments",
            ):
                try:
                    compartments[_ocid(row.get("id"), "compartment")] = None
                except CloudError as error:
                    result.problems.append(messages.region_problem(region, error.message))
        except CloudError as error:
            result.problems.append(messages.region_problem(region, error.message))

        for compartment in compartments:
            try:
                async for row in self._pages(
                    f"{engine}/clusters",
                    {"compartmentId": compartment, "lifecycleState": "ACTIVE"},
                    signer,
                    "list clusters",
                ):
                    try:
                        found, problem = await self._cluster(
                            row, region, compartment, engine, signer
                        )
                        result.clusters.append(found)
                        if problem:
                            result.problems.append(messages.region_problem(region, problem))
                    except CloudError as error:
                        result.problems.append(messages.region_problem(region, error.message))
            except CloudError as error:
                result.problems.append(messages.region_problem(region, error.message))

    async def discover(self, account: AccountConfig) -> DiscoveryResult:
        if account.source == "workload":
            raise CloudError(messages.WORKLOAD)
        if account.source == "cli":
            profile = self._profile(account)
            tenancy, signer = profile.tenancy(), profile.signer()
            regions = self._regions(account, profile.region())
        else:
            api_key = self._entered(account)
            tenancy, signer = api_key.tenancy, api_key.signer()
            regions = self._regions(account)

        result = DiscoveryResult([], [])
        concurrency = asyncio.Semaphore(4)

        async def list_region(region: str) -> None:
            try:
                async with concurrency:
                    await self._discover_region(region, tenancy, signer, result)
            except asyncio.CancelledError:
                result.problems.append(
                    messages.region_problem(
                        region, "The account check reached its 60 s limit. Try again in a minute."
                    )
                )
                raise

        try:
            async with asyncio.timeout(60):
                await asyncio.gather(*(list_region(region) for region in regions))
        except TimeoutError:
            pass
        return result

    async def access(self, account: AccountConfig, found: DiscoveredCluster) -> ClusterAccess:
        if account.source == "workload":
            raise CloudError(messages.WORKLOAD)
        if found.private:
            raise CloudError(messages.PRIVATE)
        resource_id = quote(_ocid(found.resource_id, "cluster"), safe="")
        base = self._base("oci_containerengine", found.region)
        url = f"{base}{_ENGINE_API}/clusters/{resource_id}/kubeconfig/content"
        body = json.dumps({"tokenVersion": "2.0.0", "endpoint": "PUBLIC_ENDPOINT"}).encode()
        headers = self._signer(account).sign("POST", url, {}, body)
        text = await self._http.text(
            "POST",
            URL(url, encoded=True),
            cloud=_CLOUD,
            action="read the cluster kubeconfig",
            headers=headers,
            data=body,
            id_label="cluster OCID",
        )
        try:
            cluster = yaml.safe_load(text)["clusters"][0]["cluster"]
            server = _string(cluster["server"])
            ca_data = _string(cluster.get("certificate-authority-data"))
            if server:
                return ClusterAccess(server, ca_data)
        except (yaml.YAMLError, TypeError, ValueError, KeyError, IndexError, RecursionError):
            pass
        raise CloudError(
            "Oracle Cloud sent an unreadable kubeconfig. Check the cluster, then try again."
        )

    def token_fetch(self, account: AccountConfig, ref: CloudClusterRef) -> TokenFetch:
        async def fetch() -> BearerToken:
            return oke_token(
                self._signer(account), ref.resource_id, ref.region, self._endpoints, now=utcnow()
            )

        return fetch

    def forget(self, account_id: str) -> None:
        # Credentials are read when needed and aren't cached by this adapter.
        pass
