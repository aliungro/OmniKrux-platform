"""Loopback cloud APIs with explicit read-only routes and expiring fake credentials."""

import base64
import hashlib
import hmac
import json
import re
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from configparser import ConfigParser
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from functools import partial
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

import pytest
import yaml
from aiohttp import web
from botocore.auth import SigV4Auth, SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from multidict import CIMultiDict

from omnikrux.cloud.azure import AKS_SERVER_APP_ID, ARM_SCOPE, AZURE_CLI_CLIENT_ID
from omnikrux.cloud.endpoints import CloudEndpoints, same_origin
from omnikrux.cloud.gcp import GCP_SCOPE
from omnikrux.cloud.types import GCP_PROJECT, CloudProvider
from tests.e2e.cloudproxy import LoopbackThread

_GUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
_AZURE_TOKEN = re.compile(rf"/(?P<tenant>{_GUID})/oauth2/v2\.0/token", re.IGNORECASE)
_AZURE_SUBSCRIPTION = re.compile(rf"/subscriptions/(?P<sub>{_GUID})", re.IGNORECASE)
_AZURE_CLUSTERS = re.compile(
    rf"/subscriptions/(?P<sub>{_GUID})/providers/Microsoft\.ContainerService/managedClusters",
    re.IGNORECASE,
)
_AZURE_KUBECONFIG = re.compile(
    rf"(?P<id>/subscriptions/(?P<sub>{_GUID})/resourceGroups/[^/]+"
    r"/providers/Microsoft\.ContainerService/managedClusters/[^/]+)/listClusterUserCredential",
    re.IGNORECASE,
)
_AKS_SCOPE = re.compile(rf"{_GUID}/\.default", re.IGNORECASE)
_READ_ONLY = (
    ("POST", _AZURE_TOKEN),
    ("GET", _AZURE_SUBSCRIPTION),
    ("GET", _AZURE_CLUSTERS),
    ("POST", _AZURE_KUBECONFIG),
)


@dataclass(frozen=True)
class CloudRequest:
    method: str
    path: str
    query: dict[str, str]
    headers: CIMultiDict[str] = field(repr=False)
    body: object = field(repr=False)


@dataclass(frozen=True)
class _IssuedToken:
    tenant: str
    scope: str
    expires: float


