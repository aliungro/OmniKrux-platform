import httpx

from tests.cloud.test_azure import (
    ARM_SCOPE,
    CLIENT_ID,
    CLIENT_SECRET,
    SUBSCRIPTION,
    TENANT,
)


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
