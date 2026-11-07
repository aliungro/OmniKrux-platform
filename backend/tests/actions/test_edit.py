"""Editing an object's YAML through the action pipeline, against fake Kubernetes APIs: the plan
diffs the API server's dry run, and the apply is a PUT carrying the resourceVersion the user
opened, so a change since then answers with the conflict copy."""

from dataclasses import replace

import yaml

from tests.actions.clusters import apply, deployment, plan, records

CONFLICT = "Deployment web changed since you reviewed this change. Review it again."
IDENTITY = (
    "An edit can't change the kind, name or namespace. Create a new object with kubectl instead."
)
NOTHING = "Nothing changes: the edited YAML matches the cluster."
SECRET = (
    "Secrets can't be edited in Omnikrux: their values never reach the browser. "
    "Use kubectl to change them."
)
PATH = "/apis/apps/v1/namespaces/demo/deployments/web"


async def opened(env, cluster: str = "dev-a") -> dict:
    """The deployment as the YAML tab shows it."""
    url = f"/api/clusters/{env.ids[cluster]}/resources/deployments.apps/web/yaml"
    r = await env.client.get(url, params={"namespace": "demo"})
    assert r.status_code == 200, r.text
    return yaml.safe_load(r.json()["yaml"])


def edited(obj: dict, **spec) -> str:
    obj = obj | {"spec": obj["spec"] | spec}
    return yaml.safe_dump(obj, sort_keys=False)


async def plan_edit(env, text: str, **kwargs):
    return await plan(env, "edit", params={"yaml": text}, **kwargs)


def puts(env, cluster: str = "dev-a") -> list[dict]:
    return [w for w in env.fakes[cluster].writes if w["method"] == "PUT"]


def live(env) -> dict:
    return env.fakes["dev-a"].objects["deployments.apps"][("demo", "web")]


async def test_edit_plan_diffs_dry_run_result(env):
    obj = await opened(env)

    r = await plan_edit(env, edited(obj, replicas=4))

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Edit Deployment web"
    assert body["summary"] == ["Save the edited YAML of Deployment demo/web."]
    assert body["apply_label"] == "Save" and body["blocked"] == []
    assert "replicas: 2" in body["diff"]["before"] and "replicas: 4" in body["diff"]["after"]
    assert "resourceVersion" not in body["diff"]["after"]  # server fields aren't reviewed
    [dry_run] = puts(env)
    assert dry_run["path"] == PATH and dry_run["query"] == {"dryRun": "All"}
    assert dry_run["body"]["spec"]["replicas"] == 4
    assert live(env)["spec"]["replicas"] == 2  # a dry run changes nothing


async def test_edit_refuses_name_namespace_kind_change(env):
    obj = await opened(env)
    md = obj["metadata"]
    for changed in (
        obj | {"metadata": md | {"name": "web-2"}},
        obj | {"metadata": md | {"namespace": "other"}},
        obj | {"metadata": {k: v for k, v in md.items() if k != "namespace"}},
        obj | {"kind": "StatefulSet"},
    ):
        r = await plan_edit(env, yaml.safe_dump(changed))
        assert r.status_code == 422, changed
        assert r.json() == {"detail": IDENTITY}
    assert puts(env) == []


async def test_edit_needs_the_update_verb(env):
    fake = env.fakes["dev-a"]
    fake.resources = [
        replace(r, verbs=("get", "list", "watch")) if r.plural == "deployments" else r
        for r in fake.resources
    ]

    r = await plan_edit(env, yaml.safe_dump(deployment(replicas=4)))

    assert r.status_code == 422
    assert r.json() == {
        "detail": "Deployment objects can't be edited on this cluster: it doesn't allow updates."
    }
    assert fake.writes == []