class FakeAzure:
    def __init__(self):
        self.subscriptions: dict[str, dict[str, str]] = {}
        self.clusters: dict[str, list[dict]] = {}
        self.service_principals: dict[tuple[str, str], str] = {}
        self.refresh_tokens: dict[str, tuple[str, str]] = {}
        self.issued_tokens: dict[str, _IssuedToken] = {}
        self._servers: dict[str, str] = {}

    def add_aks(
        self,
        sub: str,
        name: str,
        *,
        server: str,
        location: str = "westeurope",
        private: bool = False,
        entra: bool = True,
        pools: list[dict] | None = None,
        tags: dict[str, str] | None = None,
    ) -> dict:
        resource_id = (
            f"/subscriptions/{sub}/resourceGroups/test-rg"
            f"/providers/Microsoft.ContainerService/managedClusters/{name}"
        )
        tenant = self.subscriptions[sub]["tenant"]
        cluster = {
            "id": resource_id,
            "name": name,
            "location": location,
            "tags": dict(tags or {}),
            "properties": {
                "kubernetesVersion": "1.31.0",
                "agentPoolProfiles": pools
                if pools is not None
                else [
                    {
                        "name": "system",
                        "count": 1,
                        "vmSize": "Standard_D2",
                        "orchestratorVersion": "1.31.0",
                    }
                ],
                "apiServerAccessProfile": {"enablePrivateCluster": private},
                "aadProfile": {"tenantID": tenant} if entra else None,
            },
        }
        self.clusters.setdefault(sub, []).append(cluster)
        self._servers[resource_id.lower()] = server
        return cluster

    def token_response(self, tenant: str, form: dict, lifetime: int) -> web.Response:
        grant = form.get("grant_type")
        client = form.get("client_id")
        if grant == "client_credentials":
            secret = self.service_principals.get((tenant, client))
            if not secret or secret != form.get("client_secret"):
                return web.json_response(
                    {"error": "invalid_client", "error_description": "Unknown service principal."},
                    status=401,
                )
        elif grant == "refresh_token":
            login = self.refresh_tokens.get(form.get("refresh_token"))
            if client != AZURE_CLI_CLIENT_ID or not login or login[0] != tenant:
                return web.json_response(
                    {"error": "invalid_grant", "error_description": "Unknown refresh token."},
                    status=400,
                )
        else:
            return web.json_response({"error": "unsupported_grant_type"}, status=400)
        scopes = form.get("scope", "").split()
        if not scopes:
            return web.json_response({"error": "invalid_scope"}, status=400)
        token = f"az-{len(self.issued_tokens) + 1}"
        self.issued_tokens[token] = _IssuedToken(tenant, scopes[0], time.monotonic() + lifetime)
        return web.json_response({"access_token": token, "expires_in": lifetime})

    def _live_token(self, authorization: str | None) -> _IssuedToken | None:
        if not authorization or not authorization.startswith("Bearer "):
            return None
        token = self.issued_tokens.get(authorization.removeprefix("Bearer "))
        return token if token and time.monotonic() < token.expires else None

    def kube_token_ok(self, authorization: str | None) -> bool:
        token = self._live_token(authorization)
        if token is None or not _AKS_SCOPE.fullmatch(token.scope):
            return False
        app_id = token.scope.removesuffix("/.default")
        return app_id == AKS_SERVER_APP_ID or any(
            (cluster["properties"].get("aadProfile") or {}).get("serverAppID") == app_id
            for clusters in self.clusters.values()
            for cluster in clusters
        )

    def arm_response(
        self, route: re.Pattern, match: re.Match, request: web.Request, base: str
    ) -> web.Response:
        token = self._live_token(request.headers.get("Authorization"))
        if not token or token.scope != ARM_SCOPE:
            return _arm_error(401, "InvalidAuthenticationToken", "An ARM token is required.")
        sub = match["sub"].lower()
        subscription = self.subscriptions.get(sub)
        if not subscription:
            return _arm_error(404, "SubscriptionNotFound", "Unknown subscription.")
        if token.tenant != subscription["tenant"]:
            return _arm_error(
                403, "AuthorizationFailed", "The ARM token is for a different tenant."
            )
        if route is _AZURE_SUBSCRIPTION:
            return web.json_response({"subscriptionId": sub, "displayName": subscription["name"]})
        if route is _AZURE_CLUSTERS:
            clusters = self.clusters.get(sub, [])
            offset = int(request.query.get("$skiptoken", "0"))
            page = {"value": clusters[offset : offset + 2]}
            if offset + 2 < len(clusters):
                query = dict(request.query)
                query["$skiptoken"] = str(offset + 2)
                page["nextLink"] = f"{base}{request.rel_url.with_query(query)}"
            return web.json_response(page)

        server = self._servers.get(match["id"].lower())
        if not server:
            return _arm_error(404, "ResourceNotFound", "Unknown managed cluster.")
        config = {
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [
                {
                    "name": "test",
                    "cluster": {"server": server, "certificate-authority-data": "ZmFrZS1jYQ=="},
                }
            ],
            "users": [{"name": "test", "user": {"token": "never-keep-this-token"}}],
        }
        data = base64.b64encode(yaml.safe_dump(config).encode()).decode()
        return web.json_response({"kubeconfigs": [{"name": "clusterUser", "value": data}]})


def _arm_error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


_AWS_STS = re.compile(r"/")
_AWS_EKS = re.compile(r"/clusters(?:/(?P<cluster>[^/]+)(?:/node-groups(?:/(?P<group>[^/]+))?)?)?")
_AWS_SSO = re.compile(r"/federation/credentials")
_STS_ACTIONS = {"GetCallerIdentity", "AssumeRole"}
_CREDENTIAL_SCOPE = re.compile(r"([^/]+)/(\d{8})/([^/]+)/(sts|eks)/aws4_request")
_STS_NAMESPACE = "https://sts.amazonaws.com/doc/2011-06-15/"


def _sts_xml(name, fields, status=200):
    root = ET.Element(name, xmlns=_STS_NAMESPACE)

    def fill(parent, mapping):
        for key, value in mapping.items():
            child = ET.SubElement(parent, key)
            if isinstance(value, dict):
                fill(child, value)
            else:
                child.text = value

    fill(root, fields)
    return web.Response(body=ET.tostring(root), content_type="text/xml", status=status)


def _aws_error(service, status, code, message):
    if service == "sts":
        return _sts_xml("ErrorResponse", {"Error": {"Code": code, "Message": message}}, status)
    return web.json_response(
        {"message": message}, headers={"x-amzn-errortype": code}, status=status
    )


