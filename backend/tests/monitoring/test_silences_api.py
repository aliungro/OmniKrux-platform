"""Silences through the API: OmniKrux's own and a linked Alertmanager's, listed together,
added and ended with an audit record each, checked in plain words, and previewed."""

from datetime import timedelta

import pytest

from omnikrux.monitoring.alerts.evaluate import fingerprint
from omnikrux.monitoring.alerts.store import InstanceRecord
from omnikrux.monitoring.models import now
from tests.monitoring.alert_env import closed_port_url
from tests.monitoring.test_rules_api import add_rule, monitoring_records, rule_body

API = "/api/monitoring"
SILENCES = f"{API}/alerts/silences"
HOUR = timedelta(hours=1)
DAY = timedelta(days=1)
NAMES = 'Add at least one matcher that names something, like alertname="HighErrorRate".'


def silence_body(where: dict | None = None, **over) -> dict:
    body = {
        "where": where or {"kind": "omnikrux"},
        "matchers": 'alertname="API latency high"',
        "ends_at": (now() + HOUR).isoformat(),
        "comment": "Deploying the new API",
    }
    return body | over


async def link_alertmanager(http, project_id: str, url: str, **over) -> dict:
    created = await http.post(
        f"{API}/sources",
        json={"type": "alertmanager", "reach": "url", "url": url, "name": "Main AM"} | over,
    )
    assert created.status_code == 201, created.text
    source = created.json()
    linked = await http.put(
        f"{API}/projects/{project_id}/sources/{source['id']}", json={"filter": ""}
    )
    assert linked.status_code == 200, linked.text
    return source


def refusal(r) -> tuple[int, str, str]:
    detail = r.json()["detail"]
    return r.status_code, detail["code"], detail["message"]


async def test_silences_in_omnikrux_and_alertmanager(
    monitoring_app, linked_project, fake_alertmanager
):
    http, _ = monitoring_app
    am = await link_alertmanager(http, linked_project.project_id, fake_alertmanager.url)
    ours = await http.post(SILENCES, json=silence_body())
    assert ours.status_code == 201, ours.text
    mine = ours.json()
    assert mine["where"] == {"kind": "omnikrux", "source_id": None, "source_name": None}
    assert mine["matchers"] == 'alertname="API latency high"'
    assert (mine["state"], mine["affects"], mine["created_by"]) == ("active", 0, "local")

    theirs = await http.post(
        SILENCES,
        json=silence_body(
            {"kind": "alertmanager", "source_id": am["id"]},
            matchers='team=~"web|api",env!="dev"',
            starts_at=(now() + HOUR).isoformat(),
            ends_at=(now() + 2 * HOUR).isoformat(),
        ),
    )
    assert theirs.status_code == 201, theirs.text
    held = theirs.json()
    assert held["where"] == {
        "kind": "alertmanager",
        "source_id": am["id"],
        "source_name": "Main AM",
    }
    assert (held["state"], held["affects"], held["created_by"]) == ("pending", None, "OmniKrux")
    [posted] = [r for r in fake_alertmanager.requests if r.method == "POST"]
    assert posted.path == "/api/v2/silences"
    sent = posted.json
    assert sent["createdBy"] == "OmniKrux" and sent["comment"] == "Deploying the new API"
    assert sent["matchers"] == [
        {"name": "team", "value": "web|api", "isRegex": True, "isEqual": True},
        {"name": "env", "value": "dev", "isRegex": False, "isEqual": False},
    ]

    listed = (await http.get(SILENCES)).json()
    assert listed["problems"] == []
    # Newest first: the one that starts in an hour, then OmniKrux's.
    assert [(s["where"]["kind"], s["id"]) for s in listed["silences"]] == [
        ("alertmanager", held["id"]),
        ("omnikrux", mine["id"]),
    ]

    gone = await http.delete(f"{SILENCES}/omnikrux/{mine['id']}")
    assert gone.status_code == 204, gone.text
    gone = await http.delete(
        f"{SILENCES}/alertmanager/{held['id']}", params={"source_id": am["id"]}
    )
    assert gone.status_code == 204, gone.text
    assert fake_alertmanager.silences[held["id"]]["status"] == {"state": "expired"}
    states = {s["id"]: s["state"] for s in (await http.get(SILENCES)).json()["silences"]}
    assert states == {mine["id"]: "expired", held["id"]: "expired"}
    again = await http.delete(f"{SILENCES}/omnikrux/nope")
    assert refusal(again) == (404, "not_found", "That silence no longer exists.")

    records = [
        (r["action"], r["kind"], r["outcome"], r["details"])
        for r in await monitoring_records(http)
        if r["action"].startswith("silence_")
    ]
    assert [r[:3] for r in records] == [
        ("silence_add", "silence", "succeeded"),
        ("silence_add", "silence", "succeeded"),
        ("silence_remove", "silence", "succeeded"),
        ("silence_remove", "silence", "succeeded"),
    ]
    assert records[0][3]["where"] == "OmniKrux"
    assert records[0][3]["matchers"] == 'alertname="API latency high"'
    assert records[1][3]["where"] == "Alertmanager · Main AM"
    assert records[1][3]["ends_at"].startswith(held["ends_at"][:19])
    assert records[3][3] == {
        "where": "Alertmanager · Main AM",
        "matchers": 'team=~"web|api",env!="dev"',
    }


