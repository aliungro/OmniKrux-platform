import asyncio
import base64
import hashlib
import logging
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from aiohttp import web
from botocore.httpsession import URLLib3Session

from omnikrux.cloud.adapters import AccountIdentity, ClusterAccess, make_adapters
from omnikrux.cloud.aws import AwsKeys, AwsProfileLogin, assume_role, eks_token
from omnikrux.cloud.dirs import CloudDirs
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.types import AccountConfig, CloudClusterRef, NodePool
from tests.fakecloud import serve_fake_cloud, write_aws_cli_login

ACCESS_KEY = "AKIDEXAMPLE"
SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
REGION = "eu-west-1"
OTHER_REGION = "eu-north-1"
CLUSTER = "prod"
SERVER = "https://127.0.0.1:6443"
NOW = datetime(2026, 1, 1, tzinfo=UTC)
SSO_START = "https://example.awsapps.com/start"
SSO_TOKEN = "sso-test-token"
ROLE_NAME = "ReadOnly"
ACCOUNT = "123456789012"
MISSING_SSO = "Your AWS CLI login has expired. Run `aws sso login` on this machine, then try again."


def decode_token(value):
    prefix, encoded = value.split(".", 1)
    assert prefix == "k8s-aws-v1"
    assert "=" not in encoded
    return base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("ascii")


def test_eks_token_format_pinned(monkeypatch):
    from botocore import auth
    from botocore.awsrequest import AWSRequest
    from botocore.credentials import Credentials

    keys = AwsKeys(ACCESS_KEY, SECRET_KEY, None)
    token = eks_token(keys, CLUSTER, REGION, CloudEndpoints(), now=NOW)
    url = decode_token(token.value)
    assert urlsplit(url).hostname == "sts.eu-west-1.amazonaws.com"
    assert urlsplit(url).scheme == "https"
    assert urlsplit(url).path == "/"
    query = parse_qs(urlsplit(url).query)
    assert query["Action"] == ["GetCallerIdentity"]
    assert query["Version"] == ["2011-06-15"]
    assert query["X-Amz-Expires"] == ["60"]
    assert query["X-Amz-SignedHeaders"] == ["host;x-k8s-aws-id"]
    assert query["X-Amz-Date"] == ["20260101T000000Z"]
    assert "X-Amz-SignedHeaders=host%3Bx-k8s-aws-id" in url
    assert token.expires_at == NOW + timedelta(minutes=14)

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW.replace(tzinfo=None) if tz is None else NOW.astimezone(tz)

        @classmethod
        def utcnow(cls):
            return NOW.replace(tzinfo=None)

    if hasattr(auth, "get_current_datetime"):
        monkeypatch.setattr(auth, "get_current_datetime", FrozenDatetime.utcnow)
    else:
        monkeypatch.setattr(auth.datetime, "datetime", FrozenDatetime)
    reference = AWSRequest(
        method="GET",
        url="https://sts.eu-west-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
        headers={"x-k8s-aws-id": "prod"},
    )
    auth.SigV4QueryAuth(Credentials(ACCESS_KEY, SECRET_KEY), "sts", REGION, expires=60).add_auth(
        reference
    )
    assert query["X-Amz-Signature"] == parse_qs(urlsplit(reference.url).query)["X-Amz-Signature"]
    assert SECRET_KEY not in repr(keys)


@pytest.fixture(autouse=True)
def local_sdk_only(monkeypatch):
    send = URLLib3Session.send

    def send_local(session, request):
        assert urlsplit(request.url).hostname == "127.0.0.1"
        return send(session, request)

    monkeypatch.setattr(URLLib3Session, "send", send_local)


@pytest.fixture
async def aws_adapter(fake_cloud, tmp_path):
    http = CloudHttp()
    dirs = CloudDirs(
        azure=tmp_path / "azure",
        aws=tmp_path / "aws",
        gcloud=tmp_path / "gcloud",
        oci=tmp_path / "oci",
    )
    fake_cloud.aws.keys[ACCESS_KEY] = SECRET_KEY
    try:
        yield make_adapters(http, fake_cloud.endpoints(), dirs)["aws"]
    finally:
        await http.close()


def entered(*regions, secret=SECRET_KEY):
    return AccountConfig(
        id="aws-account",
        provider="aws",
        source="entered",
        scope=ACCOUNT,
        settings={"access_key_id": ACCESS_KEY, "regions": list(regions)},
        secret={"secret_access_key": secret},
    )


