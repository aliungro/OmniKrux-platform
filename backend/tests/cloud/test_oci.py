import base64
import hashlib
import json
import re
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit

import pytest
from aiohttp import web
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from omnikrux.cloud.adapters import make_adapters
from omnikrux.cloud.dirs import CloudDirs
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.oci import OciApiKey, OciProfileLogin, OciSigner, oke_token
from omnikrux.cloud.types import AccountConfig, CloudClusterRef, NodePool
from tests.fakecloud import write_oci_cli_login

REGION = "eu-frankfurt-1"
OTHER_REGION = "uk-london-1"
TENANCY = "ocid1.tenancy.oc1..aaa"
USER = "ocid1.user.oc1..bbb"
CLUSTER = "ocid1.cluster.oc1.eu-frankfurt-1.ccc"
FINGERPRINT = "aa:bb"
KEY_ID = f"{TENANCY}/{USER}/{FINGERPRINT}"
DATE = "Thu, 01 Jan 2026 00:00:00 GMT"
NOW = datetime(2026, 1, 1, tzinfo=UTC)
IDENTITY_URL = f"https://identity.{REGION}.oci.oraclecloud.com/20160918/tenancies/{TENANCY}"
SIGNING_HEADERS = "date (request-target) host"
SERVER = "https://127.0.0.1:6443"
PROFILE = {
    "region": REGION,
    "tenancy": TENANCY,
    "user": USER,
    "fingerprint": FINGERPRINT,
}

# Disposable synthetic key for deterministic signature vectors.
VECTOR_KEY_PEM = b"""
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCVtLAUftRnqjRD
e/VMsAMGzjdT8GplVpUMwUzDMA8z5xIexscLD5GuiNCBlnlhcpSvRRaa/CZIRHn/
d2c8IDprrRv5rUwGFjZWsHHhBcdPSSArwusK/NnxP2Y1nw/HgwiuyasyNdbZQTE5
Vv6iYtMPp4E6qBlVBpuYy2tmqCRfceGH7zelKLW1DgZJuJ4bF/JgyAoM00QiMx6w
BF95DnuWIrm4stHIEeD8IkuGrug7wOH0NHLbDvJCAyM+Gw7jc+3xW1rk4NrDlRh0
N4/3EAw/5sikHcx5i82LLvbLmu7t+y7U0vFdnjzxyYea/BwGmfuks7RXY/fjc/s0
QcZF5a1bAgMBAAECggEALowMx4Kb1lOkhmsPXTXI6x/JMi8pVbLzCxE7JeFWiMPK
7YjOsJC5sjPV6MT5nqP6uPhZS/0khgnMiPL+RUKcB4i+jwYkAix73r5j2hxq2Ssa
dqDXZgYyWYFl7Tw0ssr6MyZ/NVBqKgjMHlD/QUxK5a4mTy+fGMHCNWLiVPvou0f6
jk3udlqNBVdKhr49JxJrKpEk0IYrbAgdiv6hwnNtNfgRUTIuOTrbkdSsAk2AA5zX
k3xA3EZwCc8Iq6EEcP2aiahKSGFhp7xTttZyLOWCKfEyWqkqZ6OpuC3xWUl6xbhb
Ii32ArKW1DflD1Ceu6vZ8aNxTuzx789pjW/BFYtf4QKBgQDLItey5hn7+rl5kFzw
WjQ/GPYnfWTaRtKbhK3abpNvp5jUOqXJlzjErDZce9N2z+702kQIt3LhzwyB2Qwq
YkxBtZgcu3/bYsa8tYVoH42HUKA2HZ7L9DZcRDl6Huyb1J69wbbomYzybrKCN7PF
KLziKKmb+rOTex0SaEC6fXvosQKBgQC8qkI2DzxQBcfk2rdg82lRwLLsrYU0LANp
drCTX97KO+L9r45glIky3fU7hwNDrV0slDf+yujoyLTLGKCv/YRx/Lw+8ddeEL27
TGThG1eqXgc2Zr4OSuOT7a03iVSPVkdDEvhaN6D0/zSA2y1T747PhNdkDPW667VU
ZwepCFD5ywKBgGArj7j3rSeZjQPbb9Sur/uLYsZRXFTmoMDV8MTwAscirn0TgvfM
qyiZa2cfjH68dKHhT8Jcr3vuXTqAOn06amXVhj1cG20O943R1mX0Qjnk1uSn400l
wjKubhO93kDsSXcG5gR65brE46g4nNhjsADWRW4+I5RX/eyABN0FmYsRAoGAPwfG
vRbT+Iwl30Bu+XX43rY5ULccBHUb4rUjgukJnpjpWgW31G5rc9IRpwSRQ5/8u/L8
ziPuMi8zr5KXxJQ3FnnwTjsvz55aNOPt5ALlg+aMFFG49z9vzrEeKKq51HVns3H4
BPQG0zMb0FzpRNyI4q2n5CYsRnmPCBavyXocy4cCgYBpJ/ydBQ9+6mYZK7XxTcCQ
4WIKdH0yLZ/VoC/idc3ZTIqtxa7CDCSMox5N4hleu+GWCAXvZewKYZ8EpL/Yxwfo
vwqxDEBnj5rm1mwOfT2XA0GJlxUUwlC9qAPdb3+ASh2iQNaXcT+nBV52XN4NtAXc
g9Rejx8Yh7U8bbcDgqLoMQ==
-----END PRIVATE KEY-----
"""


