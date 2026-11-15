import json
from dataclasses import replace
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx
import pytest
from aiohttp import web
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from omnikrux.cloud.adapters import make_adapters
from omnikrux.cloud.dirs import CloudDirs
from omnikrux.cloud.gcp import GCP_SCOPE, GcpAdcLogin, GcpServiceAccountKey
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.types import AccountConfig, CloudClusterRef, NodePool
from tests.cloud.test_http import serve_cloud_handler
from tests.fakecloud import write_gcloud_login

PROJECT = "fake-gke-project"
LOCATION = "europe-west1"
ACCOUNT = "adc-user@example.test"
KEY_EMAIL = "gke-test@fake-gke-project.iam.gserviceaccount.com"
REFRESH_TOKEN = "synthetic-refresh-token"
KUBE_SERVER = "https://kube.example.test"
LIST_PATH = f"/v1/projects/{PROJECT}/locations/-/clusters"
JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
PRIVATE_COPY = (
    "Private API endpoint: the console can't reach it directly. "
    "Private clusters arrive with the in-cluster agent."
)


@pytest.fixture(autouse=True)
def only_local_oauth(monkeypatch):
    import requests

    original_send = requests.Session.send

    def send(session, request, **kwargs):
        assert urlsplit(request.url).hostname == "127.0.0.1", "OAuth test attempted nonlocal I/O"
        return original_send(session, request, **kwargs)

    monkeypatch.setattr(requests.Session, "send", send)


@pytest.fixture
def login_dirs(tmp_path):
    return CloudDirs(**{name: tmp_path / name for name in ("azure", "aws", "gcloud", "oci")})


@pytest.fixture
def adc():
    return {
        "type": "authorized_user",
        "account": ACCOUNT,
        "client_id": "synthetic-client-id.apps.googleusercontent.com",
        "client_secret": "synthetic-client-secret",
        "refresh_token": REFRESH_TOKEN,
        "token_uri": "https://oauth2.googleapis.com/token",
    }


@pytest.fixture
def cli_folder(login_dirs, adc):
    write_gcloud_login(login_dirs.gcloud, adc=adc, project=PROJECT)
    return login_dirs.gcloud


@pytest.fixture
def service_key():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    public_pem = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode("ascii")
    )
    return {
        "type": "service_account",
        "project_id": PROJECT,
        "client_email": KEY_EMAIL,
        "private_key_id": "synthetic-key-id",
        "private_key": private_pem,
        "token_uri": "https://oauth2.googleapis.com/token",
    }, public_pem


@pytest.fixture
def gcp_cloud(fake_cloud):
    fake_cloud.gcp.refresh_tokens[REFRESH_TOKEN] = ACCOUNT
    return fake_cloud


@pytest.fixture
async def http():
    client = CloudHttp()
    try:
        yield client
    finally:
        await client.close()


@pytest.fixture
def adapter(http, gcp_cloud, login_dirs):
    return make_adapters(http, gcp_cloud.endpoints(), login_dirs)["gcp"]


@pytest.fixture
def cli_account():
    return AccountConfig("gcp-cli", "gcp", "cli", PROJECT, {"project_id": PROJECT}, None)


def cluster_ref(account, cluster):
    return CloudClusterRef(
        account.id,
        "gcp",
        cluster.resource_id,
        cluster.name,
        cluster.region,
        cluster.details,
    )


async def test_adc_authorized_user_refresh_via_token_uri(cli_folder, gcp_cloud, adc):
    endpoints = gcp_cloud.endpoints()
    login = GcpAdcLogin(cli_folder, endpoints)
    adc_path = cli_folder / "application_default_credentials.json"
    original = adc_path.read_bytes()

    token = await login.token()

    assert token.expires_at > datetime.now(UTC)
    assert login.account() == ACCOUNT
    assert adc_path.read_bytes() == original
    (request,) = gcp_cloud.requests
    assert (request.method, request.path) == (
        "POST",
        urlsplit(endpoints.gcp_oauth).path,
    )
    assert request.body["grant_type"] == "refresh_token"
    for field in ("client_id", "client_secret", "refresh_token"):
        assert request.body[field] == adc[field]