def sso_login(directory, fake_cloud, *, expires_at):
    write_aws_cli_login(
        directory,
        profiles={
            "team": {
                "region": REGION,
                "sso_start_url": SSO_START,
                "sso_region": OTHER_REGION,
                "sso_account_id": ACCOUNT,
                "sso_role_name": ROLE_NAME,
            },
        },
        credentials={},
        sso_cache={
            hashlib.sha1(SSO_START.encode()).hexdigest(): {
                "accessToken": SSO_TOKEN,
                "expiresAt": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
        },
    )
    return AwsProfileLogin(directory, "team", fake_cloud.endpoints())


def directory_bytes(directory):
    return {p.relative_to(directory): p.read_bytes() for p in directory.rglob("*") if p.is_file()}


async def test_profile_static_keys_and_region(fake_cloud, tmp_path):
    write_aws_cli_login(
        tmp_path,
        profiles={"team": {"region": REGION}},
        credentials={
            "team": {
                "aws_access_key_id": ACCESS_KEY,
                "aws_secret_access_key": SECRET_KEY,
                "aws_session_token": "session-fixture",
            },
        },
    )
    login = AwsProfileLogin(tmp_path, "team", fake_cloud.endpoints())
    assert login.profiles() == ["team"]
    assert login.region() == REGION
    keys = await login.keys()
    assert keys == AwsKeys(ACCESS_KEY, SECRET_KEY, "session-fixture")
    assert SECRET_KEY not in repr(keys)
    assert "session-fixture" not in repr(keys)
    assert fake_cloud.requests == []


async def test_profile_sso_reads_cache_and_never_writes(fake_cloud, tmp_path, monkeypatch):
    login = sso_login(tmp_path, fake_cloud, expires_at=datetime.now(UTC) + timedelta(hours=1))
    fake_cloud.aws.sso_tokens[SSO_TOKEN] = {
        "accessKeyId": ACCESS_KEY,
        "secretAccessKey": SECRET_KEY,
        "sessionToken": "role-session-fixture",
        "expiration": int((datetime.now(UTC) + timedelta(hours=1)).timestamp() * 1000),
    }
    before = directory_bytes(tmp_path)
    path_open = type(tmp_path).open
    write_attempts = []

    def read_only_open(path, mode="r", *args, **kwargs):
        if path.is_relative_to(tmp_path) and any(flag in mode for flag in "wax+"):
            write_attempts.append(path)
            raise PermissionError(path)
        return path_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(type(tmp_path), "open", read_only_open)
    assert await login.keys() == AwsKeys(ACCESS_KEY, SECRET_KEY, "role-session-fixture")
    assert directory_bytes(tmp_path) == before
    assert write_attempts == []
    (request,) = fake_cloud.requests
    assert request.method == "GET"
    assert request.path == "/federation/credentials"
    assert request.query["account_id"] == ACCOUNT
    assert request.query["role_name"] == ROLE_NAME
    assert fake_cloud.read_only_violations() == []


async def test_credential_process_profile_plain_message(fake_cloud, tmp_path, monkeypatch):
    write_aws_cli_login(
        tmp_path,
        profiles={"team": {"credential_process": "sentinel-must-never-run", "region": REGION}},
        credentials={},
    )

    def unexpected_process(*args, **kwargs):
        pytest.fail("The credential_process profile executed a subprocess")

    monkeypatch.setattr("subprocess.Popen", unexpected_process)
    login = AwsProfileLogin(tmp_path, "team", fake_cloud.endpoints())
    with pytest.raises(CloudError) as error:
        await login.keys()
    assert str(error.value) == (
        "AWS profile team gets its keys from a program (credential_process), which the console "
        "can't run. Use a profile with keys or SSO, or enter an access key."
    )
    assert fake_cloud.requests == []


async def test_missing_profile_plain_message(fake_cloud, tmp_path, monkeypatch):
    write_aws_cli_login(tmp_path, profiles={"present": {"region": REGION}}, credentials={})
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "ambient-test-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "ambient-test-secret")
    login = AwsProfileLogin(tmp_path, "missing", fake_cloud.endpoints())
    with pytest.raises(CloudError) as error:
        await login.keys()
    assert str(error.value) == (
        f"No AWS CLI login found at {tmp_path}. Sign in with `aws configure` or `aws sso login` "
        "on this machine and mount the folder into the container (see the README), or enter "
        "credentials instead."
    )
    assert fake_cloud.requests == []


async def test_expired_sso_says_run_aws_sso_login(fake_cloud, tmp_path):
    login = sso_login(tmp_path, fake_cloud, expires_at=NOW)
    before = directory_bytes(tmp_path)
    with pytest.raises(CloudError, match="aws sso login") as error:
        await login.keys()
    assert str(error.value) == MISSING_SSO
    assert fake_cloud.requests == []
    assert directory_bytes(tmp_path) == before


async def test_verify_reads_caller_identity(aws_adapter, fake_cloud):
    identity = await aws_adapter.verify(entered(REGION))
    assert identity == AccountIdentity(ACCOUNT, f"AWS {ACCOUNT}", fake_cloud.aws.arn)


async def test_discover_regions_concurrently_with_paging_and_nodegroups(
    aws_adapter, fake_cloud, monkeypatch
):
    arrived = asyncio.Event()
    first_pages = set()
    handle = fake_cloud.aws.handle

    async def require_concurrent_regions(request, body, payload):
        if request.path == "/clusters" and not request.query:
            first_pages.add(request.headers["Authorization"].split("/")[2])
            if first_pages == {REGION, OTHER_REGION}:
                arrived.set()
            await asyncio.wait_for(arrived.wait(), timeout=5)
        return await handle(request, body, payload)

    monkeypatch.setattr(fake_cloud.aws, "handle", require_concurrent_regions)
    for region, names in [(REGION, [CLUSTER, "stage", "dev"]), (OTHER_REGION, ["alpha", "beta"])]:
        for name in names:
            fake_cloud.aws.add_eks(region, name, server=SERVER)

    pools = [
        {
            "nodegroupName": f"pool-{size}",
            "scalingConfig": {"desiredSize": size},
            "instanceTypes": ["m5.large", "m5.xlarge"],
            "version": "1.30",
        }
        for size in (1, 2, 3)
    ]
    # add_eks accepts EKS response-shaped nodegroups, so the test verifies the translation.
    prod = fake_cloud.aws.clusters[REGION][0]
    prod["nodegroups"] = pools
    prod["tags"] = {"env": "production"}

    result = await aws_adapter.discover(entered(REGION, OTHER_REGION))
    assert result.problems == []
    by_name = {cluster.name: cluster for cluster in result.clusters}
    assert set(by_name) == {CLUSTER, "stage", "dev", "alpha", "beta"}
    found = by_name[CLUSTER]
    assert found.resource_id == f"arn:aws:eks:{REGION}:{ACCOUNT}:cluster/{CLUSTER}"
    assert found.region == REGION
    assert found.kubernetes_version == prod["version"]
    assert found.node_count == 6
    assert found.node_pools == tuple(
        NodePool(f"pool-{size}", size, "m5.large", "1.30") for size in (1, 2, 3)
    )
    assert found.tags == {"env": "production"}
    assert found.details == {
        "region": REGION,
        "endpoint": SERVER,
        "ca": prod["certificateAuthority"]["data"],
    }
    assert by_name["alpha"].region == OTHER_REGION
    assert by_name["alpha"].node_count is None
    assert by_name["alpha"].node_pools == ()

    # Reaching the second page of each collection is required by the fixture counts.
    requests = fake_cloud.requests
    assert any(r.path == "/clusters" and r.query.get("nextToken") for r in requests)
    assert any(r.path.endswith("/node-groups") and r.query.get("nextToken") for r in requests)


async def test_one_region_failing_keeps_others(aws_adapter, fake_cloud):
    fake_cloud.aws.add_eks(REGION, CLUSTER, server=SERVER)
    upstream_text = "secret-like provider input must stay private"
    fake_cloud.aws.region_fail[OTHER_REGION] = (403, "UnrecognizedClientException", upstream_text)
    result = await aws_adapter.discover(entered(REGION, OTHER_REGION))
    assert [cluster.name for cluster in result.clusters] == [CLUSTER]
    assert result.problems == [
        (
            "Couldn't list clusters in eu-north-1: AWS refused access while trying to list EKS clusters: "
            "the login doesn't have permission. Check the login's permissions, then try again."
        )
    ]


async def test_private_endpoint_not_addable(aws_adapter, fake_cloud):
    fake_cloud.aws.add_eks(REGION, CLUSTER, server=SERVER, public=False)
    (found,) = (await aws_adapter.discover(entered(REGION))).clusters
    assert found.private is True
    assert found.addable is False
    assert found.why_not == (
        "Private API endpoint: the console can't reach it directly. "
        "Private clusters arrive with the in-cluster agent."
    )


async def test_bad_signature_plain_refused(aws_adapter, fake_cloud):
    wrong_key = "incorrect-test-secret"
    with pytest.raises(CloudError) as error:
        await aws_adapter.verify(entered(REGION, secret=wrong_key))
    message = str(error.value)
    assert message.startswith("AWS refused access while trying to ")
    assert message.endswith(". Check the login's permissions, then try again.")
    assert wrong_key not in message
    assert len(fake_cloud.requests) == 1


async def test_eks_token_accepted_by_fake_kube_check(aws_adapter, fake_cloud):
    fake_cloud.aws.add_eks(REGION, CLUSTER, server=SERVER)
    account = entered(REGION)
    (found,) = (await aws_adapter.discover(account)).clusters
    ref = CloudClusterRef(account.id, "aws", found.resource_id, found.name, REGION, found.details)
    fetch = aws_adapter.token_fetch(account, ref)
    token = await fetch()
    check = fake_cloud.kube_token_ok("aws")
    assert check(f"Bearer {token.value}")
    tampered_url = decode_token(token.value) + "&Action=GetCallerIdentity"
    tampered = base64.urlsafe_b64encode(tampered_url.encode()).decode().rstrip("=")
    assert not check(f"Bearer k8s-aws-v1.{tampered}")
    keys = AwsKeys(ACCESS_KEY, SECRET_KEY, None)
    for wrong_name, when in [("unknown-cluster", datetime.now(UTC)), (CLUSTER, NOW)]:
        wrong_token = eks_token(keys, wrong_name, REGION, fake_cloud.endpoints(), now=when)
        assert not check(f"Bearer {wrong_token.value}")


async def test_aws_calls_are_read_only(aws_adapter, fake_cloud):
    fake_cloud.aws.add_eks(REGION, CLUSTER, server=SERVER)
    account = entered(REGION)
    await aws_adapter.verify(account)
    (found,) = (await aws_adapter.discover(account)).clusters
    assert await aws_adapter.access(account, found) == ClusterAccess(SERVER, found.details["ca"])
    role_arn = f"arn:aws:iam::{ACCOUNT}:role/ReadOnly"
    await assume_role(
        AwsKeys(ACCESS_KEY, SECRET_KEY, None), role_arn, REGION, fake_cloud.endpoints()
    )
    assert fake_cloud.read_only_violations() == []
    sts_forms = [request.body for request in fake_cloud.requests if request.method == "POST"]
    assert [form["Action"] for form in sts_forms] == ["GetCallerIdentity", "AssumeRole"]
    assert sts_forms[-1]["RoleArn"] == role_arn
    assert sts_forms[-1]["RoleSessionName"] == "omnikrux"
    assert sum(request.path == f"/clusters/{CLUSTER}" for request in fake_cloud.requests) == 2


async def test_failed_second_page_keeps_seen_clusters_and_does_not_retry(
    aws_adapter, fake_cloud, monkeypatch
):
    for name in (CLUSTER, "stage", "dev"):
        fake_cloud.aws.add_eks(REGION, name, server=SERVER)
    handle = fake_cloud.aws.handle

    async def fail_next_page(request, body, payload):
        if request.path == "/clusters" and "nextToken" in request.query:
            return web.json_response({"message": "secret-like provider text"}, status=503)
        return await handle(request, body, payload)

    monkeypatch.setattr(fake_cloud.aws, "handle", fail_next_page)
    result = await aws_adapter.discover(entered(REGION))
    assert [found.name for found in result.clusters] == [CLUSTER, "stage"]
    assert result.problems == [
        (
            "Couldn't list clusters in eu-west-1: AWS had a problem while trying to list EKS clusters "
            "(503). Try again in a minute."
        )
    ]
    assert sum("nextToken" in request.query for request in fake_cloud.requests) == 1


async def test_aws_does_not_follow_redirects(aws_adapter, fake_cloud, monkeypatch):
    async with serve_fake_cloud() as other:

        async def redirect(request, body, payload):
            return web.Response(status=307, headers={"Location": f"{other.url}/clusters"})

        monkeypatch.setattr(fake_cloud.aws, "handle", redirect)
        result = await aws_adapter.discover(entered(REGION))

    assert result.clusters == []
    assert result.problems == [
        (
            "Couldn't list clusters in eu-west-1: AWS returned a redirect while trying to list "
            "EKS clusters. Check the cloud endpoint."
        )
    ]
    assert len(fake_cloud.requests) == 1
    assert other.requests == []


async def test_named_sso_session_never_refreshes_oidc(fake_cloud, tmp_path):
    write_aws_cli_login(
        tmp_path,
        profiles={
            "team": {
                "sso_session": "work",
                "sso_account_id": ACCOUNT,
                "sso_role_name": ROLE_NAME,
            },
            "sso-session work": {"sso_region": OTHER_REGION, "sso_start_url": SSO_START},
        },
        credentials={},
        sso_cache={
            hashlib.sha1(b"work").hexdigest(): {
                "accessToken": SSO_TOKEN,
                "expiresAt": (datetime.now(UTC) + timedelta(minutes=1)).isoformat(),
                "refreshToken": "never-exchange-me",
                "clientId": "never-send-me",
                "clientSecret": "never-send-me",
                "registrationExpiresAt": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
            },
        },
    )
    fake_cloud.aws.sso_tokens[SSO_TOKEN] = {
        "accessKeyId": ACCESS_KEY,
        "secretAccessKey": SECRET_KEY,
        "sessionToken": "role-session-fixture",
        "expiration": int((datetime.now(UTC) + timedelta(hours=1)).timestamp() * 1000),
    }
    login = AwsProfileLogin(tmp_path, "team", fake_cloud.endpoints())
    before = directory_bytes(tmp_path)
    assert await login.keys() == AwsKeys(ACCESS_KEY, SECRET_KEY, "role-session-fixture")
    assert [request.path for request in fake_cloud.requests] == ["/federation/credentials"]
    assert directory_bytes(tmp_path) == before


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/clusters", {}),
        ("/clusters", {"clusters": {"unexpected": "shape"}}),
        ("/clusters", {"clusters": [], "nextToken": False}),
        ("/clusters", {"clusters": [], "nextToken": 0}),
        (f"/clusters/{CLUSTER}/node-groups", {"nodegroups": [], "nextToken": []}),
        (f"/clusters/{CLUSTER}/node-groups", {}),
    ],
)
async def test_malformed_eks_collection_is_a_region_problem(
    aws_adapter, fake_cloud, monkeypatch, path, payload
):
    fake_cloud.aws.add_eks(REGION, CLUSTER, server=SERVER)
    handle = fake_cloud.aws.handle

    async def malformed(request, body, signed_payload):
        if request.path == path:
            return web.json_response(payload)
        return await handle(request, body, signed_payload)

    monkeypatch.setattr(fake_cloud.aws, "handle", malformed)
    result = await aws_adapter.discover(entered(REGION))
    assert result.clusters == []
    (problem,) = result.problems
    assert problem.startswith("Couldn't list clusters in eu-west-1: AWS sent an unreadable reply")