@pytest.fixture(scope="module")
def key():
    return serialization.load_pem_private_key(VECTOR_KEY_PEM, password=None)


def pem(key, encryption=None):
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        encryption or serialization.NoEncryption(),
    )


def lower_headers(headers):
    return {name.lower(): value for name, value in headers.items()}


def auth_fields(authorization):
    assert authorization.startswith("Signature ")
    return dict(re.findall(r'(\w+)="([^"]+)"', authorization))


def verify_signature(key, auth, signing_string):
    fields = auth_fields(auth)
    assert fields["algorithm"] == "rsa-sha256"
    assert fields["version"] == "1"
    key.public_key().verify(
        base64.b64decode(fields["signature"], validate=True),
        signing_string.encode(),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )


def test_signing_string_get_pinned(key):
    headers = lower_headers(OciSigner(KEY_ID, key).sign("GET", IDENTITY_URL, {"Date": DATE}))
    auth = headers["authorization"]
    assert headers["date"] == DATE
    assert auth_fields(auth)["headers"] == SIGNING_HEADERS
    assert auth_fields(auth)["keyId"] == KEY_ID
    verify_signature(
        key,
        auth,
        "date: Thu, 01 Jan 2026 00:00:00 GMT\n"
        "(request-target): get /20160918/tenancies/ocid1.tenancy.oc1..aaa\n"
        "host: identity.eu-frankfurt-1.oci.oraclecloud.com",
    )


def test_signing_post_includes_body_hash(key):
    body = '{"displayName":"café"}'.encode()
    target = "/20180222/cluster?name=a%2Bb&next=one%2Ftwo"
    host = "containerengine.eu-frankfurt-1.oci.oraclecloud.com"
    headers = lower_headers(
        OciSigner(KEY_ID, key).sign(
            "POST",
            f"https://{host}{target}",
            {"Date": DATE, "Content-Type": "application/json"},
            body,
        )
    )
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    assert headers["x-content-sha256"] == digest
    assert headers["content-length"] == str(len(body))
    assert auth_fields(headers["authorization"])["headers"] == (
        f"{SIGNING_HEADERS} content-length content-type x-content-sha256"
    )
    verify_signature(
        key,
        headers["authorization"],
        f"date: {DATE}\n(request-target): post {target}\nhost: {host}\n"
        f"content-length: {len(body)}\ncontent-type: application/json\nx-content-sha256: {digest}",
    )


