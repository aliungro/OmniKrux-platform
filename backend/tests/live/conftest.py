"""Transport guards and account fixtures for the explicitly selected live checks."""

import os
import re
from contextlib import contextmanager
from urllib.parse import parse_qsl, unquote, urlsplit

import pytest
import requests
from botocore.session import Session
from google.auth.transport.requests import Request

from omnikrux.cloud.adapters import make_adapters
from omnikrux.cloud.endpoints import CloudEndpoints, same_origin
from omnikrux.cloud.http import CloudHttp
from omnikrux.cloud.types import AWS_REGION, GCP_PROJECT, GUID, OCI_OCID, OCI_REGION, AccountConfig
from omnikrux.config import Settings
from tests.live import opted_in_provider

_GUID = GUID.pattern[1:-1]
_PROJECT = GCP_PROJECT.pattern[1:-1]
_OCID = OCI_OCID.pattern[1:-1]
_SUB = rf"/subscriptions/{_GUID}"
_AKS = r"/providers/Microsoft\.ContainerService/managedClusters"
_NAME = r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}"
_EKS = {
    "ListClusters": ("/clusters", {"maxResults", "nextToken"}),
    "DescribeCluster": (rf"/clusters/{_NAME}", set()),
    "ListNodegroups": (rf"/clusters/{_NAME}/node-groups", {"maxResults", "nextToken"}),
    "DescribeNodegroup": (rf"/clusters/{_NAME}/node-groups/{_NAME}", set()),
}
_GCP_GRANTS = {"refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"}
_METHOD_HEADERS = {"x-http-method", "x-http-method-override", "x-method-override"}
_REFUSAL = "The live cloud check refused a request outside its read-only allowlist."


class ReadOnlyViolation(AssertionError):
    def __init__(self):
        super().__init__(_REFUSAL)


class SafeLiveFailure(pytest.fail.Exception):
    def __init__(self, message):
        super().__init__(message, pytrace=False)


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    report = yield
    if item.get_closest_marker("cloud_live") is None:
        return report
    # Pytest can attach captured output from a successful phase to a failed one.
    report.sections.clear()
    if report.failed:
        # --full-trace overrides pytrace=False. Replace the report itself.
        error = call.excinfo.value if call.excinfo is not None else None
        report.longrepr = (
            str(error)
            if isinstance(error, SafeLiveFailure)
            else "The live cloud check failed. Check the configured login and permissions."
        )
    return report


@contextmanager
def safe_live_errors(message):
    """Report fixed text so pytest cannot display cloud credentials from a stack frame."""
    try:
        yield
    except ReadOnlyViolation:
        raise SafeLiveFailure(_REFUSAL) from None
    except Exception:  # noqa: BLE001  (avoid rendering arbitrary credential-bearing exceptions)
        raise SafeLiveFailure(message) from None


def _fields(value):
    try:
        if isinstance(value, bytes):
            value = value.decode("ascii")
        pairs = (
            list(value.items())
            if isinstance(value, dict)
            else parse_qsl(
                value or "", keep_blank_values=True, strict_parsing=True, errors="strict"
            )
        )
        fields = dict(pairs)
        if len(fields) == len(pairs):
            return fields
    except (AttributeError, TypeError, ValueError):
        pass
    raise ReadOnlyViolation() from None


def _matches(url, endpoint, route, query_keys=(), *, flags=0):
    if not same_origin(url, endpoint):
        return False
    parts = urlsplit(url)
    raw_path = parts.path or "/"
    if re.search(r"%(?:25|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)", raw_path, re.IGNORECASE):
        return False
    path = unquote(raw_path)
    if any(segment in {".", ".."} for segment in path.split("/")):
        return False
    base = re.escape(urlsplit(endpoint).path.rstrip("/"))
    return bool(re.fullmatch(base + route, path, flags)) and _fields(parts.query).keys() <= set(
        query_keys
    )


def _regional(endpoints, name, url, region_pattern):
    # A literal endpoint is used by synthetic tests. Production endpoints have
    # exactly one regional label, which must satisfy the provider's grammar.
    template = getattr(endpoints, name)
    if "{region}" not in template:
        return template
    host_template = urlsplit(template).hostname
    region = region_pattern.pattern[1:-1]
    host_pattern = re.escape(host_template).replace(r"\{region\}", rf"({region})")
    match = re.fullmatch(host_pattern, urlsplit(url).hostname or "")
    return endpoints.url(name, match[1]) if match else None


