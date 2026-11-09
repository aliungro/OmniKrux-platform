"""Secret values never leave the server, except one key at a time in the reveal response.

Masking lives in the one YAML helper, so every YAML and diff of a Secret is masked whoever
asks for it; reveal is a POST for one key, answered with `no-store` and audited by key name."""

import base64
import logging

import httpx
import pytest
import yaml
from sqlalchemy import text

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.resources import kind_rows as kr
from omnikrux.resources.yaml_out import (
    LAST_APPLIED,
    MASK,
    diff_text,
    dump_yaml,
    mask_secret,
    to_yaml,
)
from tests.fakekube import kubeconfig_for
from tests.resources.test_describe_any import SECRET_B64, SECRET_VALUE, secret

BINARY = b"\xff\xfe\x00binary"
BINARY_B64 = base64.b64encode(BINARY).decode()


def leaks(body: str) -> list[str]:
    return [v for v in (SECRET_VALUE, SECRET_B64, BINARY_B64) if v in body]


def stored_secret() -> dict:
    out = secret()
    del out["stringData"]  # write-only: the API server never returns it
    out["metadata"]["resourceVersion"] = "12"
    out["metadata"]["managedFields"] = [{"manager": "kubectl", "fieldsV1": {"f:data": {}}}]
    out["data"]["cert"] = BINARY_B64
    return out


# --- masking -------------------------------------------------------------------------------


def test_mask_secret_masks_every_value_and_drops_last_applied():
    original = secret()
    masked = mask_secret(original)

    assert masked["data"] == {"password": "•••••• (13 bytes)", "blob": "•••••• (2 bytes)"}
    assert masked["stringData"] == {"extra": "•••••• (13 bytes)"}
    assert masked["metadata"]["annotations"] == {"team": "data"}
    assert MASK.format(n=3) == "•••••• (3 bytes)"
    assert LAST_APPLIED == "kubectl.kubernetes.io/last-applied-configuration"
    assert original["data"]["password"] == SECRET_B64  # a copy: the input is untouched

    only = secret()
    only["metadata"]["annotations"] = {LAST_APPLIED: "{}"}
    assert "annotations" not in mask_secret(only)["metadata"]
    broken = secret() | {"data": {"odd": "not base64!", "none": None}}
    assert mask_secret(broken)["data"] == {"odd": MASK.format(n=11), "none": MASK.format(n=0)}


def test_every_yaml_of_a_secret_is_masked():
    """The choke point: dump_yaml and to_yaml mask any v1 Secret, with or without the hint,
    so diffs built from them never carry a value either."""
    for out in (
        dump_yaml(secret()),
        to_yaml(secret()),
        dump_yaml(
            {k: v for k, v in secret().items() if k not in ("kind", "apiVersion")}, secret=True
        ),
        diff_text(to_yaml(secret()), to_yaml(secret() | {"data": {"password": "aGk="}})),
    ):
        assert leaks(out) == [] and "last-applied" not in out
    assert "password: •••••• (13 bytes)" in dump_yaml(secret())
    # Not a Secret: values are the object's own.
    config = {"apiVersion": "v1", "kind": "ConfigMap", "data": {"mode": SECRET_VALUE}}
    assert SECRET_VALUE in dump_yaml(config)


# --- over HTTP -----------------------------------------------------------------------------


@pytest.fixture
async def env(fake_api, tmp_path):
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        fake_api.objects["secrets"][("demo", "db")] = stored_secret()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            yield app, http, info.id


def reveal_url(cluster_id: str, name: str = "db") -> str:
    return f"/api/clusters/{cluster_id}/secrets/demo/{name}/reveal"


async def audit_rows(app) -> list[tuple]:
    async with app.state.engine.connect() as conn:
        return [tuple(row) for row in (await conn.execute(text("SELECT * FROM audit"))).all()]


async def test_secret_yaml_masks_data_and_last_applied(env):
    _, http, cluster_id = env
    for kind_key in ("secrets", "helm-releases"):
        r = await http.get(
            f"/api/clusters/{cluster_id}/resources/{kind_key}/db/yaml", params={"namespace": "demo"}
        )
        assert r.status_code == 200
        assert leaks(r.text) == []
        assert "last-applied-configuration" not in r.text and "managedFields" not in r.text
        doc = yaml.safe_load(r.json()["yaml"])
        assert doc["data"] == {
            "password": "•••••• (13 bytes)",
            "blob": "•••••• (2 bytes)",
            "cert": f"•••••• ({len(BINARY)} bytes)",
        }
        assert doc["metadata"]["annotations"] == {"team": "data"}
        assert doc["metadata"]["resourceVersion"] == "12"