def test_oke_token_format_pinned(key):
    # Oracle CLI v3.96.2 with OCI Python SDK 2.191.0. No SDK imports or network requests.
    # Choose a path length that requires padding so trimming it breaks the vector.
    cluster = f"{CLUSTER}aa"
    host = f"containerengine.{REGION}.oraclecloud.com"
    path = f"/cluster_request/{cluster}"
    url = f"https://{host}{path}"
    signing_string = f"date: {DATE}\n(request-target): get {path}\nhost: {host}"
    signature = base64.b64encode(
        key.sign(signing_string.encode(), padding.PKCS1v15(), hashes.SHA256())
    ).decode()
    authorization = (
        f'Signature algorithm="rsa-sha256",headers="{SIGNING_HEADERS}",'
        f'keyId="{KEY_ID}",signature="{signature}",version="1"'
    )
    query = urlencode([("authorization", authorization), ("date", DATE)])
    expected = base64.urlsafe_b64encode(f"{url}?{query}".encode()).decode()
    assert expected.endswith("=")
    token = oke_token(OciSigner(KEY_ID, key), cluster, REGION, CloudEndpoints(), now=NOW)
    assert token.value == expected
    decoded_url = base64.urlsafe_b64decode(token.value).decode()
    assert decoded_url.split("?", 1)[0] == url
    assert parse_qsl(urlsplit(decoded_url).query) == [
        ("authorization", authorization),
        ("date", DATE),
    ]
    verify_signature(key, authorization, signing_string)
    assert token.expires_at == NOW + timedelta(minutes=4)


def write_profile(directory, key_path, **fields):
    directory.mkdir(exist_ok=True)
    values = {**PROFILE, "key_file": key_path, **fields}
    contents = "[DEFAULT]\n" + "".join(f"{name}={value}\n" for name, value in values.items())
    (directory / "config").write_text(contents, encoding="utf-8")


@pytest.mark.parametrize(
    ("as_written", "mounted"),
    [
        (r"C:\Users\me\.oci\oci_api_key.pem", "oci_api_key.pem"),
        ("~/.oci/keys/k.pem", "keys/k.pem"),
    ],
)
def test_key_file_host_path_remapped_into_mount(tmp_path, key, as_written, mounted):
    write_profile(tmp_path, as_written)
    path = tmp_path / mounted
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(pem(key))
    signer = OciProfileLogin(tmp_path).signer()
    auth = lower_headers(signer.sign("GET", IDENTITY_URL, {"Date": DATE}))["authorization"]
    assert auth_fields(auth)["keyId"] == KEY_ID


def test_session_token_key_id(tmp_path, key):
    write_profile(
        tmp_path,
        "key.pem",
        security_token_file=r"C:\Users\me\.oci\sessions\token",
        pass_phrase="test-passphrase",
    )
    encrypted = serialization.BestAvailableEncryption(b"test-passphrase")
    (tmp_path / "key.pem").write_bytes(pem(key, encrypted))
    (tmp_path / "sessions").mkdir()
    (tmp_path / "sessions" / "token").write_text("synthetic.session.token\n", encoding="utf-8")
    signer = OciProfileLogin(tmp_path).signer()
    auth = lower_headers(signer.sign("GET", IDENTITY_URL, {"Date": DATE}))["authorization"]
    assert auth_fields(auth)["keyId"] == "ST$synthetic.session.token"


def missing_file_message(path, basename):
    return (
        f"OCI profile DEFAULT points at the key file {path}, which isn't in the mounted folder. "
        f"Put {basename} next to the OCI config, then try again."
    )


def test_missing_key_file_plain_message(tmp_path):
    path = r"C:\Users\me\.oci\missing.pem"
    write_profile(tmp_path, path)
    with pytest.raises(CloudError) as error:
        OciProfileLogin(tmp_path).signer()
    assert str(error.value) == missing_file_message(path, "missing.pem")


@pytest.mark.parametrize("field", ["key_file", "security_token_file"])
@pytest.mark.parametrize("escape", ["absolute", "traversal", "symlink"])
def test_profile_never_reads_outside_mount(tmp_path, monkeypatch, key, field, escape):
    login = tmp_path / "login"
    login.mkdir()
    outside = tmp_path / "external"
    outside.write_bytes(pem(key))
    if escape == "absolute":
        as_written = str(outside)
    elif escape == "traversal":
        as_written = "../external"
    else:
        as_written = "external"
        try:
            (login / as_written).symlink_to(outside)
        except OSError:
            pytest.skip("symlink creation unavailable on this filesystem")
    if field == "key_file":
        write_profile(login, as_written)
    else:
        write_profile(login, "key.pem", security_token_file=as_written)
        (login / "key.pem").write_bytes(pem(key))

    open_path = type(outside).open

    def reject_external_read(path, *args, **kwargs):
        assert path.resolve() != outside, "OCI profile attempted to read outside its mount"
        return open_path(path, *args, **kwargs)

    monkeypatch.setattr(type(outside), "open", reject_external_read)
    with pytest.raises(CloudError) as error:
        OciProfileLogin(login).signer()
    assert str(error.value) == missing_file_message(as_written, "external")


