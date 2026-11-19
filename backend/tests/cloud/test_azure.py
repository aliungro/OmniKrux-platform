import json
import logging
from dataclasses import asdict, replace
from datetime import UTC, datetime
from urllib.parse import urlencode

import pytest
from aiohttp import web

from omnikrux.cloud.adapters import make_adapters
from omnikrux.cloud.azure import AzureCliLogin, AzureServicePrincipal
from omnikrux.cloud.dirs import CloudDirs
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.types import AccountConfig, CloudClusterRef, NodePool
from tests.cloud.test_http import serve_cloud_handler
from tests.fakecloud import write_azure_cli_login

AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
AKS_SERVER_APP_ID = "6dae42f8-4368-4678-94ff-3960e28e3630"
ARM_SCOPE = "https://management.azure.com/.default"
SUBSCRIPTION = "050d52ed-0bc8-46c3-95e1-a7aef67ff331"
OTHER_SUBSCRIPTION = "d6e0f202-c8fd-4a40-86c9-e541a03b8079"
TENANT = "a1656f69-93d5-4e1b-9583-d3722c77dafe"
CLIENT_ID = "c87afbde-f01b-4f27-b7ac-292a24ed41e5"
USER = "test-user@example.test"
CLIENT_SECRET = "fake-service-principal-secret"
REFRESH_TOKEN = "fake-cli-refresh-token"
KUBE_SERVER = "https://test-cluster.example.test"
WINDOWS_NOTE = (
    "Your Azure CLI login is encrypted for your Windows account, so the console's container "
    "can't read it. Connect with a service principal instead "
    "(Settings → Cloud accounts → Enter credentials)."
)


@pytest.fixture
def login_dirs(tmp_path):
    return CloudDirs(
        **{name: tmp_path / "logins" / name for name in ("azure", "aws", "gcloud", "oci")}
    )


@pytest.fixture
def cli_folder(login_dirs):
    write_azure_cli_login(
        login_dirs.azure,
        subscriptions=[
            {"id": SUBSCRIPTION, "name": "Main", "tenantId": TENANT, "isDefault": True},
            {"id": OTHER_SUBSCRIPTION, "name": "Sandbox", "tenantId": TENANT, "isDefault": False},
        ],
        refresh_token=REFRESH_TOKEN,
        user=USER,
    )
    return login_dirs.azure


@pytest.fixture
def azure_cloud(fake_cloud):
    fake_cloud.azure.subscriptions[SUBSCRIPTION] = {"name": "Test subscription", "tenant": TENANT}
    fake_cloud.azure.service_principals[(TENANT, CLIENT_ID)] = CLIENT_SECRET
    fake_cloud.azure.refresh_tokens[REFRESH_TOKEN] = (TENANT, USER)
    return fake_cloud


@pytest.fixture
async def http():
    http = CloudHttp()
    try:
        yield http
    finally:
        await http.close()


@pytest.fixture
def adapter(http, azure_cloud, login_dirs):
    return make_adapters(http, azure_cloud.endpoints(), login_dirs)["azure"]


@pytest.fixture
def entered_account():
    return AccountConfig(
        id="entered-account",
        provider="azure",
        source="entered",
        scope=SUBSCRIPTION,
        settings={"subscription_id": SUBSCRIPTION, "tenant_id": TENANT, "client_id": CLIENT_ID},
        secret={"client_secret": CLIENT_SECRET},
    )


@pytest.fixture
def cli_account():
    return AccountConfig(
        id="cli-account",
        provider="azure",
        source="cli",
        scope=SUBSCRIPTION,
        settings={"subscription_id": SUBSCRIPTION},
        secret=None,
    )


