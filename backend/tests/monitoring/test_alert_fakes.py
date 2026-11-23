"""The fakes M4's alert tests stand on: rule APIs, the Loki ruler, Alertmanager, a webhook
receiver, an SMTP server and fakekube's generic create. Each is a real server on 127.0.0.1."""

import asyncio
import smtplib
import ssl

import httpx
import yaml

from tests.fakekube import prometheus_operator
from tests.monitoring.fake_receivers import ReceivedMail
from tests.monitoring.webhook_receiver import check_host, make_app

ALERTING = {"name": "Down", "type": "alerting", "query": "up == 0", "state": "firing"}
RECORDING = {"name": "job:up", "type": "recording", "query": "sum(up)"}

LOKI_GROUP = """\
name: omnikrux-abc
rules:
  - alert: Noisy
    expr: 'rate({app="x"} |= "error" [5m]) > 1'
"""


async def test_prometheus_rules_api_serves_groups(fake_prometheus):
    fake_prometheus.rule_groups = [
        {"name": "g", "file": "f.yaml", "rules": [ALERTING, RECORDING], "interval": 30}
    ]
    async with httpx.AsyncClient(base_url=fake_prometheus.url) as http:
        everything = await http.get("/api/v1/rules")
        only_alerts = await http.get("/api/v1/rules", params={"type": "alert"})
    assert everything.json() == {
        "status": "success",
        "data": {"groups": fake_prometheus.rule_groups},
    }
    [group] = only_alerts.json()["data"]["groups"]
    assert [rule["name"] for rule in group["rules"]] == ["Down"]
    assert [rule["name"] for rule in fake_prometheus.rule_groups[0]["rules"]] == ["Down", "job:up"]


async def test_loki_ruler_round_trip(fake_loki):
    fake_loki.rule_states = [{"name": "omnikrux-abc", "file": "ns", "rules": [ALERTING]}]
    async with httpx.AsyncClient(base_url=fake_loki.url) as http:
        stored = await http.post("/loki/api/v1/rules/ns", content=LOKI_GROUP)
        assert stored.status_code == 202
        back = await http.get("/loki/api/v1/rules/ns/omnikrux-abc")
        assert back.status_code == 200
        assert yaml.safe_load(back.text)["name"] == "omnikrux-abc"
        assert fake_loki.ruler_groups == {"ns": {"omnikrux-abc": LOKI_GROUP}}
        states = await http.get("/prometheus/api/v1/rules")
        assert states.json()["data"]["groups"] == fake_loki.rule_states
        assert (await http.delete("/loki/api/v1/rules/ns/omnikrux-abc")).status_code == 202
        assert (await http.get("/loki/api/v1/rules/ns/omnikrux-abc")).status_code == 404
        assert (await http.delete("/loki/api/v1/rules/ns/omnikrux-abc")).status_code == 404
    assert fake_loki.ruler_groups == {"ns": {}}


async def test_loki_ruler_failure_and_bad_yaml(fake_loki):
    async with httpx.AsyncClient(base_url=fake_loki.url) as http:
        assert (
            await http.post("/loki/api/v1/rules/ns", content="- just a list")
        ).status_code == 400
        fake_loki.ruler_fail = 503
        assert (await http.post("/loki/api/v1/rules/ns", content=LOKI_GROUP)).status_code == 503
        assert (await http.delete("/loki/api/v1/rules/ns/g")).status_code == 503
        assert (await http.get("/loki/api/v1/rules/ns/g")).status_code == 404
    assert fake_loki.ruler_groups == {}