@pytest.mark.parametrize("field", ["key_file", "security_token_file"])
@pytest.mark.parametrize("symlink_parent", [False, True])
def test_dangling_symlink_never_reads_mount_fallback(
    tmp_path, monkeypatch, key, field, symlink_parent
):
    login = tmp_path / "login"
    login.mkdir()
    as_written = "linked/credential" if symlink_parent else ".oci/credential"
    candidate = login / as_written
    outside = tmp_path / "absent" / "credential"
    fallback = login / "credential"
    fallback.write_bytes(pem(key) if field == "key_file" else b"synthetic.session.token")
    if field == "key_file":
        write_profile(login, as_written)
    else:
        write_profile(login, "key.pem", security_token_file=as_written)
        (login / "key.pem").write_bytes(pem(key))

    # Model a dangling link without needing Windows symlink creation privileges.
    path_type = type(login)
    resolve_path, read_bytes = path_type.resolve, path_type.read_bytes

    def resolve(path, *args, **kwargs):
        if path == candidate:
            return outside
        return resolve_path(path, *args, **kwargs)

    def reject_credential_read(path):
        assert path not in {outside, fallback}
        return read_bytes(path)

    monkeypatch.setattr(path_type, "resolve", resolve)
    monkeypatch.setattr(path_type, "read_bytes", reject_credential_read)
    with pytest.raises(CloudError) as error:
        OciProfileLogin(login).signer()
    assert str(error.value) == missing_file_message(as_written, "credential")


@pytest.mark.parametrize("bad_passphrase", [False, True])
def test_bad_private_key_plain_message(key, bad_passphrase):
    private_key = (
        pem(key, serialization.BestAvailableEncryption(b"synthetic-correct-passphrase")).decode()
        if bad_passphrase
        else "synthetic-invalid-pem"
    )
    with pytest.raises(CloudError) as error:
        OciApiKey(TENANCY, USER, FINGERPRINT, private_key, "synthetic-wrong-passphrase").signer()
    assert str(error.value) == (
        "That private key can't be read: check it is the PEM file for this API key, and its passphrase."
    )


@pytest.fixture
async def oci_setup(fake_cloud, tmp_path, key):
    fake_cloud.oci.keys[KEY_ID] = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    fake_cloud.oci.tenancy.update(id=TENANCY, name="Local test tenancy")
    http = CloudHttp()
    adapter = make_adapters(
        http, fake_cloud.endpoints(), CloudDirs(tmp_path, tmp_path, tmp_path, tmp_path)
    )["oci"]
    account = AccountConfig(
        id="local-test-account",
        provider="oci",
        source="entered",
        scope=TENANCY,
        settings={
            "tenancy_ocid": TENANCY,
            "user_ocid": USER,
            "fingerprint": FINGERPRINT,
            "regions": [REGION, OTHER_REGION],
        },
        secret={"private_key": pem(key).decode()},
    )
    try:
        yield adapter, account
    finally:
        await http.close()


async def test_verify_names_tenancy(fake_cloud, oci_setup):
    adapter, account = oci_setup
    identity = await adapter.verify(account)
    assert (identity.scope, identity.name, identity.principal) == (
        TENANCY,
        "Local test tenancy",
        USER,
    )
    assert any(REGION in request.path for request in fake_cloud.requests)