async def test_cli_login_lists_subscriptions_from_profile(adapter, cli_folder, azure_cloud, http):
    login = AzureCliLogin(cli_folder, http, azure_cloud.endpoints())
    assert (cli_folder / "azureProfile.json").read_bytes().startswith(b"\xef\xbb\xbf")
    assert [asdict(item) for item in login.subscriptions()] == [
        {"id": SUBSCRIPTION, "name": "Main", "tenant_id": TENANT, "user": USER, "is_default": True},
        {
            "id": OTHER_SUBSCRIPTION,
            "name": "Sandbox",
            "tenant_id": TENANT,
            "user": USER,
            "is_default": False,
        },
    ]
    info = await adapter.cli_login()
    assert (info.provider, info.path, info.state, info.note) == (
        "azure",
        str(cli_folder),
        "found",
        None,
    )
    assert [(choice.value, choice.label) for choice in info.choices] == [
        (SUBSCRIPTION, f"Main ({SUBSCRIPTION})"),
        (OTHER_SUBSCRIPTION, f"Sandbox ({OTHER_SUBSCRIPTION})"),
    ]


async def test_cli_login_refreshes_with_cached_refresh_token(cli_folder, azure_cloud, http):
    cache_path = cli_folder / "msal_token_cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    entries = cache["RefreshToken"]
    matching = next(iter(entries.values()))
    cache["RefreshToken"] = {
        "wrong-app": {**matching, "client_id": CLIENT_ID, "secret": "other-client-refresh"},
        "wrong-user": {**matching, "home_account_id": "other-user", "secret": "other-user-refresh"},
        "wrong-host": {
            **matching,
            "environment": "login.other.test",
            "secret": "other-host-refresh",
        },
        **entries,
    }
    cache_path.write_text(json.dumps(cache), encoding="utf-8")

    login = AzureCliLogin(cli_folder, http, azure_cloud.endpoints())
    token = await login.token(TENANT, ARM_SCOPE)

    assert token.value.startswith("az-")
    assert token.expires_at > datetime.now(UTC)
    (request,) = azure_cloud.requests
    assert (request.method, request.path) == ("POST", f"/{TENANT}/oauth2/v2.0/token")
    assert request.body == {
        "client_id": AZURE_CLI_CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": REFRESH_TOKEN,
        "scope": f"{ARM_SCOPE} offline_access openid profile",
    }


@pytest.mark.parametrize(
    ("timestamps", "accepted", "attempts"),
    [
        ([100, 200], 1, [1]),
        ([200, 100, 300], 1, [2, 0, 1]),
        ([50, 300, 200, 400, 100], 0, [3, 1, 2, 4]),
    ],
)
async def test_cli_refresh_tries_newest_matches_with_bounded_invalid_grant_fallback(
    cli_folder, azure_cloud, http, caplog, timestamps, accepted, attempts
):
    cache_path = cli_folder / "msal_token_cache.json"
    cache = json.loads(cache_path.read_bytes())
    example = next(iter(cache["RefreshToken"].values()))
    tokens = [f"matching-refresh-{index}" for index in range(len(timestamps))]
    cache["RefreshToken"] = {
        token: {**example, "secret": token, "last_modification_time": str(timestamp)}
        for token, timestamp in zip(tokens, timestamps, strict=True)
    }
    cache_path.write_text(json.dumps(cache), encoding="utf-8")
    initial = cache_path.read_bytes()
    azure_cloud.azure.refresh_tokens[tokens[accepted]] = (TENANT, USER)
    login = AzureCliLogin(cli_folder, http, azure_cloud.endpoints())

    if accepted in attempts:
        assert (await login.token(TENANT, ARM_SCOPE)).value.startswith("az-")
    else:
        with pytest.raises(CloudError, match="Your Azure CLI login has expired") as failure:
            await login.token(TENANT, ARM_SCOPE)
        assert all(token not in str(failure.value) for token in tokens)

    assert [request.body["refresh_token"] for request in azure_cloud.requests] == [
        tokens[index] for index in attempts
    ]
    assert cache_path.read_bytes() == initial
    assert all(token not in caplog.text for token in tokens)


async def test_cli_refresh_does_not_fall_back_on_unrelated_errors(cli_folder, azure_cloud, http):
    cache_path = cli_folder / "msal_token_cache.json"
    cache = json.loads(cache_path.read_bytes())
    entries = cache["RefreshToken"]
    matching = next(iter(entries.values()))
    entries["another-token"] = {
        **matching,
        "secret": "another-token",
        "last_modification_time": "100",
    }
    cache_path.write_text(json.dumps(cache), encoding="utf-8")
    azure_cloud.fail[r"/oauth2/v2\.0/token$"] = (403, "unknown provider detail")

    login = AzureCliLogin(cli_folder, http, azure_cloud.endpoints())
    with pytest.raises(CloudError, match="Azure refused access"):
        await login.token(TENANT, ARM_SCOPE)

    assert [request.body["refresh_token"] for request in azure_cloud.requests] == ["another-token"]


