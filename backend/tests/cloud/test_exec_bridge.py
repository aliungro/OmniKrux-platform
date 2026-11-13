import asyncio
import json
import logging
from copy import deepcopy
from datetime import timedelta
from urllib.parse import urlsplit

import pytest
from botocore.httpsession import URLLib3Session
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from omnikrux.cloud.aws import EKS_TOKEN_SECONDS, AwsKeys, eks_token
from omnikrux.cloud.dirs import CloudDirs
from omnikrux.cloud.exec_bridge import ExecBridge
from omnikrux.cloud.http import CloudHttp
from omnikrux.cloud.oci import OKE_TOKEN_SECONDS, OciProfileLogin, oke_token
from omnikrux.kube.tokens import ClusterUnavailable, ExecPluginToken, NativeToken, RunPlugin
from tests.fakecloud import (
    write_aws_cli_login,
    write_azure_cli_login,
    write_gcloud_login,
    write_oci_cli_login,
)

AWS_ACCESS_KEY = "AKIDBRIDGEEXAMPLE"
AWS_SECRET_KEY = "synthetic-bridge-aws-secret"
AWS_REGION = "eu-west-1"
AWS_PROFILE_REGION = "eu-north-1"
AZURE_SERVER = "api://bridge-test"
AZURE_TENANT = "a1656f69-93d5-4e1b-9583-d3722c77dafe"
AZURE_OTHER_TENANT = "c87afbde-f01b-4f27-b7ac-292a24ed41e5"
AZURE_REFRESH = "synthetic-bridge-azure-refresh"
AZURE_USER = "test-user@example.test"
OCI_REGION = "eu-frankfurt-1"
OCI_CLUSTER = "ocid1.cluster.oc1.eu-frankfurt-1.ccc"
ADC_FLAG = "--use_application_default_credentials"


def exec_config(command, *args, **env):
    return {
        "apiVersion": "client.authentication.k8s.io/v1beta1",
        "command": command,
        "args": list(args),
        "env": [{"name": name, "value": value} for name, value in env.items()],
    }


@pytest.fixture(autouse=True)
def keep_auth_local(monkeypatch):
    send = URLLib3Session.send

    def send_local(session, request):
        assert urlsplit(request.url).hostname == "127.0.0.1"
        return send(session, request)

    async def no_subprocess(*args, **kwargs):
        pytest.fail("Unexpected exec plugin subprocess")

    monkeypatch.setattr(URLLib3Session, "send", send_local)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_subprocess)


@pytest.fixture
def dirs(tmp_path):
    return CloudDirs(**{name: tmp_path / name for name in ("azure", "aws", "gcloud", "oci")})


@pytest.fixture
async def http():
    http = CloudHttp()
    try:
        yield http
    finally:
        await http.close()


@pytest.fixture
def bridge(dirs, fake_cloud, http):
    return ExecBridge(dirs, fake_cloud.endpoints(), http, which=lambda _: None)


def aws_login(directory, profile="default"):
    write_aws_cli_login(
        directory,
        profiles={profile: {"region": AWS_PROFILE_REGION}},
        credentials={
            profile: {"aws_access_key_id": AWS_ACCESS_KEY, "aws_secret_access_key": AWS_SECRET_KEY}
        },
    )


async def native_token(bridge, config):
    plan = bridge.resolve(config)
    assert isinstance(plan, NativeToken)
    return await plan.fetch()


def check_eks_token(token, cluster, region, fake_cloud):
    assert token.expires_at is not None
    assert token == eks_token(
        AwsKeys(AWS_ACCESS_KEY, AWS_SECRET_KEY, None),
        cluster,
        region,
        fake_cloud.endpoints(),
        now=token.expires_at - timedelta(seconds=EKS_TOKEN_SECONDS),
    )


@pytest.mark.parametrize(
    ("command", "args"),
    [
        ("aws", ["eks", "get-token", "--cluster-name", "prod", "--region", AWS_REGION]),
        (r"C:\cli\aws.exe", ["eks", "get-token", "--cluster-id=prod", f"--region={AWS_REGION}"]),
        (
            "aws",
            [
                "--region",
                AWS_REGION,
                "eks",
                "get-token",
                "--cluster-name",
                "prod",
                "--output",
                "json",
            ],
        ),
    ],
)
async def test_aws_eks_get_token_bridged(bridge, dirs, fake_cloud, command, args):
    aws_login(dirs.aws)
    config = exec_config(command, *args)
    original = deepcopy(config)

    token = await native_token(bridge, config)

    check_eks_token(token, "prod", AWS_REGION, fake_cloud)
    assert config == original
    assert fake_cloud.requests == []