async def test_alertmanager_status_and_alerts_with_filters(fake_alertmanager):
    am = fake_alertmanager
    am.config_yaml = "route:\n  receiver: default\n"
    am.alerts = [
        {"labels": {"alertname": "Down", "cluster": "a"}, "status": {"state": "active"}},
        {"labels": {"alertname": "Slow", "cluster": "b"}, "status": {"state": "active"}},
    ]
    async with httpx.AsyncClient(base_url=am.url) as http:
        status = (await http.get("/api/v2/status")).json()
        assert status["versionInfo"]["version"] == "0.27.0"
        assert status["config"]["original"] == am.config_yaml
        names = lambda found: [a["labels"]["alertname"] for a in found.json()]
        assert names(await http.get("/api/v2/alerts")) == ["Down", "Slow"]
        by_cluster = await http.get("/api/v2/alerts", params={"filter": 'cluster="b"'})
        assert names(by_cluster) == ["Slow"]
        both = await http.get(
            "/api/v2/alerts", params=[("filter", 'cluster=~"a|b"'), ("filter", "alertname!=Down")]
        )
        assert names(both) == ["Slow"]


async def test_alertmanager_silences_and_filtered_alerts(fake_alertmanager):
    am = fake_alertmanager
    body = {
        "matchers": [{"name": "alertname", "value": "Down", "isRegex": False, "isEqual": True}],
        "startsAt": "2026-01-01T00:00:00Z",
        "endsAt": "2026-01-01T01:00:00Z",
        "createdBy": "tester",
        "comment": "maintenance",
    }
    async with httpx.AsyncClient(base_url=am.url) as http:
        made = await http.post("/api/v2/silences", json=body)
        assert made.status_code == 200
        silence_id = made.json()["silenceID"]
        assert silence_id
        listed = (await http.get("/api/v2/silences")).json()
        assert [s["id"] for s in listed] == [silence_id]
        assert listed[0]["status"]["state"] == "active"
        assert (await http.delete(f"/api/v2/silence/{silence_id}")).status_code == 200
        assert (await http.delete("/api/v2/silence/nope")).status_code == 404
    assert am.silences[silence_id]["status"]["state"] == "expired"
    assert [r.method for r in am.requests] == ["POST", "GET", "DELETE", "DELETE"]


async def test_alertmanager_refuses_an_empty_matching_silence(fake_alertmanager):
    am = fake_alertmanager
    matchers = [
        {"name": "a", "value": "", "isRegex": False, "isEqual": True},
        {"name": "b", "value": ".*", "isRegex": True, "isEqual": True},
    ]
    async with httpx.AsyncClient(base_url=am.url) as http:
        refused = await http.post("/api/v2/silences", json={"matchers": matchers})
    assert refused.status_code == 400
    assert refused.json() == (
        "silence invalid: at least one matcher must not match the empty string"
    )
    assert am.silences == {}


async def test_alertmanager_honours_mode_and_require(fake_alertmanager):
    am = fake_alertmanager
    am.mode = "error500"
    async with httpx.AsyncClient(base_url=am.url) as http:
        assert (await http.get("/api/v2/status")).status_code == 500


async def test_webhook_receiver_records_and_echoes(fake_webhook):
    hook = fake_webhook
    async with httpx.AsyncClient(base_url=hook.url) as http:
        ok = await http.post("/hook?x=1", json={"a": 1}, headers={"Authorization": "Bearer s3"})
        assert ok.status_code == 200
        [seen] = hook.requests
        assert seen.path == "/hook"
        assert seen.params == {"x": ["1"]}
        assert seen.json == {"a": 1}
        assert seen.body == b'{"a":1}'
        hook.mode = "echo"
        echoed = await http.post("/secret-path?token=abc", headers={"Authorization": "Bearer s3"})
        assert echoed.status_code == 400
        for leaked in ("/secret-path", "token=abc", "Bearer s3"):
            assert leaked in echoed.text
        hook.mode = "error500"
        assert (await http.post("/hook")).status_code == 500
        hook.mode = "ok"
        hook.status_codes = [503, 429]
        codes = [(await http.post("/hook")).status_code for _ in range(3)]
        assert codes == [503, 429, 200]
        assert hook.status_codes == []


async def test_webhook_receiver_hangs_until_released(fake_webhook):
    fake_webhook.mode = "hang"
    async with httpx.AsyncClient(base_url=fake_webhook.url, timeout=0.3) as http:
        try:
            await http.post("/hook")
        except httpx.TimeoutException:
            hung = True
        else:
            hung = False
    assert hung
    assert len(fake_webhook.requests) == 1


