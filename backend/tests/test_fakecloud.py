from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import serialization

from omnikrux.cloud.oci import OciSigner
from tests.cloud.test_azure import (
    ARM_SCOPE,
    CLIENT_ID,
    CLIENT_SECRET,
    SUBSCRIPTION,
    TENANT,
)
from tests.cloud.test_oci import KEY_ID, REGION, TENANCY, VECTOR_KEY_PEM


async def test_fakecloud_azure_rejects_wrong_secret_and_unknown_token(fake_cloud):
    fake_cloud.azure.subscriptions[SUBSCRIPTION] = {"name": "Test subscription", "tenant": TENANT}
    fake_cloud.azure.service_principals[(TENANT, CLIENT_ID)] = CLIENT_SECRET
    async with httpx.AsyncClient(base_url=fake_cloud.url, trust_env=False) as client:
        bad_secret = await client.post(
            f"/{TENANT}/oauth2/v2.0/token",
            data={
                "grant_type": "client_credentials",
                "client_id": CLIENT_ID,
                "client_secret": "wrong secret",
                "scope": ARM_SCOPE,
            },
        )
        unknown_token = await client.get(
            f"/subscriptions/{SUBSCRIPTION}",
            headers={"Authorization": "Bearer not-issued"},
        )
    assert bad_secret.status_code in (400, 401)
    assert bad_secret.json()["error"] == "invalid_client"
    assert unknown_token.status_code == 401
    assert fake_cloud.read_only_violations() == []


async def test_fakecloud_flags_unlisted_calls(fake_cloud):
    async with httpx.AsyncClient(base_url=fake_cloud.url, trust_env=False) as client:
        await client.delete(f"/subscriptions/{SUBSCRIPTION}")
        await client.post(f"/subscriptions/{SUBSCRIPTION}/unknown")
    assert fake_cloud.read_only_violations() == [
        f"DELETE /subscriptions/{SUBSCRIPTION}",
        f"POST /subscriptions/{SUBSCRIPTION}/unknown",
    ]


async def test_fakecloud_aws_rejects_unsigned_and_unlisted_sts_calls(fake_cloud):
    async with httpx.AsyncClient(base_url=fake_cloud.url, trust_env=False) as client:
        unsigned = await client.post("/", data={"Action": "GetCallerIdentity"})
        unlisted = await client.post("/", data={"Action": "GetSessionToken"})
    assert unsigned.status_code == 403
    assert "<Code>SignatureDoesNotMatch</Code>" in unsigned.text
    assert unlisted.status_code == 403
    assert fake_cloud.read_only_violations() == ["POST /"]


GCP_PROJECT = "fake-gke-project"
GCP_LIST_PATH = f"/v1/projects/{GCP_PROJECT}/locations/-/clusters"


async def test_fakecloud_gcp_rejects_unknown_refresh_and_access_token(fake_cloud):
    fake_cloud.gcp.projects[GCP_PROJECT] = []
    token_path = urlsplit(fake_cloud.endpoints().gcp_oauth).path
    async with httpx.AsyncClient(base_url=fake_cloud.url, trust_env=False) as client:
        rejected_grant = await client.post(
            token_path,
            data={"grant_type": "refresh_token", "refresh_token": "unregistered-refresh"},
        )
        rejected_read = await client.get(
            GCP_LIST_PATH, headers={"Authorization": "Bearer unissued"}
        )

    assert rejected_grant.status_code in (400, 401)
    assert rejected_grant.json()["error"] == "invalid_grant"
    assert rejected_read.status_code == 401
    assert fake_cloud.read_only_violations() == []


async def test_fakecloud_oci_checks_signature_body_and_real_page_shape(fake_cloud):
    private_key = serialization.load_pem_private_key(VECTOR_KEY_PEM, password=None)
    signer = OciSigner(KEY_ID, private_key)
    fake_cloud.oci.keys[KEY_ID] = private_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    fake_cloud.oci.tenancy.update(id=TENANCY, name="Local test tenancy")
    fake_cloud.oci.compartments.extend(
        {"id": f"ocid1.compartment.oc1..test{number}", "name": f"test{number}"}
        for number in range(3)
    )
    endpoints = fake_cloud.endpoints()
    identity = endpoints.url("oci_identity", REGION)
    engine = endpoints.url("oci_containerengine", REGION)
    compartments = (
        f"{identity}/20160918/compartments?compartmentId={TENANCY}"
        "&compartmentIdInSubtree=true&accessLevel=ACCESSIBLE&lifecycleState=ACTIVE"
    )
    cluster_id = "ocid1.cluster.oc1.eu-frankfurt-1.ccc"
    access = f"{engine}/20180222/clusters/{cluster_id}/kubeconfig/content"
    body = b'{"tokenVersion":"2.0.0","endpoint":"PUBLIC_ENDPOINT"}'
    headers = signer.sign("POST", access, {"content-type": "application/json"}, body)
    async with httpx.AsyncClient(trust_env=False) as client:
        unsigned = await client.get(compartments)
        page = await client.get(compartments, headers=signer.sign("GET", compartments, {}))
        tampered = await client.post(
            access, headers=headers, content=body.replace(b"PUBLIC", b"SNEAKY")
        )
    assert unsigned.status_code == tampered.status_code == 401
    assert unsigned.json()["code"] == tampered.json()["code"] == "NotAuthenticated"
    assert page.status_code == 200
    assert isinstance(page.json(), list)
    assert len(page.json()) == 2
    assert page.headers["opc-next-page"]
    assert fake_cloud.read_only_violations() == []
