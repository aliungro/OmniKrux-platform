import pytest
import yaml

from omnikrux.clusters.kubeconfig import (
    detect_provider,
    guess_environment,
    parse_kubeconfig,
    read_kubeconfig_files,
    rewrite_loopback,
)
from omnikrux.clusters.models import Environment, Provider


def kc(contexts):  # contexts: list of (name, server, exec_cmd|None)
    return yaml.safe_dump({
        "apiVersion": "v1", "kind": "Config", "current-context": contexts[0][0],
        "clusters": [{"name": n, "cluster": {"server": s, "certificate-authority-data": "Q0E="}} for n, s, _ in contexts],
        "users": [{"name": n, "user": ({"exec": {"command": e, "apiVersion": "client.authentication.k8s.io/v1beta1"}} if e else {"token": "t"})} for n, _, e in contexts],
        "contexts": [{"name": n, "context": {"cluster": n, "user": n}} for n, _, _ in contexts],
    })


@pytest.mark.parametrize("ctx,server,exe,expected", [
    ("prod", "https://prod-abc.hcp.westeurope.azmk8s.io:443", None, Provider.AKS),
    ("x", "https://10.0.0.1", "kubelogin", Provider.AKS),
    ("x", "https://ABC.gr7.us-east-1.eks.amazonaws.com", None, Provider.EKS),
    ("x", "https://1.2.3.4", "/usr/local/bin/aws", Provider.EKS),
    ("gke_proj_europe-west4_dev", "https://34.1.2.3", None, Provider.GKE),
    ("x", "https://1.2.3.4", "oci", Provider.OKE),
    ("kind-omnikrux-dev", "https://127.0.0.1:6443", None, Provider.KIND),
    ("lab", "https://k8s.lab.internal:6443", None, Provider.ONPREM),
])
def test_detect_provider(ctx, server, exe, expected):
    assert detect_provider(ctx, server, exe) is expected


@pytest.mark.parametrize("name,provider,expected", [
    ("aks-prod-weu", Provider.AKS, Environment.PRODUCTION),
    ("gke-dev-euw4", Provider.GKE, Environment.DEVELOPMENT),
    ("whatever", Provider.KIND, Environment.DEVELOPMENT),
    ("lab", Provider.ONPREM, Environment.UNKNOWN),
])
def test_guess_environment(name, provider, expected):
    assert guess_environment(name, provider) is expected


def test_one_parsed_context_per_context_with_standalone_config():
    out = parse_kubeconfig(kc([("a", "https://a:6443", None), ("b", "https://b:6443", "kubelogin")]), in_container=False)
    assert [p.context_name for p in out] == ["a", "b"]
    sa = out[1].standalone
    assert sa["current-context"] == "b" and len(sa["clusters"]) == len(sa["users"]) == len(sa["contexts"]) == 1
    assert sa["clusters"][0]["cluster"]["certificate-authority-data"] == "Q0E="
    assert out[1].exec_command == "kubelogin"


def test_loopback_rewritten_in_container():
    p = parse_kubeconfig(kc([("kind-dev", "https://127.0.0.1:6443", None)]), in_container=True)[0]
    cluster = p.standalone["clusters"][0]["cluster"]
    assert p.server == "https://host.docker.internal:6443"
    assert cluster["server"] == "https://host.docker.internal:6443"
    assert cluster["tls-server-name"] == "127.0.0.1"


def test_loopback_untouched_outside_container():
    p = parse_kubeconfig(kc([("kind-dev", "https://127.0.0.1:6443", None)]), in_container=False)[0]
    assert p.server == "https://127.0.0.1:6443"


def test_invalid_yaml_raises():
    with pytest.raises(ValueError, match="Not a kubeconfig"):
        parse_kubeconfig("::: not yaml", in_container=False)


def test_missing_contexts_raises():
    with pytest.raises(ValueError, match="Not a kubeconfig"):
        parse_kubeconfig("apiVersion: v1\nkind: Config\n", in_container=False)


def test_non_mapping_raises():
    with pytest.raises(ValueError, match="Not a kubeconfig"):
        parse_kubeconfig("- a\n- b\n", in_container=False)


def test_ipv6_loopback_rewritten():
    out = rewrite_loopback({"server": "https://[::1]:6443"})
    assert out["server"] == "https://host.docker.internal:6443"
    assert out["tls-server-name"] == "::1"


def test_localhost_without_port_and_existing_tls_server_name():
    out = rewrite_loopback({"server": "https://localhost", "tls-server-name": "keep"})
    assert out["server"] == "https://host.docker.internal"
    assert out["tls-server-name"] == "keep"


def test_non_loopback_returned_unchanged():
    cluster = {"server": "https://k8s.example.com:6443"}
    assert rewrite_loopback(cluster) == cluster


def test_rewrite_does_not_mutate_input():
    cluster = {"server": "https://0.0.0.0:6443"}
    rewrite_loopback(cluster)
    assert cluster == {"server": "https://0.0.0.0:6443"}


def test_contexts_with_missing_cluster_or_user_skipped():
    doc = yaml.safe_load(kc([("a", "https://a:6443", None), ("b", "https://b:6443", None), ("c", "https://c:6443", None)]))
    doc["clusters"] = [c for c in doc["clusters"] if c["name"] != "b"]
    doc["users"] = [u for u in doc["users"] if u["name"] != "c"]
    out = parse_kubeconfig(yaml.safe_dump(doc), in_container=False)
    assert [p.context_name for p in out] == ["a"]


def test_standalone_is_independent_deep_copy():
    out = parse_kubeconfig(kc([("a", "https://a:6443", None), ("b", "https://b:6443", None)]), in_container=False)
    out[0].standalone["clusters"][0]["cluster"]["server"] = "changed"
    assert out[1].standalone["clusters"][0]["cluster"]["server"] == "https://b:6443"
    assert out[0].server == "https://a:6443"


def test_read_kubeconfig_files_skips_missing(tmp_path):
    f = tmp_path / "config"
    f.write_text("hello")
    assert read_kubeconfig_files([tmp_path / "nope", f]) == ["hello"]
