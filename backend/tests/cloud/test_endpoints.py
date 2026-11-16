import json

import pytest

from omnikrux.cloud.endpoints import CloudEndpoints


def test_endpoints_defaults_are_real_clouds():
    endpoints = CloudEndpoints()
    assert endpoints.url("azure_login") == "https://login.microsoftonline.com"
    assert endpoints.url("azure_arm") == "https://management.azure.com"
    assert endpoints.url("aws_sts", "eu-west-1") == "https://sts.eu-west-1.amazonaws.com"
    assert endpoints.url("aws_eks", "eu-west-1") == "https://eks.eu-west-1.amazonaws.com"
    assert endpoints.url("aws_sso", "eu-west-1") == "https://portal.sso.eu-west-1.amazonaws.com"
    assert endpoints.url("gcp_oauth") == "https://oauth2.googleapis.com/token"
    assert endpoints.url("gcp_container") == "https://container.googleapis.com"
    assert endpoints.url("oci_identity", "uk-london-1") == (
        "https://identity.uk-london-1.oci.oraclecloud.com"
    )
    assert endpoints.url("oci_containerengine", "uk-london-1") == (
        "https://containerengine.uk-london-1.oci.oraclecloud.com"
    )
    assert endpoints.url("oci_cluster_request", "uk-london-1") == (
        "https://containerengine.uk-london-1.oraclecloud.com"
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8091",
        "https://localhost:8091",
        "http://[::1]:8091",
        "https://host.docker.internal:8091",
    ],
)
def test_endpoint_override_allows_local_hosts(url):
    endpoints = CloudEndpoints.from_json(json.dumps({"azure_arm": url}))
    assert endpoints.url("azure_arm") == url
    assert endpoints.url("azure_login") == "https://login.microsoftonline.com"


def test_endpoint_override_loopback_only():
    with pytest.raises(ValueError) as exc:
        CloudEndpoints.from_json('{"azure_arm":"https://evil.example"}')
    assert str(exc.value) == (
        "OMNIKRUX_CLOUD_ENDPOINTS may only point at this machine "
        "(127.0.0.1, localhost, [::1] or host.docker.internal): it exists for testing "
        "against fake clouds, not https://evil.example."
    )


@pytest.mark.parametrize(
    "text",
    [
        '["http://localhost"]',
        '{"unrecognized":"http://localhost"}',
        '{"azure_arm":null}',
        '{"azure_arm":"file://localhost"}',
        '{"azure_arm":"http://127.0.0.1:bad-port"}',
        '{"azure_arm":"https://localhost.evil.example"}',
        '{"azure_arm":"http://localhost@evil.example"}',
        '{"azure_arm":"http://localhost?"}',
        '{"azure_arm":"http://localhost#"}',
    ],
)
def test_endpoint_override_rejects_invalid_configuration(text):
    with pytest.raises(ValueError, match="OMNIKRUX_CLOUD_ENDPOINTS"):
        CloudEndpoints.from_json(text)