async def test_aws_bridge_honours_profile_env_and_role_arn(bridge, dirs, fake_cloud, caplog):
    aws_login(dirs.aws, "ops")
    fake_cloud.aws.keys[AWS_ACCESS_KEY] = AWS_SECRET_KEY
    fake_cloud.aws.add_eks(AWS_REGION, "prod", server=fake_cloud.url)
    role = "arn:aws:iam::123456789012:role/BridgeReadOnly"
    config = exec_config(
        "aws",
        "eks",
        "get-token",
        "--cluster-name",
        "prod",
        "--role-arn",
        role,
        AWS_PROFILE="ops",
        AWS_DEFAULT_REGION=AWS_REGION,
    )

    with caplog.at_level(logging.DEBUG):
        token = await native_token(bridge, config)

    (request,) = fake_cloud.requests
    assert request.body["Action"] == "AssumeRole"
    assert request.body["RoleArn"] == role
    assert f"Credential={AWS_ACCESS_KEY}/" in request.headers["Authorization"]
    assert fake_cloud.kube_token_ok("aws")(f"Bearer {token.value}")
    for secret in (
        AWS_SECRET_KEY,
        "fake-assumed-role-secret-",
        "fake-assumed-role-token-",
        "CanonicalRequest:",
        request.headers["Authorization"],
        token.value,
    ):
        assert secret not in caplog.text


@pytest.mark.parametrize(
    ("region_args", "env", "region"),
    [
        (["--region", AWS_REGION], {"AWS_REGION": "us-east-1"}, AWS_REGION),
        ([], {"AWS_REGION": AWS_REGION, "AWS_DEFAULT_REGION": "us-east-1"}, AWS_REGION),
        ([], {}, AWS_PROFILE_REGION),
    ],
)
async def test_aws_iam_authenticator_bridged(bridge, dirs, fake_cloud, region_args, env, region):
    aws_login(dirs.aws)
    config = exec_config("aws-iam-authenticator", "token", "-i", "prod", *region_args, **env)

    token = await native_token(bridge, config)

    check_eks_token(token, "prod", region, fake_cloud)
    assert fake_cloud.requests == []


@pytest.mark.parametrize("auth", [None, "api_key", "security_token"])
async def test_oci_generate_token_bridged(bridge, dirs, fake_cloud, auth):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    profile = {
        "region": "uk-london-1",
        "tenancy": "ocid1.tenancy.oc1..aaa",
        "user": "ocid1.user.oc1..bbb",
        "fingerprint": "aa:bb",
    }
    if auth == "security_token":
        profile["security_token_file"] = "token"
    write_oci_cli_login(
        dirs.oci, profiles={"OPS": profile}, key_pem=key_pem, key_path_as_written="key.pem"
    )
    if auth == "security_token":
        (dirs.oci / "token").write_text("synthetic.oci.session", encoding="ascii")
    signer = OciProfileLogin(dirs.oci, "OPS").signer()
    if auth != "security_token":
        # The CLI defaults to API-key auth even when the profile has a session file.
        profile["security_token_file"] = "token"
        write_oci_cli_login(
            dirs.oci, profiles={"OPS": profile}, key_pem=key_pem, key_path_as_written="key.pem"
        )
        (dirs.oci / "token").write_text("synthetic.oci.session", encoding="ascii")
    auth_args = ["--auth", auth] if auth else []
    config = exec_config(
        "oci",
        "ce",
        "cluster",
        "generate-token",
        "--cluster-id",
        OCI_CLUSTER,
        "--region",
        OCI_REGION,
        "--profile",
        "OPS",
        *auth_args,
    )

    token = await native_token(bridge, config)

    assert token.expires_at is not None
    assert token == oke_token(
        signer,
        OCI_CLUSTER,
        OCI_REGION,
        fake_cloud.endpoints(),
        now=token.expires_at - timedelta(seconds=OKE_TOKEN_SECONDS),
    )
    assert fake_cloud.requests == []


@pytest.mark.parametrize(
    ("login_args", "env", "tenant_args", "tenant"),
    [
        (["--login", "azurecli"], {}, [], AZURE_TENANT),
        (["-l", "interactive"], {}, ["--tenant-id", AZURE_OTHER_TENANT], AZURE_OTHER_TENANT),
        ([], {"AAD_LOGIN_METHOD": "devicecode"}, [], AZURE_TENANT),
    ],
)
async def test_kubelogin_azurecli_bridged_with_server_id_scope(
    bridge, dirs, fake_cloud, login_args, env, tenant_args, tenant
):
    write_azure_cli_login(
        dirs.azure,
        subscriptions=[
            {
                "id": "d6e0f202-c8fd-4a40-86c9-e541a03b8079",
                "name": "Other",
                "tenantId": AZURE_OTHER_TENANT,
                "isDefault": False,
            },
            {
                "id": "050d52ed-0bc8-46c3-95e1-a7aef67ff331",
                "name": "Default",
                "tenantId": AZURE_TENANT,
                "isDefault": True,
            },
        ],
        refresh_token=AZURE_REFRESH,
        user=AZURE_USER,
    )
    fake_cloud.azure.refresh_tokens[AZURE_REFRESH] = (tenant, AZURE_USER)
    config = exec_config(
        "kubelogin", "get-token", *login_args, "--server-id", AZURE_SERVER, *tenant_args, **env
    )

    token = await native_token(bridge, config)

    assert token.value.startswith("az-")
    (request,) = fake_cloud.requests
    assert (request.method, request.path) == ("POST", f"/{tenant}/oauth2/v2.0/token")
    assert request.body["refresh_token"] == AZURE_REFRESH
    assert request.body["scope"] == f"{AZURE_SERVER}/.default offline_access openid profile"