def _send(smtp: smtplib.SMTP, *, login: tuple[str, str] | None, tls: ssl.SSLContext | None):
    smtp.ehlo()
    if tls is not None:
        smtp.starttls(context=tls)
        smtp.ehlo()
    if login is not None:
        smtp.login(*login)
    smtp.sendmail(
        "from@example.test", ["to@example.test"], "Subject: hi\r\n\r\n.dotted\r\nbody\r\n"
    )
    smtp.quit()


async def test_fake_smtp_accepts_mail_with_auth_and_starttls(fake_smtp_tls, fake_tls):
    server = fake_smtp_tls
    context = ssl.create_default_context(cadata=fake_tls.ca_pem)

    def run():
        with smtplib.SMTP(server.host, server.port, timeout=5) as smtp:
            _send(smtp, login=(server.user, server.password), tls=context)

    await asyncio.to_thread(run)
    [mail] = server.messages
    assert isinstance(mail, ReceivedMail)
    assert mail.sender == "from@example.test"
    assert mail.recipients == ["to@example.test"]
    assert b"Subject: hi" in mail.data
    assert b"\r\n.dotted\r\n" in mail.data


async def test_fake_smtp_takes_plain_mail_and_login_auth(fake_smtp):
    server = fake_smtp

    def run():
        with smtplib.SMTP(server.host, server.port, timeout=5) as smtp:
            smtp.ehlo()
            smtp.user, smtp.password = server.user, server.password
            smtp.auth("LOGIN", smtp.auth_login)
            smtp.sendmail("a@example.test", ["b@example.test", "c@example.test"], "x\r\n")

    await asyncio.to_thread(run)
    assert server.messages[0].recipients == ["b@example.test", "c@example.test"]


async def test_fake_smtp_rejects_bad_auth(fake_smtp):
    server = fake_smtp

    def attempt(password: str):
        with smtplib.SMTP(server.host, server.port, timeout=5) as smtp:
            smtp.ehlo()
            try:
                smtp.login(server.user, password)
            except smtplib.SMTPAuthenticationError as error:
                return error.smtp_code, error.smtp_error.decode()
        return None

    code, text = await asyncio.to_thread(attempt, "wrong")
    assert code == 535
    assert "wrong" not in text
    server.echo_password_on_auth_failure = True
    code, text = await asyncio.to_thread(attempt, "wrong")
    assert code == 535
    assert "wrong" in text
    server.echo_password_on_auth_failure = False
    server.reject_auth = True
    assert (await asyncio.to_thread(attempt, server.password))[0] == 535
    assert server.messages == []


async def test_fake_smtp_refuses_a_recipient_and_demands_tls_before_auth(fake_smtp_tls, fake_tls):
    server = fake_smtp_tls
    server.reject_rcpt = "mailbox unavailable"

    def run():
        with smtplib.SMTP(server.host, server.port, timeout=5) as smtp:
            smtp.ehlo()
            assert "auth" not in smtp.esmtp_features
            try:
                smtp.login(server.user, server.password)
            except smtplib.SMTPException as error:
                before_tls = str(error)
            smtp.starttls(context=ssl.create_default_context(cadata=fake_tls.ca_pem))
            smtp.ehlo()
            smtp.login(server.user, server.password)
            try:
                smtp.sendmail("a@example.test", ["x@example.test"], "x\r\n")
            except smtplib.SMTPRecipientsRefused as refused:
                return before_tls, refused.recipients["x@example.test"]
        return None

    before_tls, (code, text) = await asyncio.to_thread(run)
    assert before_tls
    assert code == 550
    assert text.decode() == "5.1.1 <x@example.test>: mailbox unavailable"
    assert server.messages == []