async def test_edit_conflict_when_changed_since_opened(env):
    obj = await opened(env)
    live(env)["metadata"]["resourceVersion"] = "8"  # changed after the YAML was opened

    r = await plan_edit(env, edited(obj, replicas=4))

    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert puts(env) == []

    # Changed after the review: the PUT carries the reviewed resourceVersion and is refused.
    obj = await opened(env)
    plan_id = (await plan_edit(env, edited(obj, replicas=4))).json()["plan_id"]
    live(env)["metadata"]["resourceVersion"] = "9"
    r = await apply(env, plan_id)
    assert r.status_code == 409 and r.json() == {"detail": CONFLICT}
    assert live(env)["spec"]["replicas"] == 2
    [record] = await records(env)
    assert (record.outcome, record.message) == ("failed", CONFLICT)

    # No resourceVersion at all: never an unconditional replace.
    without = obj | {
        "metadata": {k: v for k, v in obj["metadata"].items() if k != "resourceVersion"}
    }
    r = await plan_edit(env, edited(without, replicas=4))
    assert r.status_code == 422
    assert "resourceVersion" in r.json()["detail"]


async def test_edit_nothing_changes(env):
    obj = await opened(env)

    r = await plan_edit(env, yaml.safe_dump(obj))

    assert r.status_code == 200
    assert r.json()["blocked"] == [NOTHING]
    r = await apply(env, r.json()["plan_id"])
    assert r.status_code == 422 and r.json() == {"detail": NOTHING}
    assert [w["query"] for w in puts(env)] == [{"dryRun": "All"}]
    assert await records(env) == []


async def test_edit_secret_refused(env):
    secret = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": "db", "namespace": "demo", "uid": "u-db", "resourceVersion": "3"},
        "data": {"password": "aHVudGVyMg=="},
    }
    env.fakes["dev-a"].objects["secrets"][("demo", "db")] = secret

    r = await plan_edit(env, yaml.safe_dump(secret), kind_key="secrets", name="db")

    assert r.status_code == 422 and r.json() == {"detail": SECRET}
    assert env.fakes["dev-a"].writes == []
    assert "aHVudGVyMg==" not in r.text


async def test_edit_invalid_yaml_plain(env):
    for text, words in (
        ("metadata: [unclosed\n", "The edited YAML can't be read"),
        ("a: 1\n---\nb: 2\n", "The edited YAML must hold one object"),
        ("- one\n- two\n", "The edited YAML must hold one object"),
        ("", "The edited YAML must hold one object"),
    ):
        r = await plan_edit(env, text)
        assert r.status_code == 422, text
        detail = r.json()["detail"]
        assert detail.startswith(words), detail
        assert "Traceback" not in detail and "yaml." not in detail
    r = await plan_edit(env, "kind: Deployment\nmetadata: name: web\n")
    assert r.json()["detail"] == (
        "The edited YAML can't be read: mapping values are not allowed here (line 2, column 15). "
        "Fix it and review again."
    )

    for params in ({}, {"yaml": 3}):
        r = await plan(env, "edit", params=params)
        assert r.status_code == 422 and r.json() == {"detail": "Send the edited YAML as text."}
    assert env.fakes["dev-a"].writes == []


async def test_edit_apply_puts_with_resource_version_and_audits_diff(env):
    env.fakes["dev-b"].objects["deployments.apps"][("demo", "web")] = deployment(uid="u-b")
    obj = await opened(env)
    r = await plan_edit(env, edited(obj, replicas=4))
    plan_id = r.json()["plan_id"]

    r = await apply(env, plan_id)

    assert r.status_code == 200, r.text
    assert r.json()["message"] == "Saved Deployment demo/web."
    _, saved = puts(env)
    assert saved["path"] == PATH and saved["query"] == {}
    assert saved["body"]["metadata"]["resourceVersion"] == "7"
    assert saved["body"]["spec"]["replicas"] == 4
    assert live(env)["spec"]["replicas"] == 4
    assert live(env)["metadata"]["resourceVersion"] == "8"
    assert env.fakes["dev-b"].writes == []  # only the planned cluster
    [record] = await records(env)
    assert (record.action, record.outcome) == ("edit", "succeeded")
    assert "-  replicas: 2\n+  replicas: 4\n" in record.diff