async def test_unreachable_alertmanager_is_a_problem_not_a_failure(monitoring_app, linked_project):
    http, _ = monitoring_app
    await link_alertmanager(http, linked_project.project_id, closed_port_url(), name="Gone AM")
    ours = await http.post(SILENCES, json=silence_body())
    assert ours.status_code == 201, ours.text
    listed = await http.get(SILENCES)
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert [s["id"] for s in body["silences"]] == [ours.json()["id"]]
    [problem] = body["problems"]
    assert problem["source_name"] == "Gone AM"
    assert problem["message"].startswith("Can't reach Gone AM")


@pytest.mark.parametrize(
    "over, field, message",
    [
        ({"matchers": ""}, "matchers", NAMES),
        ({"matchers": 'alertname=~".*"'}, "matchers", NAMES),
        ({"matchers": 'team="",env!~".+"'}, "matchers", NAMES),
        (
            {"matchers": "alertname"},
            "matchers",
            'Use label matchers like cluster="prod-east", separated by commas.',
        ),
        (
            {"matchers": 'job=~"(a+)+"'},
            "matchers",
            "This pattern could take too long to match. Simplify it.",
        ),
        ({"ends_at": "2020-01-01T00:00:00Z"}, "ends_at", "The end has to be after the start."),
        (
            {"starts_at": "2099-01-02T00:00:00Z", "ends_at": "2099-01-01T00:00:00Z"},
            "ends_at",
            "The end has to be after the start.",
        ),
        (
            {"ends_at": (now() + 91 * DAY).isoformat()},
            "ends_at",
            "A silence lasts at most 90 days.",
        ),
        ({"comment": "   "}, "comment", "Say why, for whoever sees it later."),
        ({"comment": "x" * 501}, "comment", "Use at most 500 characters."),
    ],
)
async def test_silence_validation_copy(monitoring_app, over, field, message):
    http, _ = monitoring_app
    r = await http.post(SILENCES, json=silence_body(**over))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == {"code": "invalid_silence", "message": message, "field": field}
    preview = await http.post(f"{SILENCES}/preview", json=silence_body(**over))
    assert preview.json()["detail"]["message"] == message
    assert not [r for r in await monitoring_records(http) if r["action"] == "silence_add"]