async def test_rotated_refresh_token_kept_in_memory_only(cli_folder, azure_cloud, http):
    paths = [cli_folder / "azureProfile.json", cli_folder / "msal_token_cache.json"]
    initial = [path.read_bytes() for path in paths]
    refreshes = []

    async def rotate(request):
        form = await request.post()
        refreshes.append(form["refresh_token"])
        return web.json_response(
            {
                "access_token": f"test-access-{len(refreshes)}",
                "expires_in": 3600,
                "refresh_token": "rotated-refresh-token",
            }
        )

    async with serve_cloud_handler(rotate) as url:
        login = AzureCliLogin(cli_folder, http, replace(azure_cloud.endpoints(), azure_login=url))
        assert (await login.token(TENANT, ARM_SCOPE)).value == "test-access-1"
        assert (await login.token(TENANT, ARM_SCOPE)).value == "test-access-2"

    assert refreshes == [REFRESH_TOKEN, "rotated-refresh-token"]
    assert [path.read_bytes() for path in paths] == initial


async def test_windows_encrypted_cache_plain_message(adapter, cli_folder, cli_account, azure_cloud):
    (cli_folder / "msal_token_cache.json").unlink()
    (cli_folder / "msal_token_cache.bin").write_bytes(b"encrypted")
    login = await adapter.cli_login()
    assert login.note == WINDOWS_NOTE
    with pytest.raises(CloudError) as failure:
        await adapter.verify(cli_account)
    assert str(failure.value) == WINDOWS_NOTE
    assert not azure_cloud.requests


async def test_missing_login_plain_message(adapter, login_dirs, cli_account, azure_cloud):
    login = await adapter.cli_login()
    assert (login.state, login.note, login.choices) == ("missing", None, [])
    with pytest.raises(CloudError) as failure:
        await adapter.verify(cli_account)
    assert str(failure.value) == (
        f"No Azure CLI login found at {login_dirs.azure}. Sign in with "
        "`az login` on this machine and mount the folder into the container "
        "(see the README), or enter credentials instead."
    )
    assert not azure_cloud.requests


async def test_expired_refresh_token_says_run_az_login(cli_folder, azure_cloud, http, caplog):
    async def fail(_request):
        return web.json_response(
            {"error": "invalid_grant", "error_description": "sensitive echoed refresh token"},
            status=400,
        )

    async with serve_cloud_handler(fail) as url:
        login = AzureCliLogin(cli_folder, http, replace(azure_cloud.endpoints(), azure_login=url))
        with pytest.raises(CloudError) as failure:
            await login.token(TENANT, ARM_SCOPE)
    assert str(failure.value) == (
        "Your Azure CLI login has expired. Run `az login` on this machine, then try again."
    )
    assert "sensitive echoed refresh token" not in caplog.text


async def test_service_principal_client_credentials(azure_cloud, http):
    login = AzureServicePrincipal(TENANT, CLIENT_ID, CLIENT_SECRET, http, azure_cloud.endpoints())
    token = await login.token(TENANT, ARM_SCOPE)
    assert token.value.startswith("az-")
    assert token.expires_at > datetime.now(UTC)
    (request,) = azure_cloud.requests
    assert (request.method, request.path) == ("POST", f"/{TENANT}/oauth2/v2.0/token")
    assert request.body == {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "client_credentials",
        "scope": ARM_SCOPE,
    }


async def test_verify_names_subscription(
    adapter, azure_cloud, entered_account, cli_account, cli_folder
):
    entered = await adapter.verify(entered_account)
    assert (entered.scope, entered.name, entered.principal) == (
        SUBSCRIPTION,
        "Test subscription",
        CLIENT_ID,
    )
    cli = await adapter.verify(cli_account)
    assert (cli.scope, cli.name, cli.principal) == (SUBSCRIPTION, "Test subscription", USER)
    verify_requests = [item for item in azure_cloud.requests if item.method == "GET"]
    assert len(verify_requests) == 2
    assert all(item.path == f"/subscriptions/{SUBSCRIPTION}" for item in verify_requests)
    assert all(item.query["api-version"] == "2022-12-01" for item in verify_requests)