async def test_kubelogin_devicecode_without_azure_login_plain(bridge):
    config = exec_config("kubelogin", "get-token", "-l", "devicecode", "--server-id", AZURE_SERVER)

    with pytest.raises(ClusterUnavailable) as failure:
        await native_token(bridge, config)

    assert str(failure.value) == (
        "This AKS cluster signs in with kubelogin's devicecode login, which needs a browser or "
        "the Azure CLI, and the console has neither. Connect the subscription under Settings, "
        "or convert the kubeconfig with `kubelogin convert-kubeconfig -l spn`."
    )


async def test_kubelogin_spn_runs_binary_with_azure_config_dir(bridge, dirs, monkeypatch):
    config = exec_config("kubelogin", "get-token", "-l", "spn", AZURE_CLIENT_ID="synthetic-client")
    original = deepcopy(config)
    executable = str(dirs.azure / "bin" / "kubelogin")
    monkeypatch.setattr("omnikrux.kube.tokens.shutil.which", lambda _: executable)

    class Plugin:
        returncode = 0

        async def communicate(self):
            return json.dumps(
                {
                    "apiVersion": config["apiVersion"],
                    "kind": "ExecCredential",
                    "status": {"token": "synthetic-plugin-token"},
                }
            ).encode(), b""

    async def launch(command, *args, env, **kwargs):
        assert command == executable
        assert list(args) == config["args"]
        assert env["AZURE_CONFIG_DIR"] == str(dirs.azure)
        assert env["AZURE_CLIENT_ID"] == "synthetic-client"
        return Plugin()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    plan = bridge.resolve(config)

    assert isinstance(plan, RunPlugin)
    assert (await ExecPluginToken(plan)()).value == "synthetic-plugin-token"
    assert config == original


@pytest.mark.parametrize("args", [[], [ADC_FLAG]])
def test_gke_plugin_gets_adc_flag_without_gcloud(bridge, dirs, args):
    write_gcloud_login(dirs.gcloud, adc={"type": "authorized_user"}, project=None)
    config = exec_config("gke-gcloud-auth-plugin", *args)
    original = deepcopy(config)

    plan = bridge.resolve(config)

    assert isinstance(plan, RunPlugin)
    assert plan.exec_cfg["args"] == [ADC_FLAG]
    assert plan.env["GOOGLE_APPLICATION_CREDENTIALS"] == str(
        dirs.gcloud / "application_default_credentials.json"
    )
    assert config == original


def test_gke_plugin_without_adc_plain(bridge):
    with pytest.raises(ClusterUnavailable) as failure:
        bridge.resolve(exec_config("gke-gcloud-auth-plugin"))

    assert str(failure.value) == (
        "Found a gcloud login, but no application-default credentials. "
        "Run `gcloud auth application-default login` on this machine, then try again."
    )


@pytest.mark.parametrize(
    ("command", "installed"),
    [
        ("aws", "aws"),
        ("aws-iam-authenticator", "aws-iam-authenticator"),
        ("oci", "oci"),
        ("gke-gcloud-auth-plugin", "gcloud"),
    ],
)
def test_real_binary_on_path_wins(dirs, fake_cloud, http, command, installed):
    bridge = ExecBridge(
        dirs,
        fake_cloud.endpoints(),
        http,
        which=lambda name: f"/usr/bin/{name}" if name == installed else None,
    )
    config = exec_config(command, "custom-command")

    assert bridge.resolve(config) == RunPlugin(config, cloud=True)


def test_unsupported_aws_subcommand_plain(bridge):
    with pytest.raises(ClusterUnavailable) as failure:
        bridge.resolve(exec_config("aws", "sts", "get-caller-identity"))

    assert str(failure.value) == (
        "This cluster signs in with 'aws sts get-caller-identity', which the console can't run: "
        "it only runs 'aws eks get-token'. Connect the AWS account under Settings instead."
    )


def test_unsupported_command_does_not_echo_untrusted_arguments(bridge):
    secret = "synthetic-secret-argument"
    config = exec_config("oci", "ce", "cluster", "generate-token", "--unknown", secret)

    with pytest.raises(ClusterUnavailable) as failure:
        bridge.resolve(config)

    assert "it only runs 'oci ce cluster generate-token'" in str(failure.value)
    assert secret not in str(failure.value)