class FakeAws:
    def __init__(self):
        self.keys: dict[str, str] = {}
        self.account = "123456789012"
        self.arn = f"arn:aws:iam::{self.account}:user/omnikrux-test"
        self.clusters: dict[str, list[dict]] = {}
        self.region_fail: dict[str, tuple[int, str, str]] = {}
        self.sso_tokens: dict[str, dict] = {}
        self._sessions: dict[str, str] = {}

    def add_eks(self, region, name, *, server, public=True, nodegroups=(), tags=None):
        self.clusters.setdefault(region, []).append(
            {
                "arn": f"arn:aws:eks:{region}:{self.account}:cluster/{name}",
                "name": name,
                "version": "1.31",
                "endpoint": server,
                "certificateAuthority": {"data": "dGVzdC1jYQ=="},
                "resourcesVpcConfig": {"endpointPublicAccess": public},
                "nodegroups": list(nodegroups),
                "tags": tags or {},
            }
        )

    def _signing_credentials(self, scope, service, timestamp, token):
        match = _CREDENTIAL_SCOPE.fullmatch(scope or "")
        if match is None or match[4] != service or timestamp[:8] != match[2]:
            return None
        access_key, region = match[1], match[3]
        secret = self.keys.get(access_key)
        if secret is None or (access_key in self._sessions and self._sessions[access_key] != token):
            return None
        return Credentials(access_key, secret, token), region

    @staticmethod
    def _signature(signer, request, timestamp):
        request.context["timestamp"] = timestamp
        canonical = signer.canonical_request(request)
        return signer.signature(signer.string_to_sign(request, canonical), request)

    def _request_region(self, request, service, payload):
        authorization = request.headers.get("Authorization", "")
        scheme, _, fields = authorization.partition(" ")
        if scheme != "AWS4-HMAC-SHA256":
            return None
        parts = dict(part.strip().split("=", 1) for part in fields.split(",") if "=" in part)
        timestamp = request.headers.get("X-Amz-Date", "")
        signed = parts.get("SignedHeaders", "").split(";")
        if "host" not in signed or any(key not in request.headers for key in signed):
            return None
        token = request.headers.get("X-Amz-Security-Token")
        auth = self._signing_credentials(parts.get("Credential"), service, timestamp, token)
        if auth is None or (token is not None and "x-amz-security-token" not in signed):
            return None
        creds, region = auth
        signer = SigV4Auth(creds, service, region)
        rebuilt = AWSRequest(
            method=request.method,
            url=f"{request.scheme}://{request.host}{request.raw_path}",
            headers={key: request.headers[key] for key in signed},
            data=payload,
        )
        signature = self._signature(signer, rebuilt, timestamp)
        return region if hmac.compare_digest(signature, parts.get("Signature", "")) else None

    def kube_token_ok(self, authorization, sts_url):
        if not isinstance(authorization, str) or not authorization.startswith("Bearer k8s-aws-v1."):
            return False
        encoded = authorization.removeprefix("Bearer k8s-aws-v1.")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
            return False
        try:
            url = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("ascii")
            split = urlsplit(url)
            expected = urlsplit(sts_url)
            if not same_origin(url, sts_url) or split.path != f"{expected.path.rstrip('/')}/":
                return False
            pairs = parse_qsl(split.query, strict_parsing=True, keep_blank_values=True)
            query = dict(pairs)
            if len(query) != len(pairs):
                return False
            if (
                query.get("Action") != "GetCallerIdentity"
                or query.get("Version") != "2011-06-15"
                or query.get("X-Amz-SignedHeaders") != "host;x-k8s-aws-id"
                or query.get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256"
                or query.get("X-Amz-Expires") != "60"
            ):
                return False
            timestamp = query["X-Amz-Date"]
            signed_at = datetime.strptime(timestamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            if not 0 <= (datetime.now(UTC) - signed_at).total_seconds() < 900:
                return False
            auth = self._signing_credentials(
                query["X-Amz-Credential"], "sts", timestamp, query.get("X-Amz-Security-Token")
            )
            if auth is None:
                return False
            creds, region = auth
            supplied = query.pop("X-Amz-Signature")
            unsigned = split._replace(query=urlencode(query, quote_via=quote)).geturl()
            signer = SigV4QueryAuth(creds, "sts", region)
            for cluster in self.clusters.get(region, ()):
                request = AWSRequest(
                    method="GET", url=unsigned, headers={"x-k8s-aws-id": cluster["name"]}
                )
                if hmac.compare_digest(supplied, self._signature(signer, request, timestamp)):
                    return True
        except (KeyError, ValueError, TypeError):
            pass
        return False

    def _sts_response(self, body):
        action = body.get("Action")
        if action == "GetCallerIdentity":
            result = {"Account": self.account, "Arn": self.arn, "UserId": "OMNIKRUX"}
        elif action == "AssumeRole":
            role = body.get("RoleArn")
            session = body.get("RoleSessionName")
            if not role or not session:
                return _aws_error("sts", 400, "ValidationError", "Role and session are required.")
            access_key = f"ASIA{len(self._sessions):016d}"
            secret = f"fake-assumed-role-secret-{access_key}"
            token = f"fake-assumed-role-token-{access_key}"
            self.keys[access_key] = secret
            self._sessions[access_key] = token
            result = {
                "Credentials": {
                    "AccessKeyId": access_key,
                    "SecretAccessKey": secret,
                    "SessionToken": token,
                    "Expiration": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
                }
            }
        else:
            return _aws_error("sts", 400, "InvalidAction", "This operation is not served.")
        return _sts_xml(f"{action}Response", {f"{action}Result": result})

    @staticmethod
    def _page(request, key, values):
        try:
            start = int(request.query.get("nextToken", "0"))
            if start < 0:
                raise ValueError
        except ValueError:
            return _aws_error("eks", 400, "InvalidParameterException", "Invalid page token.")
        result = {key: values[start : start + 2]}
        if start + 2 < len(values):
            result["nextToken"] = str(start + 2)
        return web.json_response(result)

    def _eks_response(self, request, region, route):
        if region in self.region_fail:
            return _aws_error("eks", *self.region_fail[region])
        clusters = self.clusters.get(region, [])
        name = route["cluster"]
        if name is None:
            return self._page(request, "clusters", [c["name"] for c in clusters])
        cluster = next((c for c in clusters if c["name"] == name), None)
        if cluster is None:
            return _aws_error("eks", 404, "ResourceNotFoundException", "Cluster is missing.")
        if "/node-groups" not in request.path:
            return web.json_response(
                {"cluster": {k: v for k, v in cluster.items() if k != "nodegroups"}}
            )
        group = route["group"]
        if group is None:
            return self._page(
                request, "nodegroups", [n["nodegroupName"] for n in cluster["nodegroups"]]
            )
        node = next((n for n in cluster["nodegroups"] if n["nodegroupName"] == group), None)
        if node is None:
            return _aws_error("eks", 404, "ResourceNotFoundException", "Node group is missing.")
        return web.json_response({"nodegroup": node})

    async def handle(self, request, body, payload):
        if request.method == "GET" and _AWS_SSO.fullmatch(request.path):
            credentials = self.sso_tokens.get(request.headers.get("x-amz-sso_bearer_token"))
            if credentials is None:
                return _aws_error("sso", 401, "UnauthorizedException", "Token not accepted.")
            self.keys[credentials["accessKeyId"]] = credentials["secretAccessKey"]
            self._sessions[credentials["accessKeyId"]] = credentials["sessionToken"]
            return web.json_response({"roleCredentials": credentials})
        if request.method == "POST" and _AWS_STS.fullmatch(request.path):
            if self._request_region(request, "sts", payload) is None:
                return _aws_error("sts", 403, "SignatureDoesNotMatch", "Invalid request signature.")
            return self._sts_response(body if isinstance(body, dict) else {})
        route = _AWS_EKS.fullmatch(request.path)
        if request.method == "GET" and route is not None:
            region = self._request_region(request, "eks", payload)
            if region is None:
                return _aws_error("eks", 403, "SignatureDoesNotMatch", "Invalid request signature.")
            return self._eks_response(request, region, route)
        return None


def _aws_read_only(request):
    if request.method == "GET":
        return _AWS_EKS.fullmatch(request.path) or _AWS_SSO.fullmatch(request.path)
    return (
        request.method == "POST"
        and _AWS_STS.fullmatch(request.path)
        and isinstance(request.body, dict)
        and request.body.get("Action") in _STS_ACTIONS
    )


_GCP_TOKEN_PATH = "/google/oauth/token"
_GCP_CLUSTERS = re.compile(
    rf"/v1/projects/(?P<project>{GCP_PROJECT.pattern[1:-1]})/locations/-/clusters"
)
_GCP_JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"


def _decode_jwt_part(encoded: str) -> bytes:
    return base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)