async def test_secret_describe_route_lists_keys_only(env):
    _, http, cluster_id = env
    for kind_key in ("secrets", "helm-releases"):
        r = await http.get(
            f"/api/clusters/{cluster_id}/resources/{kind_key}/db/describe",
            params={"namespace": "demo"},
        )
        assert r.status_code == 200
        assert leaks(r.text) == [] and "last-applied" not in r.text
        assert [k["key"] for k in r.json()["secret_keys"]] == ["blob", "cert", "password"]


async def test_reveal_returns_one_key_no_store(env):
    _, http, cluster_id = env
    r = await http.post(reveal_url(cluster_id), json={"key": "password"})

    assert r.status_code == 200
    assert r.json() == {"key": "password", "value": SECRET_VALUE, "encoding": "utf-8"}
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["pragma"] == "no-cache"

    r = await http.post(reveal_url(cluster_id), json={"key": "cert"})
    assert r.json() == {"key": "cert", "value": BINARY_B64, "encoding": "base64"}
    assert SECRET_VALUE not in r.text  # one key only

    r = await http.get(reveal_url(cluster_id), params={"key": "password"})
    assert r.status_code == 405  # never a GET: a URL can be cached and logged
    r = await http.post(reveal_url(cluster_id), json={"key": "password", "all": True})
    assert r.status_code == 422


async def test_reveal_is_audited_without_value(env, caplog):
    app, http, cluster_id = env
    caplog.set_level(logging.DEBUG)
    r = await http.post(reveal_url(cluster_id), json={"key": "password"})
    assert r.status_code == 200

    [record] = (await app.state.audit.list()).records
    assert (record.action, record.outcome) == ("secret_reveal", "succeeded")
    assert (record.cluster_id, record.namespace, record.kind, record.name) == (
        cluster_id,
        "demo",
        "secrets",
        "db",
    )
    assert record.details == {"key": "password"} and record.diff is None
    for row in await audit_rows(app):
        assert leaks(" ".join(str(column) for column in row)) == []
    assert leaks(caplog.text) == []


async def test_reveal_unknown_key_404_plain(env):
    app, http, cluster_id = env
    r = await http.post(reveal_url(cluster_id), json={"key": "nope"})
    assert r.status_code == 404
    assert r.json() == {"detail": "Secret db has no key nope."}
    [record] = (await app.state.audit.list()).records
    assert (record.outcome, record.message) == ("failed", "Secret db has no key nope.")

    r = await http.post(reveal_url(cluster_id, "ghost"), json={"key": "password"})
    assert r.status_code == 404
    assert "ghost" in r.json()["detail"] and "{" not in r.json()["detail"]

    r = await http.post(reveal_url("nope"), json={"key": "password"})
    assert r.status_code == 404 and r.json() == {"detail": "Unknown cluster"}


async def test_reveal_needs_the_audit_and_permission(env, fake_api, monkeypatch):
    app, http, cluster_id = env
    calls = []

    async def refusing(*args):
        calls.append(args)
        raise NotAllowed("Not for you.")

    allowing = authz.authorize
    monkeypatch.setattr(authz, "authorize", refusing)
    r = await http.post(reveal_url(cluster_id), json={"key": "password"})
    assert r.status_code == 403 and r.json() == {"detail": "Not for you."}
    assert calls == [("local", "secret_reveal", cluster_id, "demo", "secrets", "db")]
    monkeypatch.setattr(authz, "authorize", allowing)

    async with app.state.engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))
    fake_api.requests.clear()
    r = await http.post(reveal_url(cluster_id), json={"key": "password"})
    assert r.status_code == 503
    assert r.json() == {
        "detail": "The value isn't shown: the audit log can't be written (no such table: audit)."
    }
    assert not [p for _, p, _ in fake_api.requests if "/secrets/" in p]  # never read


async def test_reveal_without_audit_says_value_not_shown(env, fake_api, caplog):
    app, http, cluster_id = env
    async with app.state.engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))
    fake_api.requests.clear()

    response = await http.post(reveal_url(cluster_id), json={"key": "password"})

    assert response.status_code == 503
    assert response.json() == {
        "detail": "The value isn't shown: the audit log can't be written (no such table: audit)."
    }
    assert not [path for _, path, _ in fake_api.requests if "/secrets/" in path]
    assert leaks(response.text) == [] and leaks(caplog.text) == []