async def test_discover_aks_pages_and_metadata(adapter, azure_cloud, entered_account):
    azure_cloud.azure.add_aks(
        SUBSCRIPTION,
        "First",
        server=KUBE_SERVER,
        pools=[
            {
                "name": "system",
                "count": 2,
                "vmSize": "Standard_D2",
                "currentOrchestratorVersion": "1.31.2",
                "orchestratorVersion": "1.30.0",
            },
            {
                "name": "worker",
                "count": 3,
                "vmSize": "Standard_D4",
                "orchestratorVersion": "1.31.1",
            },
        ],
        tags={"env": "prod"},
    )
    azure_cloud.azure.add_aks(
        SUBSCRIPTION, "Second", server=KUBE_SERVER, pools=[{"name": "unknown"}]
    )
    azure_cloud.azure.add_aks(SUBSCRIPTION, "Third", server=KUBE_SERVER)
    source = azure_cloud.azure.clusters[SUBSCRIPTION][0]
    source["properties"]["currentKubernetesVersion"] = "1.31.2"
    source["properties"]["kubernetesVersion"] = "1.30.0"
    second = azure_cloud.azure.clusters[SUBSCRIPTION][1]
    second["properties"].pop("currentKubernetesVersion", None)
    second["properties"]["kubernetesVersion"] = "1.30.1"

    discovered = await adapter.discover(entered_account)

    assert discovered.problems == []
    assert [cluster.name for cluster in discovered.clusters] == ["First", "Second", "Third"]
    first = discovered.clusters[0]
    assert first.resource_id == source["id"].lower()
    assert first.region == "westeurope"
    assert first.kubernetes_version == "1.31.2"
    assert first.node_count == 5
    assert first.node_pools == (
        NodePool("system", 2, "Standard_D2", "1.31.2"),
        NodePool("worker", 3, "Standard_D4", "1.31.1"),
    )
    assert first.tags == {"env": "prod"}
    assert first.details == {
        "resource_group": source["id"].split("/")[4],
        "server_app_id": AKS_SERVER_APP_ID,
        "tenant_id": TENANT,
    }
    assert first.addable
    assert discovered.clusters[1].node_count is None
    assert discovered.clusters[1].kubernetes_version == "1.30.1"
    reads = [item for item in azure_cloud.requests if item.path.endswith("/managedClusters")]
    assert len(reads) == 2
    assert all(item.query["api-version"] == "2024-09-01" for item in reads)


async def test_private_and_local_account_clusters_not_addable(
    adapter, azure_cloud, entered_account
):
    azure_cloud.azure.add_aks(
        SUBSCRIPTION, "private", server=KUBE_SERVER, private=True, entra=False
    )
    azure_cloud.azure.add_aks(SUBSCRIPTION, "local", server=KUBE_SERVER, entra=False)
    result = await adapter.discover(entered_account)
    private, local = result.clusters
    assert private.private and not private.addable
    assert private.why_not == (
        "Private API endpoint: the console can't reach it directly. "
        "Private clusters arrive with the in-cluster agent."
    )
    assert not local.private and not local.addable
    assert local.why_not == (
        "This cluster uses local accounts, not Microsoft Entra ID. OmniKrux signs in to AKS only "
        "with short-lived Entra tokens: turn on Entra ID integration, or import its kubeconfig."
    )


async def test_access_reads_server_and_ca_only(adapter, azure_cloud, entered_account):
    azure_cloud.azure.add_aks(SUBSCRIPTION, "demo", server=KUBE_SERVER)
    (found,) = (await adapter.discover(entered_account)).clusters
    access = await adapter.access(entered_account, found)
    assert set(asdict(access)) == {"server", "ca_data"}
    assert access.server == KUBE_SERVER
    assert access.ca_data
    request = azure_cloud.requests[-1]
    assert request.method == "POST"
    assert request.path.endswith("/listClusterUserCredential")
    assert request.query == {"api-version": "2024-09-01", "format": "exec"}