async def test_alertmanager_refusals_pass_through_without_secrets(
    monitoring_app, linked_project, fake_alertmanager
):
    http, _ = monitoring_app
    am = await link_alertmanager(
        http,
        linked_project.project_id,
        fake_alertmanager.url,
        auth={"type": "bearer", "token": "tok-SECRET-12"},
    )
    where = {"kind": "alertmanager", "source_id": am["id"]}
    fake_alertmanager.echo_auth_in_errors = True
    fake_alertmanager.fail_paths["/api/v2/silences"] = 400
    r = await http.post(SILENCES, json=silence_body(where, matchers='job=~"api.*"'))
    assert refusal(r)[:2] == (422, "refused")
    assert refusal(r)[2].startswith("Main AM refused the silence: refused")
    [record] = [r for r in await monitoring_records(http) if r["action"] == "silence_add"]
    assert record["outcome"] == "failed"

    fake_alertmanager.fail_paths["/api/v2/silences"] = 500
    r = await http.post(SILENCES, json=silence_body(where))
    assert refusal(r) == (
        502,
        "unreachable",
        "Main AM answered HTTP 500. Try again, or check the tool.",
    )
    listed = (await http.get(SILENCES)).json()
    assert listed["problems"] == [
        {
            "source_id": where["source_id"],
            "source_name": "Main AM",
            "message": "Main AM answered HTTP 500. Try again, or check the tool.",
            "unreachable": False,
        }
    ]
    texts = [r.text, str(listed), (await http.get("/api/audit")).text]
    assert all("tok-SECRET-12" not in text for text in texts)

    fake_alertmanager.fail_paths.clear()
    before = len(await monitoring_records(http))
    gone = await http.delete(f"{SILENCES}/alertmanager/../x", params={"source_id": am["id"]})
    assert gone.status_code in (404, 405)
    unknown = await http.delete(f"{SILENCES}/alertmanager/no-such", params={"source_id": am["id"]})
    assert refusal(unknown) == (404, "not_found", "That silence no longer exists in Main AM.")
    # Looked up first: an id it doesn't hold writes no audit record.
    assert len(await monitoring_records(http)) == before
    assert not [r for r in fake_alertmanager.requests if r.method == "DELETE"]
    nowhere = await http.delete(f"{SILENCES}/alertmanager/no-such")
    assert refusal(nowhere) == (422, "invalid_silence", "Say which Alertmanager holds the silence.")
    missing = await http.post(
        SILENCES, json=silence_body({"kind": "alertmanager", "source_id": "x"})
    )
    assert refusal(missing) == (404, "not_found", "That Alertmanager no longer exists.")