async def test_reveal_withholds_the_value_when_the_audit_cannot_finish(env, caplog):
    app, http, cluster_id = env
    audit = app.state.audit
    finish = audit.finish

    async def table_gone_before_success(record_id, outcome, message=None):
        if outcome == "succeeded":
            async with app.state.engine.begin() as conn:
                await conn.execute(text("DROP TABLE audit"))
        return await finish(record_id, outcome, message)

    audit.finish = table_gone_before_success
    try:
        r = await http.post(reveal_url(cluster_id), json={"key": "password"})
    finally:
        audit.finish = finish
    assert r.status_code == 503
    assert r.json() == {
        "detail": "The value isn't shown: the audit log couldn't record the reveal. Try again."
    }
    assert leaks(r.text) == [] and leaks(caplog.text) == []


async def test_names_that_are_not_path_safe_are_refused(env, fake_api):
    app, http, cluster_id = env
    fake_api.requests.clear()
    # "db%3Fx" arrives as "db?x": joined into a path unencoded, the cluster would read "db".
    r = await http.post(f"/api/clusters/{cluster_id}/secrets/demo/db%3Fx/reveal", json={"key": "a"})
    assert r.status_code == 422
    assert r.json() == {
        "detail": "db?x isn't a valid object name: names use letters, digits, '-', '.' and ':'."
    }
    r = await http.post(f"/api/clusters/{cluster_id}/secrets/de%20mo/db/reveal", json={"key": "a"})
    assert r.status_code == 422
    assert r.json() == {
        "detail": "de mo isn't a valid namespace: namespaces use lower-case letters, digits "
        "and '-'."
    }
    for what in ("describe", "yaml"):
        for name in ("db%3Fx", "db%23x", "db%20x"):
            url = f"/api/clusters/{cluster_id}/resources/secrets/{name}/{what}"
            r = await http.get(url, params={"namespace": "demo"})
            assert r.status_code == 422, (what, name)
    assert (await app.state.audit.list()).records == []
    assert not [p for _, p, _ in fake_api.requests if "/secrets" in p]


async def test_helm_release_describe_and_yaml_need_the_helm_label(env, fake_api):
    _, http, cluster_id = env
    plain = stored_secret()
    plain["metadata"]["name"] = "plain"
    del plain["metadata"]["labels"]
    fake_api.objects["secrets"][("demo", "plain")] = plain
    for what in ("describe", "yaml"):
        url = f"/api/clusters/{cluster_id}/resources/helm-releases/plain/{what}"
        r = await http.get(url, params={"namespace": "demo"})
        assert r.status_code == 404, what
        assert r.json() == {
            "detail": "Helm release demo/plain not found: that object doesn't have the label "
            "owner=helm."
        }
        r = await http.get(
            f"/api/clusters/{cluster_id}/resources/secrets/plain/{what}",
            params={"namespace": "demo"},
        )
        assert r.status_code == 200 and leaks(r.text) == []


async def test_helm_release_row_identity_opens_its_describe_and_yaml(env, fake_api):
    """The row the table shows is the one the inspector asks for: its name is the Secret's."""
    _, http, cluster_id = env
    release = stored_secret()
    release["type"] = "helm.sh/release.v1"
    release["data"] = {"release": "H4sIAAAAAAAA-RELEASE-PAYLOAD"}
    release["metadata"].update(
        name="sh.helm.release.v1.web.v3",
        labels={"owner": "helm", "name": "web", "version": "3", "status": "deployed"},
    )
    fake_api.objects["secrets"][("demo", "sh.helm.release.v1.web.v3")] = release
    row = kr.helm_release_row(release, cluster_id)
    assert row.columns["release"] == "web"
    for what in ("describe", "yaml"):
        r = await http.get(
            f"/api/clusters/{cluster_id}/resources/helm-releases/{row.name}/{what}",
            params={"namespace": row.namespace},
        )
        assert r.status_code == 200, (what, r.text)
        assert "RELEASE-PAYLOAD" not in r.text
    r = await http.get(
        f"/api/clusters/{cluster_id}/resources/helm-releases/{row.name}/describe",
        params={"namespace": row.namespace},
    )
    assert (r.json()["kind"], r.json()["name"]) == ("HelmRelease", "sh.helm.release.v1.web.v3")