async def test_aks_token_scope_is_server_app(adapter, azure_cloud, entered_account):
    azure_cloud.azure.add_aks(SUBSCRIPTION, "demo", server=KUBE_SERVER)
    source = azure_cloud.azure.clusters[SUBSCRIPTION][0]
    source["properties"]["aadProfile"]["serverAppID"] = CLIENT_ID
    (found,) = (await adapter.discover(entered_account)).clusters
    ref = CloudClusterRef(
        entered_account.id, "azure", found.resource_id, found.name, found.region, found.details
    )
    token = await adapter.token_fetch(entered_account, ref)()
    assert azure_cloud.requests[-1].body["scope"] == f"{CLIENT_ID}/.default"
    accepts = azure_cloud.kube_token_ok("azure")
    assert accepts(f"Bearer {token.value}")
    assert not accepts("Bearer not-issued")
    assert not accepts(None)
    assert not accepts(f"Bearer {azure_cloud.requests[-2].headers['Authorization'].split()[-1]}")


async def test_workload_source_says_deployed_mode(adapter, azure_cloud, entered_account):
    workload = replace(entered_account, source="workload", secret=None)
    ref = CloudClusterRef(workload.id, "azure", "/cluster", "demo", "westeurope", {})
    with pytest.raises(CloudError, match=r"^Workload identity arrives with deployed mode\.$"):
        await adapter.verify(workload)
    with pytest.raises(CloudError, match=r"^Workload identity arrives with deployed mode\.$"):
        await adapter.discover(workload)
    with pytest.raises(CloudError, match=r"^Workload identity arrives with deployed mode\.$"):
        await adapter.token_fetch(workload, ref)()
    assert not azure_cloud.requests


async def test_azure_calls_are_read_only(adapter, azure_cloud, entered_account):
    azure_cloud.azure.add_aks(SUBSCRIPTION, "demo", server=KUBE_SERVER)
    await adapter.verify(entered_account)
    (found,) = (await adapter.discover(entered_account)).clusters
    await adapter.access(entered_account, found)
    ref = CloudClusterRef(
        entered_account.id, "azure", found.resource_id, found.name, found.region, found.details
    )
    await adapter.token_fetch(entered_account, ref)()
    assert azure_cloud.read_only_violations() == []


async def test_second_page_failure_names_problem(http, azure_cloud, entered_account, login_dirs):
    requests = []
    page_path = (
        f"/subscriptions/{SUBSCRIPTION}/providers/Microsoft.ContainerService/managedClusters"
    )
    azure_cloud.azure.add_aks(SUBSCRIPTION, "first", server=KUBE_SERVER)
    query = urlencode({"api-version": "2024-09-01", "$skiptoken": "next"})

    async def arm(request):
        requests.append(request.query.get("$skiptoken"))
        if "$skiptoken" in request.query:
            return web.json_response({"error": {"message": "untrusted page detail"}}, status=500)
        return web.json_response(
            {
                "value": azure_cloud.azure.clusters[SUBSCRIPTION],
                "nextLink": f"{url}{page_path}?{query}",
            }
        )

    async with serve_cloud_handler(arm) as url:
        adapter = make_adapters(http, replace(azure_cloud.endpoints(), azure_arm=url), login_dirs)[
            "azure"
        ]
        with pytest.raises(CloudError) as failure:
            await adapter.discover(entered_account)
    assert str(failure.value) == (
        "Azure had a problem while trying to list clusters (500). Try again in a minute."
    )
    assert requests == [None, "next"]


@pytest.mark.parametrize("has_userinfo", [True, False])
async def test_azure_pagination_rejects_other_origins(
    http, azure_cloud, entered_account, login_dirs, has_userinfo
):
    received = []

    async def other_arm(request):
        received.append(request.headers.get("Authorization"))
        return web.json_response({"value": []})

    async def arm(_request):
        target = other_url
        if has_userinfo:
            target = f"{url}@{other_url.removeprefix('http://')}"
        return web.json_response({"value": [], "nextLink": f"{target}/private-next-link"})

    async with serve_cloud_handler(other_arm) as other_url, serve_cloud_handler(arm) as url:
        adapter = make_adapters(http, replace(azure_cloud.endpoints(), azure_arm=url), login_dirs)[
            "azure"
        ]
        with pytest.raises(CloudError) as failure:
            await adapter.discover(entered_account)
    assert "Azure" in str(failure.value)
    assert "private-next-link" not in str(failure.value)
    assert received == []