class FakeGcp:
    def __init__(self):
        self.refresh_tokens: dict[str, str] = {}
        self.service_accounts: dict[str, str] = {}
        self.projects: dict[str, list[dict]] = {}
        self.missing_zones: dict[str, list[str]] = {}
        self.disabled_projects: set[str] = set()
        self._expires: dict[str, float] = {}

    def add_gke(
        self,
        project,
        name,
        *,
        server,
        location="europe-west1",
        private=False,
        pools=None,
        labels=None,
    ):
        cluster = {
            "name": name,
            "location": location,
            "endpoint": server,
            "currentMasterVersion": "1.31.0",
            "currentNodeCount": 1,
            "nodePools": (
                pools
                if pools is not None
                else [
                    {
                        "name": "default",
                        "config": {"machineType": "e2-standard-2"},
                        "version": "1.31.0",
                    }
                ]
            ),
            "resourceLabels": dict(labels or {}),
            "privateClusterConfig": {"enablePrivateEndpoint": private},
            "masterAuth": {"clusterCaCertificate": "ZmFrZS1jYQ=="},
        }
        self.projects.setdefault(project, []).append(cluster)
        return cluster

    def _valid_assertion(self, assertion: str) -> bool:
        try:
            header, payload, signature = assertion.split(".")
            algorithm = json.loads(_decode_jwt_part(header))["alg"]
            claims = json.loads(_decode_jwt_part(payload))
            public_key = serialization.load_pem_public_key(
                self.service_accounts[claims["iss"]].encode()
            )
            if (
                algorithm != "RS256"
                or not isinstance(public_key, rsa.RSAPublicKey)
                or claims["aud"] != CloudEndpoints.gcp_oauth
                or claims["scope"] != GCP_SCOPE
                or not claims["iat"] <= time.time() < claims["exp"]
            ):
                return False
            public_key.verify(
                _decode_jwt_part(signature),
                f"{header}.{payload}".encode("ascii"),
                padding.PKCS1v15(),
                hashes.SHA256(),
            )
        except (AttributeError, KeyError, ValueError, TypeError, InvalidSignature, RecursionError):
            return False
        return True

    def token_response(self, form: dict, lifetime: int) -> web.Response:
        grant = form.get("grant_type")
        if grant == "refresh_token":
            valid = form.get("refresh_token") in self.refresh_tokens
        elif grant == _GCP_JWT_GRANT:
            valid = self._valid_assertion(form.get("assertion", ""))
        else:
            return web.json_response({"error": "unsupported_grant_type"}, status=400)
        if not valid:
            return web.json_response({"error": "invalid_grant"}, status=400)
        token = f"gcp-{len(self._expires) + 1}"
        self._expires[token] = time.monotonic() + lifetime
        return web.json_response({"access_token": token, "expires_in": lifetime})

    def kube_token_ok(self, authorization: str | None) -> bool:
        return bool(
            authorization
            and authorization.startswith("Bearer ")
            and self._expires.get(authorization.removeprefix("Bearer "), 0) > time.monotonic()
        )

    def list_response(self, project: str, request: web.Request) -> web.Response:
        if not self.kube_token_ok(request.headers.get("Authorization")):
            return web.json_response(
                {"error": {"code": 401, "status": "UNAUTHENTICATED"}}, status=401
            )
        if project in self.disabled_projects:
            return web.json_response(
                {
                    "error": {
                        "code": 403,
                        "status": "PERMISSION_DENIED",
                        "details": [
                            {
                                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                                "reason": "SERVICE_DISABLED",
                                "domain": "googleapis.com",
                                "metadata": {"service": "container.googleapis.com"},
                            },
                        ],
                    },
                },
                status=403,
            )
        result = {}
        if project in self.projects:
            result["clusters"] = self.projects[project]
        if project in self.missing_zones:
            result["missingZones"] = self.missing_zones[project]
        return web.json_response(result)