async def test_adc_missing_says_run_application_default_login(
    adapter, login_dirs, cli_account, gcp_cloud
):
    (login_dirs.gcloud / "configurations").mkdir(parents=True)
    expected = (
        "Found a gcloud login, but no application-default credentials. Run "
        "`gcloud auth application-default login` on this machine, then try again."
    )

    assert (await adapter.cli_login()).note == expected
    with pytest.raises(CloudError) as failure:
        await adapter.verify(cli_account)
    assert str(failure.value) == expected
    assert gcp_cloud.requests == []


async def test_missing_login_plain_message(adapter, login_dirs, cli_account, gcp_cloud):
    info = await adapter.cli_login()
    assert (info.state, info.choices) == ("missing", [])
    with pytest.raises(CloudError) as failure:
        await adapter.verify(cli_account)
    assert str(failure.value) == (
        f"No gcloud login found at {login_dirs.gcloud}. Sign in with "
        "`gcloud auth application-default login` on this machine and mount the folder into "
        "the container (see the README), or enter credentials instead."
    )
    assert gcp_cloud.requests == []


async def test_default_project_from_gcloud_config(adapter, cli_folder, gcp_cloud):
    (cli_folder / "active_config").write_text("custom\n", encoding="utf-8")
    (cli_folder / "configurations" / "config_custom").write_text(
        f"[core]\nproject = {PROJECT}\n", encoding="utf-8"
    )
    login = GcpAdcLogin(cli_folder, gcp_cloud.endpoints())
    assert login.default_project() == PROJECT
    info = await adapter.cli_login()
    assert (info.provider, info.path, info.state) == ("gcp", str(cli_folder), "found")
    assert [choice.value for choice in info.choices] == [PROJECT]
    assert gcp_cloud.requests == []


@pytest.mark.parametrize("source", ["adc", "entered"])
async def test_service_account_key_jwt_grant(source, login_dirs, gcp_cloud, service_key):
    info, public_pem = service_key
    gcp_cloud.gcp.service_accounts[KEY_EMAIL] = public_pem
    endpoints = gcp_cloud.endpoints()
    if source == "adc":
        write_gcloud_login(login_dirs.gcloud, adc=info, project=PROJECT)
        login = GcpAdcLogin(login_dirs.gcloud, endpoints)
        assert login.account() == KEY_EMAIL
    else:
        login = GcpServiceAccountKey(info, endpoints)

    token = await login.token()

    assert token.expires_at > datetime.now(UTC)
    assert gcp_cloud.kube_token_ok("gcp")(f"Bearer {token.value}")
    (request,) = gcp_cloud.requests
    assert (request.method, request.path) == (
        "POST",
        urlsplit(endpoints.gcp_oauth).path,
    )
    assert request.body["grant_type"] == JWT_GRANT
    assert GCP_SCOPE == "https://www.googleapis.com/auth/cloud-platform"


@pytest.mark.parametrize("secret", ["not-json", "[]", '{"type": "authorized_user"}'])
async def test_not_a_service_account_key_plain(adapter, cli_account, gcp_cloud, secret):
    entered = replace(cli_account, source="entered", secret={"service_account_key": secret})
    with pytest.raises(CloudError) as failure:
        await adapter.verify(entered)
    assert str(failure.value) == (
        "That isn't a Google service-account key: paste the JSON file you downloaded "
        "for the service account."
    )
    assert gcp_cloud.requests == []


@pytest.mark.parametrize("credential_type", ["external_account", "impersonated_service_account"])
async def test_workload_adc_refused_before_refresh(login_dirs, gcp_cloud, credential_type):
    write_gcloud_login(login_dirs.gcloud, adc={"type": credential_type}, project=PROJECT)
    with pytest.raises(CloudError, match=r"^Workload identity arrives with deployed mode\.$"):
        await GcpAdcLogin(login_dirs.gcloud, gcp_cloud.endpoints()).token()
    assert gcp_cloud.requests == []