async def test_azure_pagination_accepts_normalized_origin(
    http, azure_cloud, entered_account, login_dirs
):
    received = []

    async def arm(request):
        received.append(request.headers.get("Authorization"))
        if "page" in request.query:
            return web.json_response({"value": []})
        next_url = url.replace("127.0.0.1", "LOCALHOST")
        return web.json_response({"value": [], "nextLink": f"{next_url}{request.path}?page=2"})

    async with serve_cloud_handler(arm) as url:
        endpoints = replace(
            azure_cloud.endpoints(), azure_arm=url.replace("127.0.0.1", "localhost")
        )
        adapter = make_adapters(http, endpoints, login_dirs)["azure"]
        result = await adapter.discover(entered_account)
    assert result.clusters == []
    assert len(received) == 2
    assert received[0] == received[1]
    assert received[0].startswith("Bearer az-")


@pytest.mark.parametrize("link", [{"private-link-detail": True}, ["private-link-detail"], 123])
async def test_azure_pagination_rejects_malformed_link_safely(
    http, azure_cloud, entered_account, login_dirs, link
):
    received = []

    async def arm(request):
        received.append(request.path)
        return web.json_response({"value": [], "nextLink": link})

    async with serve_cloud_handler(arm) as url:
        adapter = make_adapters(http, replace(azure_cloud.endpoints(), azure_arm=url), login_dirs)[
            "azure"
        ]
        with pytest.raises(CloudError) as failure:
            await adapter.discover(entered_account)
    assert str(failure.value) == (
        "Azure returned an invalid link to the next page of clusters. Try again in a minute."
    )
    assert len(received) == 1


async def test_malformed_oauth_rotation_preserves_last_usable_cli_token(
    cli_folder, azure_cloud, http, caplog
):
    paths = [cli_folder / "azureProfile.json", cli_folder / "msal_token_cache.json"]
    initial = [path.read_bytes() for path in paths]
    received = []
    prior_rotation = "synthetic-valid-memory-refresh"

    async def oauth(request):
        received.append((await request.post())["refresh_token"])
        reply = {"access_token": f"synthetic-access-{len(received)}", "expires_in": 3600}
        if len(received) == 1:
            reply["refresh_token"] = prior_rotation
        elif len(received) == 2:
            # json_response emits the lone surrogate as an escaped JSON code unit.
            reply["refresh_token"] = "synthetic-poison-\ud800"
        return web.json_response(reply)

    async with serve_cloud_handler(oauth) as url:
        endpoints = replace(azure_cloud.endpoints(), azure_login=url)
        login = AzureCliLogin(cli_folder, http, endpoints)
        with caplog.at_level(logging.DEBUG):
            assert (await login.token(TENANT, ARM_SCOPE)).value == "synthetic-access-1"
            failure = None
            try:
                await login.token(TENANT, ARM_SCOPE)
            except CloudError as exc:
                failure = str(exc)
            # Attempt the next exchange even if the malformed reply incorrectly succeeded.
            assert (await login.token(TENANT, ARM_SCOPE)).value == "synthetic-access-3"

    assert failure == "Azure sent an unreadable token. Check the login, then try again."
    assert received == [REFRESH_TOKEN, prior_rotation, prior_rotation]
    assert [path.read_bytes() for path in paths] == initial
    for secret in (REFRESH_TOKEN, prior_rotation, "synthetic-poison-", "synthetic-access-2"):
        assert secret not in caplog.text


async def test_missing_agent_pool_list_is_unknown(adapter, azure_cloud, entered_account):
    azure_cloud.azure.add_aks(SUBSCRIPTION, "NoPools", server=KUBE_SERVER)
    azure_cloud.azure.clusters[SUBSCRIPTION][0]["properties"].pop("agentPoolProfiles")
    (found,) = (await adapter.discover(entered_account)).clusters
    assert found.node_pools is None and found.node_count is None