def _gcp_read_only(request: CloudRequest) -> bool:
    if request.method == "GET":
        return _GCP_CLUSTERS.fullmatch(request.path) is not None
    return (
        request.method == "POST"
        and request.path == _GCP_TOKEN_PATH
        and isinstance(request.body, dict)
        and request.body.get("grant_type") in ("refresh_token", _GCP_JWT_GRANT)
    )


_OCI_REGION = r"(?P<region>[a-z]{2}-[a-z]+-\d+)"
_OCI_IDENTITY = rf"/oci/identity/{_OCI_REGION}/20160918"
_OCI_ENGINE = rf"/oci/containerengine/{_OCI_REGION}/20180222"
_OCI_TENANCY = re.compile(rf"{_OCI_IDENTITY}/tenancies/(?P<id>[^/]+)")
_OCI_COMPARTMENTS = re.compile(rf"{_OCI_IDENTITY}/compartments")
_OCI_CLUSTERS = re.compile(rf"{_OCI_ENGINE}/clusters")
_OCI_POOLS = re.compile(rf"{_OCI_ENGINE}/nodePools")
_OCI_KUBECONFIG = re.compile(rf"{_OCI_ENGINE}/clusters/(?P<id>[^/]+)/kubeconfig/content")
_OCI_TOKEN = re.compile(rf"/oci/cluster-request/{_OCI_REGION}/cluster_request/(?P<id>[^/]+)")
_OCI_READ_ONLY = (
    ("GET", _OCI_TENANCY),
    ("GET", _OCI_COMPARTMENTS),
    ("GET", _OCI_CLUSTERS),
    ("GET", _OCI_POOLS),
    ("POST", _OCI_KUBECONFIG),
)
_OCI_AUTH = re.compile(
    r'Signature algorithm="rsa-sha256",headers="([^"]+)",keyId="([^"]+)",'
    r'signature="([A-Za-z0-9+/=]+)",version="1"'
)