async def test_cli_login_choices_and_session_principal(fake_cloud, oci_setup, tmp_path, key):
    adapter, account = oci_setup
    token = "local.session"
    (tmp_path / "token").write_text(token, encoding="utf-8")
    profile = {
        "tenancy": TENANCY,
        "region": OTHER_REGION,
        "security_token_file": "token",
    }
    write_oci_cli_login(
        tmp_path,
        profiles={"SESSION": profile},
        key_pem=pem(key),
        key_path_as_written="key.pem",
    )
    fake_cloud.oci.keys[f"ST${token}"] = fake_cloud.oci.keys[KEY_ID]
    account.source = "cli"
    account.settings = {"profile": "SESSION", "regions": [REGION]}
    account.secret = None
    assert "SESSION" in {choice.value for choice in (await adapter.cli_login()).choices}
    identity = await adapter.verify(account)
    assert identity.principal == "SESSION"
    assert any(OTHER_REGION in request.path for request in fake_cloud.requests)


async def test_discover_compartments_regions_paging(fake_cloud, oci_setup):
    adapter, account = oci_setup
    compartments = [f"ocid1.compartment.oc1..aaa{i}" for i in range(3)]
    fake_cloud.oci.compartments.extend({"id": cid, "name": cid} for cid in compartments)
    for number in range(3):
        fake_cloud.oci.add_oke(REGION, f"root-{number}", server=SERVER)
    fake_cloud.oci.add_oke(
        OTHER_REGION,
        "child",
        server=SERVER,
        compartment=compartments[-1],
        tags={"env": "prod"},
        pools=[
            {
                "name": f"pool-{number}",
                "nodeConfigDetails": {"size": 2},
                "nodeShape": "VM.Standard.E4.Flex",
                "kubernetesVersion": "v1.32.1",
            }
            for number in range(3)
        ],
    )
    result = await adapter.discover(account)
    assert result.problems == []
    assert {found.name for found in result.clusters} == {
        "root-0",
        "root-1",
        "root-2",
        "child",
    }
    child = next(found for found in result.clusters if found.name == "child")
    assert child.resource_id.startswith("ocid1.cluster.")
    assert child.details == {"region": OTHER_REGION, "compartment_id": compartments[-1]}
    assert child.tags == {"env": "prod"}
    assert child.kubernetes_version
    assert child.node_count == 6
    assert child.node_pools == tuple(
        NodePool(f"pool-{number}", 2, "VM.Standard.E4.Flex", "v1.32.1") for number in range(3)
    )
    for resource in ("compartments", "clusters", "nodePools"):
        pages = [
            request for request in fake_cloud.requests if request.path.endswith(f"/{resource}")
        ]
        assert any("page" in request.query for request in pages)


async def test_discover_keeps_successful_region_when_another_fails(fake_cloud, oci_setup):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "available", server=SERVER)
    fake_cloud.oci.add_oke(OTHER_REGION, "unavailable", server=SERVER)
    fake_cloud.fail[rf"/{OTHER_REGION}/20180222/clusters$"] = (503, "synthetic-upstream-marker")
    result = await adapter.discover(account)
    assert [found.name for found in result.clusters] == ["available"]
    assert len(result.problems) == 1
    assert result.problems[0].startswith(f"Couldn't list clusters in {OTHER_REGION}: ")
    assert "503" in result.problems[0]
    assert "synthetic-upstream-marker" not in result.problems[0]


async def test_invalid_compartment_row_keeps_later_rows_on_same_page(fake_cloud, oci_setup):
    adapter, account = oci_setup
    compartment = "ocid1.compartment.oc1..child"
    fake_cloud.oci.compartments.extend([{"id": "synthetic-upstream-marker"}, {"id": compartment}])
    fake_cloud.oci.add_oke(REGION, "available", server=SERVER, compartment=compartment)
    result = await adapter.discover(account)
    assert [found.name for found in result.clusters] == ["available"]
    assert result.problems
    assert all("synthetic-upstream-marker" not in problem for problem in result.problems)


async def test_private_endpoint_not_addable(fake_cloud, oci_setup):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "private", server=SERVER, public=False)
    result = await adapter.discover(account)
    (found,) = result.clusters
    assert found.private
    assert not found.addable
    assert found.why_not == (
        "Private API endpoint: the console can't reach it directly. "
        "Private clusters arrive with the in-cluster agent."
    )