async def test_expired_adc_plain(cli_folder, gcp_cloud, caplog):
    caplog.set_level("DEBUG")
    private_detail = "upstream-echo-of-synthetic-secret"

    async def reject(_request):
        return web.json_response(
            {"error": "invalid_grant", "error_description": private_detail}, status=400
        )

    async with serve_cloud_handler(reject) as origin:
        endpoints = replace(gcp_cloud.endpoints(), gcp_oauth=f"{origin}/token")
        with pytest.raises(CloudError) as failure:
            await GcpAdcLogin(cli_folder, endpoints).token()
    assert str(failure.value) == (
        "Your gcloud login has expired. Run `gcloud auth application-default login` "
        "on this machine, then try again."
    )
    assert private_detail not in caplog.text
    assert REFRESH_TOKEN not in repr([record.__dict__ for record in caplog.records])
    assert private_detail not in repr([record.__dict__ for record in caplog.records])


@pytest.mark.parametrize("same_origin", [False, True])
async def test_refresh_does_not_follow_redirect(cli_folder, gcp_cloud, same_origin):
    received = []

    async def redirected(request):
        received.append(request.path)
        return web.json_response({"access_token": "redirected-token", "expires_in": 3600})

    async def token(request):
        if request.path == "/redirected":
            return await redirected(request)
        received.append(request.path)
        destination = origin if same_origin else other_origin
        raise web.HTTPTemporaryRedirect(f"{destination}/redirected")

    async with (
        serve_cloud_handler(redirected) as other_origin,
        serve_cloud_handler(token) as origin,
    ):
        endpoints = replace(gcp_cloud.endpoints(), gcp_oauth=f"{origin}/token")
        with pytest.raises(CloudError) as failure:
            await GcpAdcLogin(cli_folder, endpoints).token()
    assert received == ["/token"]
    assert "/redirected" not in str(failure.value)


async def test_refresh_uses_cloud_timeout(cli_folder, gcp_cloud, monkeypatch):
    import requests

    original_send = requests.Session.send
    timeouts = []

    def send(session, request, **kwargs):
        timeouts.append(kwargs.get("timeout"))
        return original_send(session, request, **kwargs)

    monkeypatch.setattr(requests.Session, "send", send)
    await GcpAdcLogin(cli_folder, gcp_cloud.endpoints()).token()
    assert timeouts == [20]


async def test_refresh_throttling_is_safe_and_does_not_retry(cli_folder, gcp_cloud, caplog):
    caplog.set_level("DEBUG")
    calls = []
    detail = "synthetic-upstream-secret"

    async def throttle(request):
        calls.append(request.path)
        return web.json_response({"error_description": detail}, status=429)

    async with serve_cloud_handler(throttle) as origin:
        endpoints = replace(gcp_cloud.endpoints(), gcp_oauth=f"{origin}/token")
        with pytest.raises(CloudError) as failure:
            await GcpAdcLogin(cli_folder, endpoints).token()

    assert calls == ["/token"]
    assert str(failure.value) == (
        "Google Cloud is limiting requests while trying to refresh the login. "
        "Omnikrux tries again at the next check."
    )
    assert detail not in repr([record.__dict__ for record in caplog.records])


async def test_verify_names_project_and_principal(
    adapter, cli_account, cli_folder, gcp_cloud, service_key
):
    key, public_pem = service_key
    gcp_cloud.gcp.service_accounts[KEY_EMAIL] = public_pem
    gcp_cloud.gcp.projects[PROJECT] = []
    entered = replace(
        cli_account,
        id="entered",
        source="entered",
        secret={"service_account_key": json.dumps(key)},
    )
    for account, principal in [(cli_account, ACCOUNT), (entered, KEY_EMAIL)]:
        identity = await adapter.verify(account)
        assert (identity.scope, identity.name, identity.principal) == (
            PROJECT,
            PROJECT,
            principal,
        )
    assert [request.path for request in gcp_cloud.requests if request.method == "GET"] == [
        LIST_PATH,
        LIST_PATH,
    ]