def _safe_headers(headers):
    if _METHOD_HEADERS.intersection(str(key).casefold() for key in (headers or {})):
        raise ReadOnlyViolation()


def _azure_request(endpoints, method, url, data):
    if method == "POST":
        if _matches(url, endpoints.azure_login, rf"/{_GUID}/oauth2/v2\.0/token"):
            return _fields(data).get("grant_type") in {"client_credentials", "refresh_token"}
        return (
            data is None
            and _matches(
                url,
                endpoints.azure_arm,
                _SUB + rf"/resourceGroups/[^/]+{_AKS}/[^/]+/listClusterUserCredential",
                {"api-version", "format"},
                flags=re.IGNORECASE,
            )
            and _fields(urlsplit(url).query).get("format") == "exec"
        )
    if method == "GET":
        return _matches(
            url, endpoints.azure_arm, _SUB, {"api-version"}, flags=re.IGNORECASE
        ) or _matches(
            url,
            endpoints.azure_arm,
            _SUB + _AKS,
            {"api-version", "$skiptoken"},
            flags=re.IGNORECASE,
        )
    return False


def _oci_request(endpoints, method, url):
    identity = _regional(endpoints, "oci_identity", url, OCI_REGION)
    engine = _regional(endpoints, "oci_containerengine", url, OCI_REGION)
    if method == "POST":
        return engine and _matches(url, engine, rf"/20180222/clusters/{_OCID}/kubeconfig/content")
    if method != "GET":
        return False
    return (
        identity
        and (
            _matches(url, identity, rf"/20160918/tenancies/{_OCID}")
            or _matches(
                url,
                identity,
                "/20160918/compartments",
                {
                    "compartmentId",
                    "compartmentIdInSubtree",
                    "accessLevel",
                    "lifecycleState",
                    "page",
                },
            )
        )
        or engine
        and (
            _matches(url, engine, "/20180222/clusters", {"compartmentId", "lifecycleState", "page"})
            or _matches(url, engine, "/20180222/nodePools", {"compartmentId", "clusterId", "page"})
        )
    )


def _cloud_http_allowed(provider, endpoints, method, url, data):
    if provider == "azure":
        return _azure_request(endpoints, method, url, data)
    if provider == "gcp":
        return method == "GET" and _matches(
            url, endpoints.gcp_container, rf"/v1/projects/{_PROJECT}/locations/-/clusters"
        )
    if provider == "oci":
        return _oci_request(endpoints, method, url)
    return False


def _install_aws_guard(monkeypatch, endpoints):
    create_client = Session.create_client

    def check(request, event_name, **_kwargs):
        _, service, operation = event_name.split(".")
        if service not in {"sts", "eks", "sso"}:
            raise ReadOnlyViolation()
        endpoint = _regional(endpoints, f"aws_{service}", request.url, AWS_REGION)
        _safe_headers(request.headers)
        if endpoint and service == "sts" and operation in {"GetCallerIdentity", "AssumeRole"}:
            form = _fields(request.body)
            if (
                request.method == "POST"
                and _matches(request.url, endpoint, "/")
                and form.get("Action") == operation
                and form.get("Version") == "2011-06-15"
            ):
                return
        if endpoint and request.method == "GET" and request.body is None:
            if (
                service == "eks"
                and operation in _EKS
                and _matches(request.url, endpoint, *_EKS[operation])
            ):
                return
            if (
                service == "sso"
                and operation == "GetRoleCredentials"
                and _matches(
                    request.url, endpoint, "/federation/credentials", {"account_id", "role_name"}
                )
            ):
                return
        raise ReadOnlyViolation()

    def guarded_create(session, *args, **kwargs):
        client = create_client(session, *args, **kwargs)
        client.meta.events.register_last("before-send", check)
        return client

    monkeypatch.setattr(Session, "create_client", guarded_create)