async def test_preview_counts_matched_instances(monitoring_app, linked_project, fake_alertmanager):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    rule = (await add_rule(http, rule_body(linked_project.project_id)))["rule"]
    other = (await add_rule(http, rule_body(linked_project.project_id, name="Disk full")))["rule"]
    moment = now()

    def instance(target_id: str, name: str, route: str) -> InstanceRecord:
        labels = {"alertname": name, "route": route, "omnikrux_rule": "r", "severity": "warning"}
        return InstanceRecord(
            target_id=target_id,
            fingerprint=fingerprint(labels),
            labels=labels,
            state="firing",
            active_since=moment,
            fired_at=moment,
            value=1.0,
            last_notified_at=None,
        )

    first, second = rule["targets"][0]["id"], other["targets"][0]["id"]
    await alerts.replace_instances(
        first,
        [instance(first, "API latency high", "/a"), instance(first, "API latency high", "/b")],
    )
    await alerts.replace_instances(second, [instance(second, "Disk full", "/a")])

    r = await http.post(f"{SILENCES}/preview", json=silence_body())
    assert r.status_code == 200, r.text
    assert r.json() == {"affects": 2, "rules": ["API latency high"]}
    r = await http.post(f"{SILENCES}/preview", json=silence_body(matchers='route="/a"'))
    assert r.json() == {"affects": 2, "rules": ["API latency high", "Disk full"]}
    r = await http.post(f"{SILENCES}/preview", json=silence_body(matchers='route="/c"'))
    assert r.json() == {"affects": 0, "rules": []}
    # A preview changes nothing.
    assert (await http.get(SILENCES)).json()["silences"] == []

    created = await http.post(SILENCES, json=silence_body(matchers='route="/a"'))
    assert created.json()["affects"] == 2
    [listed] = (await http.get(SILENCES)).json()["silences"]
    assert listed["affects"] == 2

    # An Alertmanager silence is previewed against that Alertmanager's alerts.
    am = await link_alertmanager(http, linked_project.project_id, fake_alertmanager.url)
    fake_alertmanager.alerts = [
        {"labels": {"alertname": "Disk full", "route": "/a"}, "status": {"state": "active"}},
        {"labels": {"alertname": "CPU", "route": "/b"}, "status": {"state": "active"}},
    ]
    r = await http.post(
        f"{SILENCES}/preview",
        json=silence_body({"kind": "alertmanager", "source_id": am["id"]}, matchers='route="/a"'),
    )
    assert r.json() == {"affects": 1, "rules": ["Disk full"]}

    # Its patterns run in OmniKrux for the preview: guarded like OmniKrux's own, so a nested
    # quantifier never reaches the matcher (nor the Alertmanager).
    fake_alertmanager.alerts.append(
        {"labels": {"alertname": "a" * 255 + "!", "route": "/a"}, "status": {"state": "active"}}
    )
    for path in (f"{SILENCES}/preview", SILENCES):
        r = await http.post(
            path,
            json=silence_body(
                {"kind": "alertmanager", "source_id": am["id"]}, matchers='alertname=~"(a+)+$"'
            ),
        )
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == {
            "code": "invalid_silence",
            "message": "This pattern could take too long to match. Simplify it.",
            "field": "matchers",
        }
    assert not [q for q in fake_alertmanager.requests if q.method == "POST"]


async def test_silence_routes_refuse_cross_origin(monitoring_app):
    http, _ = monitoring_app
    evil = {"Origin": "http://evil.example"}
    for method, path in (
        ("GET", SILENCES),
        ("POST", SILENCES),
        ("POST", f"{SILENCES}/preview"),
        ("DELETE", f"{SILENCES}/omnikrux/x"),
    ):
        r = await http.request(method, path, headers=evil, json=silence_body())
        assert r.status_code == 403, (method, path)


async def test_an_expired_silence_can_be_removed(monitoring_app):
    http, _ = monitoring_app
    made = (await http.post(SILENCES, json=silence_body())).json()
    ended = await http.delete(f"{SILENCES}/omnikrux/{made['id']}")
    assert ended.status_code == 204, ended.text

    gone = await http.delete(f"{SILENCES}/omnikrux/{made['id']}", params={"expired": "1"})
    assert gone.status_code == 204, gone.text
    assert (await http.get(SILENCES)).json()["silences"] == []
    again = await http.delete(f"{SILENCES}/omnikrux/{made['id']}", params={"expired": "1"})
    assert refusal(again) == (404, "not_found", "That silence no longer exists.")

    records = [
        (r["action"], r["outcome"], r["details"])
        for r in await monitoring_records(http)
        if r["action"] == "silence_remove"
    ]
    assert records[-1] == (
        "silence_remove",
        "succeeded",
        {
            "where": "OmniKrux",
            "matchers": 'alertname="API latency high"',
            "removed_expired": True,
            "change": 'Removed the expired silence alertname="API latency high".',
        },
    )


async def test_an_active_silence_is_not_removed(monitoring_app):
    http, _ = monitoring_app
    made = (await http.post(SILENCES, json=silence_body())).json()
    kept = await http.delete(f"{SILENCES}/omnikrux/{made['id']}", params={"expired": "1"})
    assert refusal(kept) == (409, "still_active", "Expire it first.")
    [listed] = (await http.get(SILENCES)).json()["silences"]
    assert (listed["id"], listed["state"]) == (made["id"], "active")
    assert not [r for r in await monitoring_records(http) if r["action"] == "silence_remove"]