async def test_fakekube_creates_and_refuses_duplicates(fake_api):
    prometheus_operator(fake_api)
    rule = {
        "apiVersion": "monitoring.coreos.com/v1",
        "kind": "PrometheusRule",
        "metadata": {"name": "r1", "labels": {"release": "kps"}},
        "spec": {"groups": []},
    }
    path = "/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheusrules"
    async with httpx.AsyncClient(base_url=fake_api.url) as http:
        first = await http.post(path, json=rule)
        assert first.status_code == 201
        md = first.json()["metadata"]
        assert md["uid"] and md["resourceVersion"] == "1" and md["generation"] == 1
        assert md["creationTimestamp"] and md["namespace"] == "monitoring"
        second = await http.post(path, json=rule)
        assert second.status_code == 409
        assert second.json()["reason"] == "AlreadyExists"
        assert second.json()["message"] == (
            'prometheusrules.monitoring.coreos.com "r1" already exists'
        )
        dry = await http.post(
            path, params={"dryRun": "All"}, json=rule | {"metadata": {"name": "d"}}
        )
        assert dry.status_code == 201
        assert (await http.get(f"{path}/d")).status_code == 404
        assert (await http.get(f"{path}/r1")).status_code == 200
    assert [o["metadata"]["name"] for o in fake_api.created_objects] == ["r1"]
    assert fake_api.created == []
    assert ("monitoring", "r1") in fake_api.objects["prometheusrules.monitoring.coreos.com"]


async def test_fakekube_generic_create_respects_forbidden_mode(fake_api):
    prometheus_operator(fake_api)
    fake_api.mode = "forbidden"
    path = "/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheusrules"
    async with httpx.AsyncClient(base_url=fake_api.url) as http:
        assert (await http.post(path, json={"metadata": {"name": "r"}})).status_code == 403
    assert fake_api.created_objects == []


async def test_prometheus_operator_helper_is_discoverable(fake_api):
    prometheus_operator(fake_api, rule_selector=None)
    async with httpx.AsyncClient(base_url=fake_api.url) as http:
        v1 = (await http.get("/apis/monitoring.coreos.com/v1")).json()
        names = {r["name"] for r in v1["resources"]}
        assert {"prometheuses", "prometheusrules", "alertmanagers", "servicemonitors"} <= names
        alpha = (await http.get("/apis/monitoring.coreos.com/v1alpha1")).json()
        assert "alertmanagerconfigs" in {r["name"] for r in alpha["resources"]}
        prom = (
            await http.get("/apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheuses/kps")
        ).json()
        assert "ruleSelector" not in prom["spec"]
        assert prom["spec"]["ruleNamespaceSelector"] == {}
        svc = (await http.get("/api/v1/namespaces/monitoring/services/kps-prometheus")).json()
        assert svc["spec"]["selector"] == {"operator.prometheus.io/name": "kps"}
        ns = (await http.get("/api/v1/namespaces/monitoring")).json()
        assert ns["metadata"]["labels"]["kubernetes.io/metadata.name"] == "monitoring"


async def test_prometheus_operator_default_selectors(fake_api):
    prometheus_operator(fake_api)
    spec = fake_api.objects["prometheuses.monitoring.coreos.com"][("monitoring", "kps")]["spec"]
    assert spec["ruleSelector"] == {"matchLabels": {"release": "kps"}}


async def test_runnable_receiver_prints_one_line_per_request_and_never_the_headers():
    lines: list[str] = []
    app = make_app(lines.append)
    from aiohttp.test_utils import TestClient, TestServer

    async with TestClient(TestServer(app)) as client:
        reply = await client.post(
            "/hook/a?token=zzz",
            data="x" * 300 + "\nnext",
            headers={"Authorization": "Bearer topsecret"},
        )
        assert reply.status == 200
    [line] = lines
    _, path, body = line.split(" ", 2)
    assert path == "/hook/a"
    assert body == "x" * 200
    assert "topsecret" not in line and "zzz" not in line


def test_runnable_receiver_binds_to_loopback_only():
    check_host("127.0.0.1")
    for host in ("0.0.0.0", "", "192.168.1.5", "::"):
        try:
            check_host(host)
        except SystemExit:
            continue
        raise AssertionError(f"{host!r} was accepted")