async def test_discover_gke_clusters_metadata(adapter, cli_account, cli_folder, gcp_cloud):
    gcp_cloud.gcp.add_gke(
        PROJECT,
        "demo",
        server=KUBE_SERVER,
        location=LOCATION,
        labels={"env": "prod"},
        pools=[
            {
                "name": "system",
                "config": {"machineType": "e2-standard-2"},
                "version": "1.31.4",
            },
            {"name": "worker"},
        ],
    )
    source = gcp_cloud.gcp.projects[PROJECT][0]
    source["currentMasterVersion"] = "1.32.1-gke.100"
    source["currentNodeCount"] = 4

    result = await adapter.discover(cli_account)

    assert result.problems == []
    (found,) = result.clusters
    assert (found.resource_id, found.name, found.region) == (
        f"projects/{PROJECT}/locations/{LOCATION}/clusters/demo",
        "demo",
        LOCATION,
    )
    assert (found.kubernetes_version, found.node_count) == ("1.32.1-gke.100", 4)
    assert found.node_pools == (
        NodePool("system", None, "e2-standard-2", "1.31.4"),
        NodePool("worker", None, None, None),
    )
    assert found.tags == {"env": "prod"}
    assert found.addable and not found.private
    assert found.details == {
        "endpoint": KUBE_SERVER,
        "ca": source["masterAuth"]["clusterCaCertificate"],
    }
    assert gcp_cloud.requests[-1].path == LIST_PATH


@pytest.mark.parametrize("endpoint", ["192.0.2.5", KUBE_SERVER])
async def test_gke_access_uses_latest_endpoint_and_ca(
    adapter, cli_account, cli_folder, gcp_cloud, endpoint
):
    gcp_cloud.gcp.add_gke(PROJECT, "demo", server=KUBE_SERVER)
    source = gcp_cloud.gcp.projects[PROJECT][0]
    await adapter.discover(cli_account)
    source["endpoint"] = endpoint
    source["masterAuth"]["clusterCaCertificate"] = "bmV3LWNh"
    (found,) = (await adapter.discover(cli_account)).clusters
    request_count = len(gcp_cloud.requests)
    access = await adapter.access(cli_account, found)
    assert access.server == (endpoint if "://" in endpoint else f"https://{endpoint}")
    assert access.ca_data == "bmV3LWNh"
    assert len(gcp_cloud.requests) == request_count


async def test_missing_zones_reported_as_problem(adapter, cli_account, cli_folder, gcp_cloud):
    gcp_cloud.gcp.add_gke(PROJECT, "available", server=KUBE_SERVER)
    gcp_cloud.gcp.missing_zones[PROJECT] = ["europe-west1-b", "europe-west1-c"]
    result = await adapter.discover(cli_account)
    assert [cluster.name for cluster in result.clusters] == ["available"]
    assert result.problems == [
        f"Couldn't list clusters in {zone}: Google Cloud didn't answer for this zone."
        for zone in ("europe-west1-b", "europe-west1-c")
    ]


async def test_gke_omitted_repeated_fields_are_empty(adapter, cli_account, cli_folder):
    result = await adapter.discover(cli_account)
    assert result.clusters == []
    assert result.problems == []


@pytest.mark.parametrize(
    "payload",
    [
        {"clusters": None},
        {"clusters": {"secret": "upstream detail"}},
        {"clusters": [None]},
        {"missingZones": "upstream detail"},
        {"missingZones": [None]},
    ],
)
async def test_gke_malformed_repeated_fields_are_rejected(
    http, login_dirs, cli_account, cli_folder, gcp_cloud, payload
):
    async def container_api(_request):
        return web.json_response(payload)

    async with serve_cloud_handler(container_api) as origin:
        endpoints = replace(gcp_cloud.endpoints(), gcp_container=origin)
        adapter = make_adapters(http, endpoints, login_dirs)["gcp"]
        with pytest.raises(CloudError) as failure:
            await adapter.discover(cli_account)

    assert str(failure.value) == (
        "Google Cloud sent an unreadable cluster list. Try again in a minute."
    )