class FakeOci:
    ca_data = base64.b64encode(b"test-oke-ca").decode()

    def __init__(self):
        self.keys: dict[str, bytes] = {}
        self.tenancy = {"id": "ocid1.tenancy.oc1..test", "name": "Test tenancy"}
        self.compartments: list[dict] = []
        self.clusters: dict[tuple[str, str], list[dict]] = {}
        self._servers: dict[str, str] = {}
        self._pools: dict[str, list[dict]] = {}

    def add_oke(
        self, region, name, *, server, compartment=None, public=True, pools=None, tags=None
    ):
        resource_id = f"ocid1.cluster.oc1.{region}.test{len(self._servers)}"
        rows = self.clusters.setdefault((region, compartment or self.tenancy["id"]), [])
        rows.append(
            {
                "id": resource_id,
                "name": name,
                "endpoints": {"publicEndpoint": server} if public else {},
                "kubernetesVersion": "v1.32.1",
                "freeformTags": tags or {},
            }
        )
        self._servers[resource_id] = server
        self._pools[resource_id] = pools or []
        return resource_id

    def verifies(self, method, target, headers, body=b""):
        match = _OCI_AUTH.fullmatch(headers.get("authorization", ""))
        if match is None:
            return False
        fields, key_id, signature = match.groups()
        signed = ["date", "(request-target)", "host"]
        if method == "POST":
            digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
            if headers.get("x-content-sha256") != digest or headers.get("content-length") != str(
                len(body)
            ):
                return False
            signed.extend(["content-length", "content-type", "x-content-sha256"])
        if fields.split(" ") != signed or key_id not in self.keys:
            return False
        try:
            key = serialization.load_pem_public_key(self.keys[key_id])
            if not isinstance(key, rsa.RSAPublicKey):
                return False
            values = {name: headers[name] for name in signed if name != "(request-target)"}
            values["(request-target)"] = f"{method.lower()} {target}"
            signing_string = "\n".join(f"{name}: {values[name]}" for name in signed)
            key.verify(
                base64.b64decode(signature, validate=True),
                signing_string.encode(),
                padding.PKCS1v15(),
                hashes.SHA256(),
            )
            return True
        except (InvalidSignature, KeyError, ValueError, TypeError):
            return False

    def kube_token_ok(self, authorization, url):
        if not authorization or not authorization.startswith("Bearer "):
            return False
        try:
            token = authorization.removeprefix("Bearer ")
            raw = base64.b64decode(token, altchars=b"-_", validate=True)
            if base64.urlsafe_b64encode(raw).decode() != token:
                return False
            token_url = raw.decode()
            parsed = urlsplit(token_url)
            route = _OCI_TOKEN.fullmatch(parsed.path)
            if not same_origin(token_url, url) or route is None or route["id"] not in self._servers:
                return False
            params = parse_qsl(parsed.query, strict_parsing=True)
            if [name for name, _ in params] != ["authorization", "date"]:
                return False
            headers = dict(params)
            headers["host"] = parsed.netloc
            age = (datetime.now(UTC) - parsedate_to_datetime(headers["date"])).total_seconds()
            return 0 <= age < 240 and self.verifies("GET", parsed.path, headers)
        except (ValueError, TypeError, OverflowError):
            return False

    def _page(self, request, rows):
        cursor = request.query.get("page")
        offset = 0
        if cursor is not None:
            match = re.fullmatch(r"local\+/=&(\d+)", cursor)
            if not match:
                return web.json_response({"code": "InvalidParameter"}, status=400)
            offset = int(match[1])
        headers = {}
        if offset + 2 < len(rows):
            headers["opc-next-page"] = f"local+/=&{offset + 2}"
        return web.json_response(rows[offset : offset + 2], headers=headers)

    def response(self, route, match, request):
        if route is _OCI_TENANCY and match["id"] == self.tenancy["id"]:
            return web.json_response(self.tenancy)
        if route is _OCI_COMPARTMENTS:
            return self._page(request, self.compartments)
        if route is _OCI_CLUSTERS:
            key = (match["region"], request.query.get("compartmentId"))
            return self._page(request, self.clusters.get(key, []))
        if route is _OCI_POOLS:
            return self._page(request, self._pools.get(request.query.get("clusterId"), []))
        if route is _OCI_KUBECONFIG and match["id"] in self._servers:
            cluster = {
                "server": self._servers[match["id"]],
                "certificate-authority-data": self.ca_data,
            }
            return web.Response(text=yaml.safe_dump({"clusters": [{"cluster": cluster}]}))
        return web.json_response({"code": "NotAuthorizedOrNotFound"}, status=404)