def _install_gcp_guard(monkeypatch, endpoints):
    sdk_request = Request.__call__
    send = requests.Session.send

    def check(method, url, body, headers):
        _safe_headers(headers)
        if (
            method != "POST"
            or url != endpoints.gcp_oauth
            or _fields(body).get("grant_type") not in _GCP_GRANTS
        ):
            raise ReadOnlyViolation()

    def guarded_sdk(request, url, method="GET", body=None, headers=None, **kwargs):
        check(method, url, body, headers)
        request.session.trust_env = False
        return sdk_request(request, url, method=method, body=body, headers=headers, **kwargs)

    def guarded_send(session, request, **kwargs):
        check(request.method, request.url, request.body, request.headers)
        kwargs["allow_redirects"] = False
        return send(session, request, **kwargs)

    monkeypatch.setattr(Request, "__call__", guarded_sdk)
    monkeypatch.setattr(requests.Session, "send", guarded_send)


def install_cloud_guard(monkeypatch, provider, endpoints):
    request = CloudHttp._request

    async def guarded(http, method, url, **kwargs):
        _safe_headers(kwargs["headers"])
        data = kwargs["data"]
        if (
            kwargs["json_body"] is not None
            or (method == "GET" and data is not None)
            or not _cloud_http_allowed(provider, endpoints, method, str(url), data)
        ):
            raise ReadOnlyViolation()
        return await request(http, method, url, **kwargs)

    monkeypatch.setattr(CloudHttp, "_request", guarded)
    if provider == "aws":
        _install_aws_guard(monkeypatch, endpoints)
    if provider == "gcp":
        _install_gcp_guard(monkeypatch, endpoints)


def install_kube_guard(monkeypatch, api, server):
    pool = api.rest_client.pool_manager
    request = pool.request
    monkeypatch.setattr(pool, "_trust_env", False)

    def guarded(method, url, **kwargs):
        _safe_headers(kwargs.get("headers"))
        if (
            method != "GET"
            or kwargs.get("proxy") is not None
            or kwargs.get("data") is not None
            or not _matches(str(url), server, r"/(?:version|api/v1/namespaces)")
        ):
            raise ReadOnlyViolation()
        kwargs["allow_redirects"] = False
        return request(method, url, **kwargs)

    monkeypatch.setattr(pool, "request", guarded)


def _required(name):
    variable = f"OMNIKRUX_LIVE_{name}"
    value = os.getenv(variable)
    if not value or not value.strip():
        pytest.skip(f"Set {variable} to run this live cloud check.")
    return value


def _account(provider):
    source = "cli"
    secret = None
    match provider:
        case "azure":
            settings = {"subscription_id": _required("AZURE_SUBSCRIPTION")}
            if os.name == "nt":
                source = "entered"
                settings["tenant_id"] = _required("AZURE_TENANT_ID")
                settings["client_id"] = _required("AZURE_CLIENT_ID")
                secret = {"client_secret": _required("AZURE_CLIENT_SECRET")}
        case "aws":
            settings = {
                "profile": _required("AWS_PROFILE"),
                "regions": [region.strip() for region in _required("AWS_REGIONS").split(",")],
            }
        case "gcp":
            settings = {"project_id": _required("GCP_PROJECT")}
        case "oci":
            settings = {"profile": _required("OCI_PROFILE")}
        case _:
            raise AssertionError("Unknown live cloud provider.")
    return AccountConfig(f"live-{provider}", provider, source, "", settings, secret)


@pytest.fixture
async def live_cloud(request, monkeypatch, isolate_cloud_logins):
    provider = opted_in_provider(request.node)
    if provider is None:
        pytest.skip("Select -m cloud_live and opt in to this provider with OMNIKRUX_LIVE_CLOUDS.")
    http = None
    try:
        with safe_live_errors("Live cloud check setup failed. Check the configured login inputs."):
            account = _account(provider)
            endpoints = CloudEndpoints()
            install_cloud_guard(monkeypatch, provider, endpoints)
            http = CloudHttp()
            adapter = make_adapters(http, endpoints, Settings(in_container=False).cloud_dirs)[
                provider
            ]
        yield adapter, account, endpoints
    finally:
        if http is not None:
            with safe_live_errors("Live cloud check cleanup failed."):
                await http.close()