@pytest.mark.parametrize(
    ("legacy_private", "modern_public", "private"),
    [
        (True, None, True),
        (False, None, False),
        (None, False, True),
        (None, True, False),
        (False, False, True),
        (True, True, False),
    ],
)
async def test_private_endpoint_not_addable(
    adapter, cli_account, cli_folder, gcp_cloud, legacy_private, modern_public, private
):
    gcp_cloud.gcp.add_gke(PROJECT, "demo", server=KUBE_SERVER)
    source = gcp_cloud.gcp.projects[PROJECT][0]
    if legacy_private is None:
        source.pop("privateClusterConfig", None)
    else:
        source["privateClusterConfig"] = {"enablePrivateEndpoint": legacy_private}
    source["controlPlaneEndpointsConfig"] = {
        "ipEndpointsConfig": {}
        if modern_public is None
        else {"enablePublicEndpoint": modern_public}
    }

    (found,) = (await adapter.discover(cli_account)).clusters

    assert found.private is private
    assert found.addable is not private
    assert found.why_not == (PRIVATE_COPY if private else None)


@pytest.mark.parametrize("operation", ["verify", "discover"])
async def test_api_disabled_plain_message(adapter, cli_account, cli_folder, gcp_cloud, operation):
    gcp_cloud.gcp.disabled_projects.add(PROJECT)
    with pytest.raises(CloudError) as failure:
        await getattr(adapter, operation)(cli_account)
    assert str(failure.value) == (
        f"The Kubernetes Engine API isn't enabled in {PROJECT}, so there are no GKE clusters "
        "to list. Enable it in the Google Cloud console if you expected some."
    )


async def test_service_disabled_text_without_error_info_is_a_permission_failure(
    adapter, cli_account, cli_folder, gcp_cloud
):
    gcp_cloud.fail[LIST_PATH] = (403, "SERVICE_DISABLED, upstream detail")
    with pytest.raises(CloudError) as failure:
        await adapter.discover(cli_account)
    assert str(failure.value) == (
        "Google Cloud refused access while trying to list clusters: "
        "the login doesn't have permission. Check the login's permissions, then try again."
    )


async def test_gke_token_is_access_token(adapter, cli_account, cli_folder, gcp_cloud):
    gcp_cloud.gcp.add_gke(PROJECT, "demo", server=KUBE_SERVER)
    (found,) = (await adapter.discover(cli_account)).clusters
    token = await adapter.token_fetch(cli_account, cluster_ref(cli_account, found))()
    kube_accepts = gcp_cloud.kube_token_ok("gcp")
    assert kube_accepts(f"Bearer {token.value}")
    assert not kube_accepts("Bearer never-issued")
    assert not kube_accepts(None)


async def test_gcp_calls_are_read_only(adapter, cli_account, cli_folder, gcp_cloud):
    gcp_cloud.gcp.add_gke(PROJECT, "demo", server=KUBE_SERVER)
    await adapter.verify(cli_account)
    (found,) = (await adapter.discover(cli_account)).clusters
    await adapter.access(cli_account, found)
    await adapter.token_fetch(cli_account, cluster_ref(cli_account, found))()
    paths = {(request.method, request.path) for request in gcp_cloud.requests}
    assert paths == {
        ("GET", LIST_PATH),
        ("POST", urlsplit(gcp_cloud.endpoints().gcp_oauth).path),
    }
    assert gcp_cloud.read_only_violations() == []


async def test_fakecloud_gcp_rejects_tampered_jwt(gcp_cloud, service_key):
    info, public_pem = service_key
    gcp_cloud.gcp.service_accounts[KEY_EMAIL] = public_pem
    endpoints = gcp_cloud.endpoints()
    await GcpServiceAccountKey(info, endpoints).token()
    (grant,) = gcp_cloud.requests
    parts = grant.body["assertion"].split(".")
    parts[2] = ("B" if parts[2].startswith("A") else "A") + parts[2][1:]
    tampered = {**grant.body, "assertion": ".".join(parts)}

    async with httpx.AsyncClient(base_url=gcp_cloud.url, trust_env=False) as client:
        rejected_grant = await client.post(urlsplit(endpoints.gcp_oauth).path, data=tampered)

    assert rejected_grant.status_code in (400, 401)
    assert rejected_grant.json()["error"] == "invalid_grant"


async def test_invalid_project_rejected_before_cloud_io(
    adapter, cli_account, cli_folder, gcp_cloud
):
    project = "../outside-project"
    invalid = replace(cli_account, scope=project, settings={"project_id": project})
    with pytest.raises(CloudError):
        await adapter.verify(invalid)
    with pytest.raises(CloudError):
        await adapter.discover(invalid)
    assert gcp_cloud.requests == []


