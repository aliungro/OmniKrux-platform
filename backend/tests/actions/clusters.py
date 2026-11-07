"""Clusters for action tests: three fake Kubernetes APIs registered in a real app (dev-a and dev-b
in development, prod-east in production), each serving deployment demo/web and namespace demo,
and helpers to plan and apply over HTTP."""

from contextlib import AsyncExitStack
from dataclasses import dataclass

import httpx
import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from tests.fakekube import FakeKubeApi, kubeconfig_for, serve_fake_api


def deployment(name: str = "web", replicas: int = 2, uid: str = "u-web") -> dict:
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": "demo",
            "uid": uid,
            "resourceVersion": "7",
            "generation": 3,
            "creationTimestamp": "2026-11-01T10:00:00Z",
            "managedFields": [{"manager": "kubectl"}],
            "labels": {"app": name},
        },
        "spec": {"replicas": replicas},
        "status": {"replicas": replicas, "readyReplicas": replicas},
    }


def kubeconfig_named(fake: FakeKubeApi, context: str) -> str:
    config = kubeconfig_for(fake)
    config["contexts"][0]["name"] = context
    config["current-context"] = context
    return yaml.safe_dump(config)


@dataclass
class Env:
    app: object
    client: httpx.AsyncClient
    ids: dict[str, str]  # context name -> cluster id
    fakes: dict[str, FakeKubeApi]  # context name -> its API


@pytest.fixture
async def env(tmp_path):
    """Three clusters, each with its own fake API serving deployment demo/web and namespace
    demo: dev-a and dev-b (development) and prod-east (production)."""
    names = ("dev-a", "dev-b", "prod-east")
    async with AsyncExitStack() as stack:
        fakes = {name: await stack.enter_async_context(serve_fake_api()) for name in names}
        for fake in fakes.values():
            fake.objects["deployments.apps"][("demo", "web")] = deployment()
            fake.objects["namespaces"][("", "demo")] = {"metadata": {"name": "demo", "uid": "u-ns"}}
        app = create_app(
            Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
        )
        await stack.enter_async_context(app.router.lifespan_context(app))
        ids = {}
        for name, fake in fakes.items():
            [info] = await app.state.registry.upsert_from_kubeconfig(
                kubeconfig_named(fake, name), rewrite_loopback=False, source=SOURCE_UPLOAD
            )
            ids[name] = info.id
        transport = httpx.ASGITransport(app=app)
        client = await stack.enter_async_context(
            httpx.AsyncClient(transport=transport, base_url="http://testserver")
        )
        yield Env(app, client, ids, fakes)


def target(env: Env, cluster: str = "dev-a", **overrides) -> dict:
    values = {
        "cluster_id": env.ids[cluster],
        "kind_key": "deployments.apps",
        "namespace": "demo",
        "name": "web",
    }
    return values | overrides


async def plan(env: Env, action: str = "scale", cluster: str = "dev-a", params=None, **target_):
    body = {"action": action, "target": target(env, cluster, **target_)}
    if params is not None:
        body["params"] = params
    return await env.client.post("/api/actions/plan", json=body)


async def apply(env: Env, plan_id: str, body: dict | None = None):
    return await env.client.post(f"/api/actions/{plan_id}/apply", json=body or {})


async def records(env: Env) -> list:
    return (await env.app.state.audit.list()).records