class FakeCloud:
    def __init__(self):
        self.url = ""
        self.requests: list[CloudRequest] = []
        self.token_lifetime: dict[CloudProvider, int] = {
            "azure": 3600,
            "aws": 3600,
            "gcp": 3600,
            "oci": 3600,
        }
        self.fail: dict[str, tuple[int, str]] = {}
        self.azure = FakeAzure()
        self.aws = FakeAws()
        self.gcp = FakeGcp()
        self.oci = FakeOci()

    def endpoints(self) -> CloudEndpoints:
        return CloudEndpoints(
            azure_login=self.url,
            azure_arm=self.url,
            aws_sts=self.url,
            aws_eks=self.url,
            aws_sso=self.url,
            gcp_oauth=f"{self.url}{_GCP_TOKEN_PATH}",
            gcp_container=self.url,
            oci_identity=f"{self.url}/oci/identity/{{region}}",
            oci_containerengine=f"{self.url}/oci/containerengine/{{region}}",
            oci_cluster_request=f"{self.url}/oci/cluster-request/{{region}}",
        )

    def read_only_violations(self) -> list[str]:
        return [
            f"{request.method} {request.path}"
            for request in self.requests
            if not _aws_read_only(request)
            and not _gcp_read_only(request)
            and not any(
                request.method == method and route.fullmatch(request.path)
                for method, route in (*_READ_ONLY, *_OCI_READ_ONLY)
            )
        ]

    def kube_token_ok(self, provider: CloudProvider) -> Callable[[str | None], bool]:
        if provider == "azure":
            return self.azure.kube_token_ok
        if provider == "aws":
            return lambda authorization: self.aws.kube_token_ok(authorization, self.url)
        if provider == "gcp":
            return self.gcp.kube_token_ok
        if provider == "oci":
            return lambda authorization: self.oci.kube_token_ok(authorization, self.url)
        return lambda _authorization: False

    async def handle(self, request: web.Request) -> web.Response:
        body: object = None
        payload = await request.read()
        if payload:
            if request.content_type == "application/x-www-form-urlencoded":
                body = dict(parse_qsl(await request.text(), keep_blank_values=True))
            else:
                body = await request.text()
        self.requests.append(
            CloudRequest(
                request.method,
                request.path,
                dict(request.query),
                CIMultiDict(request.headers),
                body,
            )
        )
        oci_route = None
        for method, route in _OCI_READ_ONLY:
            if request.method == method and (match := route.fullmatch(request.path)):
                if not self.oci.verifies(method, request.raw_path, request.headers, payload):
                    return web.json_response({"code": "NotAuthenticated"}, status=401)
                oci_route = route, match
                break
        for pattern, (status, message) in self.fail.items():
            if re.search(pattern, request.path):
                return _arm_error(status, "FakeFailure", message)
        if oci_route is not None:
            route, match = oci_route
            return self.oci.response(route, match, request)
        response = await self.aws.handle(request, body, payload)
        if response is not None:
            return response
        if request.method == "POST" and request.path == _GCP_TOKEN_PATH:
            return self.gcp.token_response(
                body if isinstance(body, dict) else {}, self.token_lifetime["gcp"]
            )
        if request.method == "GET" and (gke := _GCP_CLUSTERS.fullmatch(request.path)):
            return self.gcp.list_response(gke["project"], request)
        for method, route in _READ_ONLY:
            match = route.fullmatch(request.path)
            if request.method == method and match is not None:
                if route is _AZURE_TOKEN:
                    return self.azure.token_response(
                        match["tenant"],
                        body if isinstance(body, dict) else {},
                        self.token_lifetime["azure"],
                    )
                return self.azure.arm_response(route, match, request, self.url)
        return _arm_error(404, "ResourceNotFound", "This operation isn't served by the fake cloud.")