async def test_an_unreachable_alertmanager_is_named_in_its_problem(monitoring_app, linked_project):
    http, _ = monitoring_app
    am = await link_alertmanager(http, linked_project.project_id, closed_port_url(), name="Gone AM")
    [problem] = (await http.get(SILENCES)).json()["problems"]
    assert (problem["source_id"], problem["unreachable"]) == (am["id"], True)


async def test_silenced_rules_leave_the_firing_count(monitoring_app, linked_project):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    rule = (await add_rule(http, rule_body(linked_project.project_id)))["rule"]
    target_id = rule["targets"][0]["id"]
    moment = now()

    def instance(route: str, silenced: bool) -> InstanceRecord:
        labels = {"alertname": "API latency high", "route": route}
        return InstanceRecord(
            target_id=target_id,
            fingerprint=fingerprint(labels),
            labels=labels,
            state="firing",
            active_since=moment,
            fired_at=moment,
            value=1.0,
            last_notified_at=None,
            silenced=silenced,
        )

    await alerts.replace_instances(target_id, [instance("/a", True), instance("/b", False)])
    await alerts.set_eval(
        target_id, state="firing", message=None, at=moment, next_eval_at=None, failures=0
    )
    counts = (await http.get(f"{API}/alerts/overview")).json()["counts"]
    assert (counts["firing"], counts["firing_unsilenced"]) == (1, 1)

    await alerts.replace_instances(target_id, [instance("/a", True), instance("/b", True)])
    counts = (await http.get(f"{API}/alerts/overview")).json()["counts"]
    assert (counts["firing"], counts["firing_unsilenced"]) == (1, 0)


async def test_a_silence_expired_before_its_start_can_be_removed(monitoring_app):
    http, _ = monitoring_app
    planned = silence_body(
        starts_at=(now() + DAY).isoformat(), ends_at=(now() + 2 * DAY).isoformat()
    )
    made = (await http.post(SILENCES, json=planned)).json()
    assert made["state"] == "pending"
    ended = await http.delete(f"{SILENCES}/omnikrux/{made['id']}")
    assert ended.status_code == 204, ended.text
    [listed] = (await http.get(SILENCES)).json()["silences"]
    assert listed["state"] == "expired"
    gone = await http.delete(f"{SILENCES}/omnikrux/{made['id']}", params={"expired": "1"})
    assert gone.status_code == 204, gone.text
    assert (await http.get(SILENCES)).json()["silences"] == []


async def test_expired_flag_is_refused_for_an_alertmanager_silence(
    monitoring_app, linked_project, fake_alertmanager
):
    http, _ = monitoring_app
    am = await link_alertmanager(http, linked_project.project_id, fake_alertmanager.url)
    made = await http.post(
        SILENCES, json=silence_body({"kind": "alertmanager", "source_id": am["id"]})
    )
    held = made.json()
    r = await http.delete(
        f"{SILENCES}/alertmanager/{held['id']}", params={"source_id": am["id"], "expired": "1"}
    )
    assert refusal(r) == (
        400,
        "bad_request",
        (
            "Only an OmniKrux silence that has ended can be removed. "
            "An Alertmanager keeps its own expired silences."
        ),
    )
    assert fake_alertmanager.silences[held["id"]]["status"] != {"state": "expired"}
    assert not [q for q in fake_alertmanager.requests if q.method == "DELETE"]


async def test_a_firing_target_without_instances_counts_as_firing(monitoring_app, linked_project):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    rule = (await add_rule(http, rule_body(linked_project.project_id)))["rule"]
    target_id = rule["targets"][0]["id"]
    await alerts.replace_instances(target_id, [])
    await alerts.set_eval(
        target_id, state="firing", message=None, at=now(), next_eval_at=None, failures=0
    )
    counts = (await http.get(f"{API}/alerts/overview")).json()["counts"]
    assert (counts["firing"], counts["firing_unsilenced"]) == (1, 1)