async def test_access_reads_server_and_ca(fake_cloud, oci_setup):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "public", server=SERVER)
    (found,) = (await adapter.discover(account)).clusters
    access = await adapter.access(account, found)
    assert access.server == SERVER
    assert access.ca_data == fake_cloud.oci.ca_data
    request = fake_cloud.requests[-1]
    assert request.path.endswith(f"/clusters/{found.resource_id}/kubeconfig/content")
    assert request.method == "POST"
    assert json.loads(request.body) == {
        "tokenVersion": "2.0.0",
        "endpoint": "PUBLIC_ENDPOINT",
    }


async def test_access_handles_invalid_yaml_scalar_without_echoing_it(
    fake_cloud, oci_setup, monkeypatch
):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "public", server=SERVER)
    (found,) = (await adapter.discover(account)).clusters

    def invalid_kubeconfig(*args):
        return web.Response(text="!!int synthetic-upstream-marker")

    monkeypatch.setattr(fake_cloud.oci, "response", invalid_kubeconfig)
    with pytest.raises(CloudError) as error:
        await adapter.access(account, found)
    assert str(error.value) == (
        "Oracle Cloud sent an unreadable kubeconfig. Check the cluster, then try again."
    )


@pytest.mark.parametrize("operation", ["verify", "access"])
async def test_signed_request_preserves_encoded_path(fake_cloud, oci_setup, monkeypatch, operation):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "public", server=SERVER)
    (found,) = (await adapter.discover(account)).clusters
    endpoints = fake_cloud.endpoints()
    monkeypatch.setattr(
        adapter,
        "_endpoints",
        replace(
            endpoints,
            oci_identity=endpoints.oci_identity.replace("/oci/", "/oc%69/"),
            oci_containerengine=endpoints.oci_containerengine.replace("/oci/", "/oc%69/"),
        ),
    )
    if operation == "verify":
        assert (await adapter.verify(account)).scope == TENANCY
    else:
        assert (await adapter.access(account, found)).server == SERVER


async def test_bad_signature_plain_refused(oci_setup):
    adapter, account = oci_setup
    wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    account.secret["private_key"] = pem(wrong_key).decode()
    with pytest.raises(CloudError) as error:
        await adapter.verify(account)
    assert str(error.value).startswith("Oracle Cloud refused access while trying to ")
    assert str(error.value).endswith("Check the login's permissions, then try again.")
    assert "PRIVATE KEY" not in str(error.value)


async def test_oke_token_accepted_by_fake_kube_check(fake_cloud, oci_setup, key):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "public", server=SERVER)
    (found,) = (await adapter.discover(account)).clusters
    ref = CloudClusterRef(account.id, "oci", found.resource_id, found.name, REGION, found.details)
    token = await adapter.token_fetch(account, ref)()
    accepts = fake_cloud.kube_token_ok("oci")
    assert accepts(f"Bearer {token.value}")
    assert not accepts("Bearer malformed-oke-token")
    expired = oke_token(
        OciSigner(KEY_ID, key),
        found.resource_id,
        REGION,
        fake_cloud.endpoints(),
        now=datetime.now(UTC) - timedelta(minutes=5),
    )
    assert not accepts(f"Bearer {expired.value}")


async def test_oci_calls_are_read_only(fake_cloud, oci_setup):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "public", server=SERVER)
    await adapter.verify(account)
    (found,) = (await adapter.discover(account)).clusters
    await adapter.access(account, found)
    assert fake_cloud.requests
    for request in fake_cloud.requests:
        if request.method == "GET":
            assert re.search(r"/(?:tenancies/[^/]+|compartments|clusters|nodePools)$", request.path)
        else:
            assert request.method == "POST"
            assert re.search(r"/clusters/[^/]+/kubeconfig/content$", request.path)
    assert fake_cloud.read_only_violations() == []


async def test_unreadable_node_pools_are_unknown_not_empty(fake_cloud, oci_setup):
    adapter, account = oci_setup
    fake_cloud.oci.add_oke(REGION, "pools-hidden", server=SERVER, pools=[{"name": "p"}])
    fake_cloud.fail[r"/nodePools$"] = (404, "synthetic-upstream-marker")
    result = await adapter.discover(account)
    (found,) = result.clusters
    assert found.node_pools is None and found.node_count is None
    assert result.problems and "synthetic-upstream-marker" not in " ".join(result.problems)