@asynccontextmanager
async def serve_fake_cloud(*, host="127.0.0.1", port=0):
    cloud = FakeCloud()
    app = web.Application()
    app.router.add_route("*", "/{path:.*}", cloud.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    try:
        site = web.TCPSite(runner, host, port)
        await site.start()
        cloud.url = f"http://{host}:{runner.addresses[0][1]}"
        yield cloud
    finally:
        await runner.cleanup()


@pytest.fixture
async def fake_cloud():
    """A local fake cloud. Every test using it must have stayed read-only (the allowlist)."""
    async with serve_fake_cloud() as cloud:
        yield cloud
        violations = cloud.read_only_violations()
        assert violations == [], f"Requests outside the read-only allowlist: {violations}"


class FakeCloudThread:
    def __init__(self, *, host="127.0.0.1"):
        self._server = LoopbackThread(partial(serve_fake_cloud, host=host))
        self.cloud = self._server.value

    def stop(self) -> None:
        self._server.stop()


def run_fake_cloud_in_thread(*, host="127.0.0.1") -> FakeCloudThread:
    return FakeCloudThread(host=host)


def write_azure_cli_login(dir, *, subscriptions, refresh_token, user):
    """Write a profile and MSAL cache in a disposable test login directory."""
    dir.mkdir(parents=True, exist_ok=True)
    rows = [{"user": {"name": user, "type": "user"}, **row} for row in subscriptions]
    (dir / "azureProfile.json").write_text(
        json.dumps({"subscriptions": rows}), encoding="utf-8-sig"
    )
    environment = "login.microsoftonline.com"
    accounts = {}
    tokens = {}
    for row in rows:
        tenant = row["tenantId"]
        username = row["user"]["name"]
        home = f"fake-{username}.{tenant}"
        accounts[f"{home}-{environment}-{tenant}"] = {
            "home_account_id": home,
            "environment": environment,
            "realm": tenant,
            "username": username,
        }
        tokens[f"{home}-{environment}-refreshtoken-{AZURE_CLI_CLIENT_ID}--"] = {
            "credential_type": "RefreshToken",
            "home_account_id": home,
            "environment": environment,
            "client_id": AZURE_CLI_CLIENT_ID,
            "secret": refresh_token,
        }
    (dir / "msal_token_cache.json").write_text(
        json.dumps({"Account": accounts, "RefreshToken": tokens}), encoding="utf-8"
    )


def write_aws_cli_login(dir, *, profiles, credentials, sso_cache=None):
    dir.mkdir(parents=True, exist_ok=True)
    config = ConfigParser(interpolation=None)
    config.read_dict(
        {
            name
            if name == "default" or name.startswith("sso-session ")
            else f"profile {name}": values
            for name, values in profiles.items()
        }
    )
    shared = ConfigParser(interpolation=None)
    shared.read_dict(credentials)
    for name, settings in (("config", config), ("credentials", shared)):
        with (dir / name).open("w", encoding="utf-8") as file:
            settings.write(file)
    if sso_cache is not None:
        cache = dir / "sso" / "cache"
        cache.mkdir(parents=True, exist_ok=True)
        for name, token in sso_cache.items():
            (cache / f"{name}.json").write_text(json.dumps(token), encoding="utf-8")


def write_gcloud_login(dir, *, adc, project):
    dir.mkdir(parents=True, exist_ok=True)
    configurations = dir / "configurations"
    configurations.mkdir(exist_ok=True)
    if adc is not None:
        (dir / "application_default_credentials.json").write_text(json.dumps(adc), encoding="utf-8")
    if project is not None:
        (dir / "active_config").write_text("default\n", encoding="utf-8")
        config = ConfigParser(interpolation=None)
        config.read_dict({"core": {"project": project}})
        with (configurations / "config_default").open("w", encoding="utf-8") as file:
            config.write(file)


def write_oci_cli_login(dir, *, profiles, key_pem, key_path_as_written):
    dir.mkdir(parents=True, exist_ok=True)
    config = ConfigParser(interpolation=None)
    config.read_dict(
        {
            profile: {**settings, "key_file": key_path_as_written}
            for profile, settings in profiles.items()
        }
    )
    with (dir / "config").open("w", encoding="utf-8") as file:
        config.write(file)
    parts = key_path_as_written.replace("\\", "/").split("/")
    indexes = [index for index, part in enumerate(parts) if part.lower() == ".oci"]
    mounted = parts[indexes[-1] + 1 :] if indexes else [parts[-1]]
    path = dir.joinpath(*mounted)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(key_pem)