async def test_entered_key_cannot_redirect_default_oauth(service_key, monkeypatch):
    import requests

    from omnikrux.cloud.endpoints import CloudEndpoints

    info, _ = service_key
    info["token_uri"] = "http://127.0.0.1:1/untrusted-credential-endpoint"
    endpoints = CloudEndpoints()
    sent = []

    def send(_session, request, **_kwargs):
        sent.append(request.url)
        raise requests.ConnectionError("transport stopped before network I/O")

    monkeypatch.setattr(requests.Session, "send", send)
    with pytest.raises(CloudError):
        await GcpServiceAccountKey(info, endpoints).token()
    assert sent in ([], [endpoints.gcp_oauth])


@pytest.mark.parametrize(
    "malformed",
    [
        {"refresh_token": None},
        {"refresh_token": ""},
        {"refresh_token": 42},
        {"refresh_token": "\ud800"},
        {"access_token": None, "refresh_token": "untrusted-rotation"},
        {"expires_in": None, "refresh_token": "untrusted-rotation"},
        {"scope": ["not-a-string"], "refresh_token": "untrusted-rotation"},
    ],
)
async def test_malformed_oauth_success_cannot_poison_adc(cli_folder, gcp_cloud, malformed):
    received = []

    async def oauth(request):
        received.append((await request.post())["refresh_token"])
        reply = {"access_token": "synthetic-access", "expires_in": 3600}
        if len(received) == 1:
            reply.update(malformed)
        return web.json_response(reply)

    async with serve_cloud_handler(oauth) as origin:
        endpoints = replace(gcp_cloud.endpoints(), gcp_oauth=f"{origin}/token")
        login = GcpAdcLogin(cli_folder, endpoints)
        with pytest.raises(CloudError, match="unreadable login reply"):
            await login.token()
        assert (await login.token()).value == "synthetic-access"

    assert received == [REFRESH_TOKEN, REFRESH_TOKEN]


async def test_valid_oauth_rotation_is_used_in_memory(cli_folder, gcp_cloud):
    received = []
    adc_file = cli_folder / "application_default_credentials.json"
    initial = adc_file.read_bytes()

    async def oauth(request):
        received.append((await request.post())["refresh_token"])
        return web.json_response(
            {
                "access_token": "synthetic-access",
                "expires_in": 3600,
                "refresh_token": "synthetic-rotated-refresh",
            }
        )

    async with serve_cloud_handler(oauth) as origin:
        endpoints = replace(gcp_cloud.endpoints(), gcp_oauth=f"{origin}/token")
        login = GcpAdcLogin(cli_folder, endpoints)
        await login.token()
        await login.token()

    assert received == [REFRESH_TOKEN, "synthetic-rotated-refresh"]
    assert adc_file.read_bytes() == initial


@pytest.mark.parametrize("source", ["adc", "entered"])
async def test_ec_service_account_key_is_rejected_locally(
    source, login_dirs, gcp_cloud, adapter, cli_account
):
    key = ec.generate_private_key(ec.SECP256R1())
    info = {
        "type": "service_account",
        "client_email": KEY_EMAIL,
        "private_key": key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii"),
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    account = cli_account
    if source == "adc":
        write_gcloud_login(login_dirs.gcloud, adc=info, project=PROJECT)
    else:
        account = replace(
            cli_account, source="entered", secret={"service_account_key": json.dumps(info)}
        )

    with pytest.raises(CloudError) as failure:
        await adapter.verify(account)
    assert str(failure.value) == (
        "That isn't a Google service-account key: paste the JSON file you downloaded "
        "for the service account."
    )
    assert gcp_cloud.requests == []


async def test_missing_node_pool_list_is_unknown(adapter, cli_account, cli_folder, gcp_cloud):
    gcp_cloud.gcp.add_gke(PROJECT, "demo", server=KUBE_SERVER, location=LOCATION)
    gcp_cloud.gcp.projects[PROJECT][0].pop("nodePools", None)
    (found,) = (await adapter.discover(cli_account)).clusters
    assert found.node_pools is None