async def test_non_string_aws_error_code_uses_safe_refused_copy(
    aws_adapter, fake_cloud, monkeypatch
):
    async def malformed_error(request, body, payload):
        return web.json_response(
            {"code": ["upstream-code-sentinel"], "message": "raw-body"}, status=403
        )

    monkeypatch.setattr(fake_cloud.aws, "handle", malformed_error)
    result = await aws_adapter.discover(entered(REGION))
    assert result.clusters == []
    (problem,) = result.problems
    assert problem == (
        "Couldn't list clusters in eu-west-1: AWS refused access while trying to list EKS clusters: "
        "the login doesn't have permission. Check the login's permissions, then try again."
    )


async def test_aws_sdk_debug_does_not_log_credentials_or_raw_replies(
    aws_adapter, fake_cloud, tmp_path, caplog
):
    login = sso_login(
        tmp_path / "aws", fake_cloud, expires_at=datetime.now(UTC) + timedelta(hours=1)
    )
    role_secret = "synthetic-role-secret-sentinel"
    role_token = "synthetic-role-session-sentinel"
    raw_body = "synthetic-aws-error-body-sentinel"
    fake_cloud.aws.sso_tokens[SSO_TOKEN] = {
        "accessKeyId": ACCESS_KEY,
        "secretAccessKey": role_secret,
        "sessionToken": role_token,
        "expiration": int((datetime.now(UTC) + timedelta(hours=1)).timestamp() * 1000),
    }
    fake_cloud.aws.region_fail[REGION] = (403, "UnrecognizedClientException", raw_body)
    for module in ("auth", "endpoint", "parsers"):
        caplog.set_level(logging.DEBUG, logger=f"botocore.{module}")
    keys = await login.keys()
    assert keys == AwsKeys(ACCESS_KEY, role_secret, role_token)
    assumed = await assume_role(
        keys, f"arn:aws:iam::{ACCOUNT}:role/ReadOnly", REGION, fake_cloud.endpoints()
    )
    account = AccountConfig("test", "aws", "cli", ACCOUNT, {"profile": "team"}, None)
    (problem,) = (await aws_adapter.discover(account)).problems
    assert "AWS refused access" in problem
    assert all(
        secret not in caplog.text
        for secret in (
            SSO_TOKEN,
            role_secret,
            role_token,
            assumed.secret_access_key,
            assumed.session_token,
            raw_body,
        )
    )
    assert "CanonicalRequest" not in caplog.text
