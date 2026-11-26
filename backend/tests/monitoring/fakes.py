"""Fake Prometheus, Loki and Grafana over real HTTP, shared by every Monitoring test.

Nothing is mocked inside the code under test: it talks to a real aiohttp server on 127.0.0.1.
`url` is where to reach one; `requests` records every request (method, path, parameters from the
query string and a form body, headers). `mode` picks how a Prometheus or Loki answers:

    ok: everything works; hang: never answers until `release`; error500: 500 everywhere;
    not_prometheus: 200 with an HTML page everywhere; no_buildinfo: only the build info is 404.

Seed `results` (exact query text -> the `data` object a query answers with; any other query gets
an empty result of the right type), `errors` (exact query -> a `bad_data` error text, answered
400), `labels`, `label_values`, `metadata` and `series` (the label sets `/api/v1/series` and
`/loki/api/v1/series` answer with; Prometheus honours `limit`). Opt-ins for tests that need time
and filters honoured: a Prometheus's `label_values_from_series` reads label values from `series`
under the `match[]` sent, and its `first_seen` leaves a metric out of `__name__` values asked up
to an `end` before its first sample; a Loki's `stream_lines` holds streams with timed lines (see `FakeLoki`).
`fail_paths` (path -> status)
answers that status instead for one path. `require` makes a request without the matching
credentials answer 401; `echo_auth_in_errors` makes error bodies repeat the request's
`Authorization` header, for leak tests. With a `TlsMaterial` the server speaks HTTPS, and a
`ClientCert` requirement also demands a client certificate signed by the material's CA.

Alerting: a Prometheus serves `rule_groups` at `/api/v1/rules` (`type=alert` keeps alerting
rules). A Loki keeps a ruler store, `ruler_groups` (namespace -> group name -> YAML text), behind
`/loki/api/v1/rules/{namespace}[/{group}]` (`ruler_fail` makes every ruler write answer that
status) and serves `rule_states` (Prometheus group shape) at `/prometheus/api/v1/rules`.
`FakeAlertmanager` serves status, alerts (seeded, filtered by `filter=` matchers) and silences.
"""

import asyncio
import base64
import datetime
import ipaddress
import json
import re
import ssl
import tempfile
import uuid
from contextlib import ExitStack, asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, Literal

import yaml
from aiohttp import web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

Mode = Literal["ok", "hang", "error500", "not_prometheus", "no_buildinfo"]
BODY = web.RequestKey("body", bytes)


@dataclass
class FakeRequest:
    method: str
    path: str
    params: dict[str, list[str]]
    headers: dict[str, str]
    body: bytes = b""

    @property
    def json(self):
        return json.loads(self.body)


@dataclass(frozen=True)
class Basic:
    user: str
    password: str


@dataclass(frozen=True)
class Bearer:
    token: str


@dataclass(frozen=True)
class Header:
    name: str
    value: str


@dataclass(frozen=True)
class ClientCert:
    """A client certificate signed by the fake CA; checked by the TLS handshake."""


AuthRequirement = Basic | Bearer | Header | ClientCert


def _satisfied(require: AuthRequirement | None, headers: dict[str, str]) -> bool:
    lowered = {name.lower(): value for name, value in headers.items()}
    match require:
        case None | ClientCert():
            return True
        case Basic(user, password):
            token = base64.b64encode(f"{user}:{password}".encode()).decode()
            return lowered.get("authorization") == f"Basic {token}"
        case Bearer(token):
            return lowered.get("authorization") == f"Bearer {token}"
        case Header(name, value):
            return lowered.get(name.lower()) == value
    return False


class _FakeTool:
    """What a fake Prometheus and a fake Loki share: modes, auth, recording and seeded answers."""

    version = ""
    empty_instant: ClassVar[dict] = {}
    empty_range: ClassVar[dict] = {}

    def __init__(self) -> None:
        self.url = ""
        self.requests: list[FakeRequest] = []
        self.mode: Mode = "ok"
        self.release = asyncio.Event()
        self.require: AuthRequirement | None = None
        self.results: dict[str, dict] = {}
        self.errors: dict[str, str] = {}
        self.labels: list[str] = []
        self.label_values: dict[str, list[str]] = {}
        self.metadata: dict[str, list[dict]] = {}
        self.series: list[dict[str, str]] = []
        self.fail_paths: dict[str, int] = {}
        self.echo_auth_in_errors = False

    async def handle(self, request: web.Request) -> web.StreamResponse:
        params = {key: request.query.getall(key) for key in request.query}
        if request.method == "POST" and request.can_read_body:
            form = await request.post()
            for key in form:
                params.setdefault(key, []).extend(str(v) for v in form.getall(key))
        raw = await request.read()  # after the form: the form has read it, or it is still unread
        request[BODY] = raw
        headers = dict(request.headers)
        self.requests.append(FakeRequest(request.method, request.path, params, headers, raw))
        if self.mode == "hang":
            await self.release.wait()
        if not _satisfied(self.require, headers):
            return self._error(401, "unauthorized", headers)
        if self.mode == "error500":
            return self._error(500, "internal error", headers)
        if request.path in self.fail_paths:
            return self._error(self.fail_paths[request.path], "refused", headers)
        if self.mode == "not_prometheus":
            return web.Response(text="<html><body>Sign in</body></html>", content_type="text/html")
        return self.route(request, params, headers)

    def route(
        self, request: web.Request, params: dict[str, list[str]], headers: dict[str, str]
    ) -> web.StreamResponse:
        raise NotImplementedError

    def _error(self, status: int, text: str, headers: dict[str, str]) -> web.Response:
        if self.echo_auth_in_errors:
            text = f"{text}: Authorization={headers.get('Authorization', '')}"
        return web.Response(status=status, text=text)

    def _query(self, params: dict[str, list[str]], empty: dict) -> web.Response:
        query = (params.get("query") or [""])[0]
        if query in self.errors:
            body = {"status": "error", "errorType": "bad_data", "error": self.errors[query]}
            return web.json_response(body, status=400)
        data = self.results.get(query, empty)
        return web.json_response({"status": "success", "data": data})

    def _labels(self) -> web.Response:
        return web.json_response({"status": "success", "data": self.labels})

    def _label_values(self, name: str) -> web.Response:
        return web.json_response({"status": "success", "data": self.label_values.get(name, [])})

    def _series(self, params: dict[str, list[str]]) -> web.Response:
        return web.json_response({"status": "success", "data": self.series})


class FakePrometheus(_FakeTool):
    version = "3.1.0"
    empty_instant: ClassVar[dict] = {"resultType": "vector", "result": []}
    empty_range: ClassVar[dict] = {"resultType": "matrix", "result": []}

    def __init__(self) -> None:
        super().__init__()
        self.rule_groups: list[dict] = []
        # Opt-in: label values come from `series`, narrowed by the `match[]` selectors sent.
        self.label_values_from_series = False
        # Metric name -> the time (seconds) its first sample was written. A `__name__` values
        # request with an `end` leaves out the metrics first written after it.
        self.first_seen: dict[str, float] = {}

    def route(
        self, request: web.Request, params: dict[str, list[str]], headers: dict[str, str]
    ) -> web.StreamResponse:
        path = request.path
        if path == "/api/v1/status/buildinfo":
            if self.mode == "no_buildinfo":
                return web.Response(status=404, text="404 page not found")
            return web.json_response({"status": "success", "data": {"version": self.version}})
        if path == "/api/v1/query":
            return self._query(params, self.empty_instant)
        if path == "/api/v1/query_range":
            return self._query(params, self.empty_range)
        if path == "/api/v1/labels":
            return self._labels()
        if (match := _LABEL_VALUES.match(path)) and self.label_values_from_series:
            return self._values_in_series(match["name"], params)
        if (match := _LABEL_VALUES.match(path)) and match["name"] == "__name__" and self.first_seen:
            return self._names_up_to(params)
        if match := _LABEL_VALUES.match(path):
            return self._label_values(match["name"])
        if path == "/api/v1/metadata":
            return web.json_response({"status": "success", "data": self.metadata})
        if path == "/api/v1/series":
            return self._series(params)
        if path == "/api/v1/rules":
            return self._rules(params)
        return web.Response(status=404, text="404 page not found")

    def _rules(self, params: dict[str, list[str]]) -> web.Response:
        groups = self.rule_groups
        if (params.get("type") or [""])[0] == "alert":
            groups = [
                group
                | {"rules": [r for r in group.get("rules", []) if r.get("type") == "alerting"]}
                for group in groups
            ]
        return web.json_response({"status": "success", "data": {"groups": groups}})

    def _series(self, params: dict[str, list[str]]) -> web.Response:
        limit = (params.get("limit") or [""])[0]
        data = self.series[: int(limit)] if limit.isdigit() and int(limit) > 0 else self.series
        return web.json_response({"status": "success", "data": data})

    def _names_up_to(self, params: dict[str, list[str]]) -> web.Response:
        end = float((params.get("end") or ["inf"])[0])
        names = [
            n
            for n in self.label_values.get("__name__", [])
            if self.first_seen.get(n, float("-inf")) <= end
        ]
        return web.json_response({"status": "success", "data": names})

    def _values_in_series(self, name: str, params: dict[str, list[str]]) -> web.Response:
        tests = [_selector_test(text) for text in params.get("match[]", [])]
        found = {
            labels[name]
            for labels in self.series
            if name in labels and (not tests or any(test(labels) for test in tests))
        }
        return web.json_response({"status": "success", "data": sorted(found)})


class FakeLoki(_FakeTool):
    version = "3.3.0"
    empty_instant: ClassVar[dict] = {"resultType": "streams", "result": []}
    empty_range: ClassVar[dict] = {"resultType": "streams", "result": []}

    def __init__(self) -> None:
        super().__init__()
        self.ruler = True
        self.ruler_groups: dict[str, dict[str, str]] = {}
        self.rule_states: list[dict] = []
        self.ruler_fail: int | None = None
        # The real ruler answers a list of rules, when it holds none, with a 404 and these words.
        self.ruler_empty_404 = False
        # Opt-in: streams with their lines, as (labels, [(nanoseconds, line), ...]). When set,
        # `/series` and `/labels` answer only the streams with a line between `start` and `end`
        # (and `/series` only those its `match[]` selects), and a `query_range` of a bare
        # selector not in `results` answers those streams' lines, honouring `limit` and
        # `direction`.
        self.stream_lines: list[tuple[dict[str, str], list[tuple[int, str]]]] = []

    def route(
        self, request: web.Request, params: dict[str, list[str]], headers: dict[str, str]
    ) -> web.StreamResponse:
        path = request.path
        if path == "/loki/api/v1/status/buildinfo":
            if self.mode == "no_buildinfo":
                return web.Response(status=404, text="404 page not found")
            return web.json_response({"version": self.version})
        if path == "/ready":
            return web.Response(text="ready")
        if path == "/loki/api/v1/query":
            return self._query(params, self.empty_instant)
        if path == "/loki/api/v1/query_range":
            query = (params.get("query") or [""])[0]
            if self.stream_lines and query not in self.results and query not in self.errors:
                return self._lines(query, params)
            return self._query(params, self.empty_range)
        if path == "/loki/api/v1/labels" and self.stream_lines:
            names = {name for labels, _ in self._in_window(params) for name in labels}
            return web.json_response({"status": "success", "data": sorted(names)})
        if path == "/loki/api/v1/labels":
            return self._labels()
        if match := _LOKI_LABEL_VALUES.match(path):
            return self._label_values(match["name"])
        if path == "/loki/api/v1/series" and self.stream_lines:
            tests = [_selector_test(text) for text in params.get("match[]", [])]
            data = [
                labels
                for labels, _ in self._in_window(params)
                if not tests or any(test(labels) for test in tests)
            ]
            return web.json_response({"status": "success", "data": data})
        if path == "/loki/api/v1/series":
            return self._series(params)
        if path == "/loki/api/v1/rules":
            if self.ruler and self.ruler_empty_404:
                return web.Response(status=404, text="no rule groups found\n")
            if self.ruler:
                return web.json_response({})
            return web.Response(status=404, text="ruler not enabled")
        if path == "/prometheus/api/v1/rules" and self.ruler:
            return web.json_response({"status": "success", "data": {"groups": self.rule_states}})
        if (match := _RULER.match(path)) and self.ruler:
            return self._ruler(request, match["namespace"], match["group"])
        return web.Response(status=404, text="404 page not found")

    def _in_window(
        self, params: dict[str, list[str]]
    ) -> list[tuple[dict[str, str], list[tuple[int, str]]]]:
        """The streams with their lines between `start` and `end`, keeping only those lines."""
        start = _loki_time((params.get("start") or [""])[0], 0)
        end = _loki_time((params.get("end") or [""])[0], 2**63)
        found = []
        for labels, lines in self.stream_lines:
            kept = [(at, text) for at, text in lines if start <= at <= end]
            if kept:
                found.append((labels, kept))
        return found

    def _lines(self, query: str, params: dict[str, list[str]]) -> web.Response:
        if not (query.startswith("{") and query.endswith("}")):
            return web.json_response({"status": "success", "data": self.empty_range})
        test = _selector_test(query)
        entries = [
            (at, labels, text)
            for labels, lines in self._in_window(params)
            if test(labels)
            for at, text in lines
        ]
        backward = (params.get("direction") or ["backward"])[0] == "backward"
        entries.sort(key=lambda entry: entry[0], reverse=backward)
        limit = (params.get("limit") or [""])[0]
        if limit.isdigit():
            entries = entries[: int(limit)]
        streams: dict[str, dict] = {}
        for at, labels, text in entries:
            key = json.dumps(labels, sort_keys=True)
            streams.setdefault(key, {"stream": labels, "values": []})["values"].append(
                [str(at), text]
            )
        data = {"resultType": "streams", "result": list(streams.values())}
        return web.json_response({"status": "success", "data": data})

    def _ruler(self, request: web.Request, namespace: str, group: str | None) -> web.Response:
        if request.method != "GET" and self.ruler_fail is not None:
            return web.Response(status=self.ruler_fail, text="ruler unavailable")
        stored = self.ruler_groups.get(namespace, {})
        if request.method == "POST" and group is None:
            try:
                document = yaml.safe_load(request[BODY])
            except yaml.YAMLError:
                document = None
            name = document.get("name") if isinstance(document, dict) else None
            if not isinstance(name, str) or not name:
                return web.Response(status=400, text="rule group needs a name")
            self.ruler_groups.setdefault(namespace, {})[name] = request[BODY].decode()
            return web.json_response({"status": "success"}, status=202)
        if group is None and request.method == "GET":
            if namespace not in self.ruler_groups:
                return web.Response(status=404, text="namespace does not exist")
            groups = [yaml.safe_load(text) for text in stored.values()]
            return web.Response(
                text=yaml.safe_dump({namespace: groups}), content_type="application/yaml"
            )
        if group is None:
            return web.Response(status=405, text="method not allowed")
        if request.method == "GET" and group in stored:
            return web.Response(text=stored[group], content_type="application/yaml")
        if request.method == "DELETE" and group in stored:
            del stored[group]
            return web.json_response({"status": "success"}, status=202)
        if request.method in ("GET", "DELETE"):
            return web.Response(status=404, text="group does not exist")
        return web.Response(status=405, text="method not allowed")


class FakeAlertmanager(_FakeTool):
    """Alertmanager's v2 API: `config_yaml` is its configuration, `alerts` the seeded alerts (an
    alert is {"labels": ..., ...}) and `silences` the silences by id."""

    version = "0.27.0"

    def __init__(self) -> None:
        super().__init__()
        self.config_yaml = ""
        self.alerts: list[dict] = []
        self.silences: dict[str, dict] = {}

    def route(
        self, request: web.Request, params: dict[str, list[str]], headers: dict[str, str]
    ) -> web.StreamResponse:
        path, method = request.path, request.method
        if path == "/api/v2/status" and method == "GET":
            return web.json_response(
                {
                    "versionInfo": {"version": self.version},
                    "config": {"original": self.config_yaml},
                }
            )
        if path == "/api/v2/alerts" and method == "GET":
            return web.json_response(self._alerts(params))
        if path == "/api/v2/silences" and method == "GET":
            return web.json_response(list(self.silences.values()))
        if path == "/api/v2/silences" and method == "POST":
            return self._silence(request[BODY])
        if (match := _SILENCE.match(path)) and method == "DELETE":
            silence = self.silences.get(match["id"])
            if silence is None:
                return web.json_response("silence not found", status=404)
            silence["status"] = {"state": "expired"}
            return web.Response()
        return web.Response(status=404, text="404 page not found")

    def _alerts(self, params: dict[str, list[str]]) -> list[dict]:
        matchers = [_parse_matcher(text) for text in params.get("filter", [])]
        hide_silenced = (params.get("silenced") or ["true"])[0].lower() == "false"
        hide_inhibited = (params.get("inhibited") or ["true"])[0].lower() == "false"
        receiver = (params.get("receiver") or [""])[0]
        found = []
        for alert in self.alerts:
            status = alert.get("status", {})
            if not all(m(alert.get("labels", {})) for m in matchers):
                continue
            if (hide_silenced and status.get("silencedBy")) or (
                hide_inhibited and status.get("inhibitedBy")
            ):
                continue
            names = [r.get("name", "") for r in alert.get("receivers", [])]
            if receiver and not any(re.fullmatch(receiver, name) for name in names):
                continue
            found.append(alert)
        return found

    def _silence(self, raw: bytes) -> web.Response:
        try:
            body = json.loads(raw)
        except ValueError:
            return web.json_response("bad silence", status=400)
        matchers = body.get("matchers") or []
        if not matchers:
            return web.json_response("silence invalid: at least one matcher required", status=400)
        starts, ends = _moment(body.get("startsAt")), _moment(body.get("endsAt"))
        now = datetime.datetime.now(datetime.UTC)
        if ends is not None and ends <= now:
            return web.json_response(
                "silence invalid: end time must not be in the past", status=400
            )
        if starts is not None and ends is not None and ends <= starts:
            return web.json_response(
                "silence invalid: end time must be after start time", status=400
            )
        if all(_matches_empty(m) for m in matchers):
            refusal = "silence invalid: at least one matcher must not match the empty string"
            return web.json_response(refusal, status=400)
        silence_id = body.get("id") or str(uuid.uuid4())
        self.silences[silence_id] = {
            **body,
            "id": silence_id,
            "status": {"state": "active"},
            "updatedAt": datetime.datetime.now(datetime.UTC).isoformat(),
        }
        return web.json_response({"silenceID": silence_id})


def _moment(text: object) -> datetime.datetime | None:
    try:
        return datetime.datetime.fromisoformat(str(text)) if text else None
    except ValueError:
        return None


def _matches_empty(matcher: dict) -> bool:
    value = matcher.get("value", "")
    hit = re.fullmatch(value, "") is not None if matcher.get("isRegex") else value == ""
    return hit if matcher.get("isEqual", True) else not hit


def _parse_matcher(text: str):
    """A `filter=` matcher such as `cluster="a"`, `x!=y` or `name=~"a|b"`, over a label dict."""
    found = re.fullmatch(r'\s*([^=!~\s]+)\s*(=~|!~|!=|=)\s*"?(.*?)"?\s*', text)
    if found is None:
        return lambda labels: False
    name, operator, value = found.groups()

    def test(labels: dict) -> bool:
        actual = labels.get(name, "")
        match operator:
            case "=":
                return actual == value
            case "!=":
                return actual != value
            case "=~":
                return re.fullmatch(value, actual) is not None
        return re.fullmatch(value, actual) is None

    return test


_SELECTOR_MATCHER = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"')


def _selector_test(text: str):
    """A selector such as `{__name__="up",cluster="a"}` as a test over a label dict: every
    matcher must hold (a missing label reads as empty, as in Prometheus and Loki)."""
    found = _SELECTOR_MATCHER.findall(text)

    def holds(labels: dict, name: str, operator: str, value: str) -> bool:
        actual = labels.get(name, "")
        value = value.replace('\\"', '"').replace("\\\\", "\\")
        match operator:
            case "=":
                return actual == value
            case "!=":
                return actual != value
            case "=~":
                return re.fullmatch(value, actual) is not None
        return re.fullmatch(value, actual) is None

    return lambda labels: all(holds(labels, *matcher) for matcher in found)


def _loki_time(text: str, default: int) -> int:
    """A Loki `start`/`end` as nanoseconds: seconds with a fraction, whole seconds (up to 10
    digits) or nanoseconds, as Loki reads them."""
    if not text:
        return default
    if "." in text:
        return int(float(text) * 1_000_000_000)
    return int(text) * 1_000_000_000 if len(text) <= 10 else int(text)


class FakeGrafana:
    """A Grafana's read API, in the shapes Grafana 11 to 13 answer.

    `dashboards` (uid -> the `{dashboard, meta}` answer of `/api/dashboards/uid/{uid}`) also feed
    `/api/search` (`meta.folderTitle` is the folder when `meta.folderUid` is set; `limit` is
    honoured); `dashboard_status` (uid -> status) answers that status for one dashboard instead.
    `datasources` (None: 403), `ruler` (the `/api/ruler/grafana/api/v1/rules` answer; None: 404)
    and `ruler_status` (a status other than 200 is answered instead). `require` makes every
    request but `/api/health` (anonymous in Grafana too) without the credentials answer 401;
    `echo_auth_in_errors` makes error bodies repeat the request's `Authorization` header;
    `mode="not_grafana"` answers an HTML page everywhere."""

    def __init__(self) -> None:
        self.url = ""
        self.requests: list[FakeRequest] = []
        self.version = "11.3.0"
        self.dashboards: dict[str, dict] = {}
        self.dashboard_status: dict[str, int] = {}
        self.datasources: list[dict] | None = []
        self.ruler: dict | None = None
        self.ruler_status = 200
        self.require: AuthRequirement | None = None
        self.mode: Literal["ok", "not_grafana"] = "ok"
        self.echo_auth_in_errors = False

    async def handle(self, request: web.Request) -> web.StreamResponse:
        params = {key: request.query.getall(key) for key in request.query}
        headers = dict(request.headers)
        self.requests.append(FakeRequest(request.method, request.path, params, headers))
        if self.mode == "not_grafana":
            return web.Response(text="<html><body>Sign in</body></html>", content_type="text/html")
        path = request.path
        if path == "/api/health":
            return web.json_response({"database": "ok", "version": self.version})
        if not _satisfied(self.require, headers):
            return self._error(401, {"message": "invalid API key"}, headers)
        if path == "/api/search":
            return web.json_response(self._search(params))
        if path.startswith("/api/dashboards/uid/"):
            uid = path.removeprefix("/api/dashboards/uid/")
            if uid in self.dashboard_status:
                return self._error(self.dashboard_status[uid], {"message": "refused"}, headers)
            if uid not in self.dashboards:
                return self._error(404, {"message": "Dashboard not found"}, headers)
            return web.json_response(self.dashboards[uid])
        if path == "/api/datasources":
            if self.datasources is None:
                return self._error(403, {"message": "Permission denied"}, headers)
            return web.json_response(self.datasources)
        if path == "/api/ruler/grafana/api/v1/rules":
            if self.ruler_status != 200:
                return self._error(self.ruler_status, {"message": "refused"}, headers)
            if self.ruler is None:
                return self._error(404, {"message": "Not found"}, headers)
            return web.json_response(self.ruler)
        return web.Response(status=404, text="404 page not found")

    def _error(self, status: int, body: dict, headers: dict[str, str]) -> web.Response:
        if self.echo_auth_in_errors:
            body = body | {"authorization": headers.get("Authorization", "")}
        return web.json_response(body, status=status)

    def _search(self, params: dict[str, list[str]]) -> list[dict]:
        limit = int((params.get("limit") or ["1000"])[0])
        found = []
        for uid, answer in self.dashboards.items():
            dashboard, meta = answer.get("dashboard") or {}, answer.get("meta") or {}
            item = {
                "uid": uid,
                "title": dashboard.get("title", ""),
                "type": "dash-db",
                "tags": dashboard.get("tags", []),
            }
            if meta.get("folderUid"):
                item["folderUid"] = meta["folderUid"]
                item["folderTitle"] = meta.get("folderTitle", "")
            found.append(item)
        return found[:limit]


_LABEL_VALUES = re.compile(r"^/api/v1/label/(?P<name>[^/]+)/values$")
_LOKI_LABEL_VALUES = re.compile(r"^/loki/api/v1/label/(?P<name>[^/]+)/values$")
_RULER = re.compile(r"^/loki/api/v1/rules/(?P<namespace>[^/]+)(?:/(?P<group>[^/]+))?$")
_SILENCE = re.compile(r"^/api/v2/silence/(?P<id>[^/]+)$")


@dataclass
class TlsMaterial:
    ca_pem: str
    server_cert_pem: str
    server_key_pem: str
    client_cert_pem: str
    client_key_pem: str


def _pem_key(key: ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _pem_cert(cert: x509.Certificate) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def make_tls_material() -> TlsMaterial:
    """A throwaway CA, a server certificate for 127.0.0.1 (IP SAN) and a client certificate."""
    now = datetime.datetime.now(datetime.UTC)

    def name(common: str) -> x509.Name:
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common)])

    def issue(subject: str, key, issuer: x509.Name, signer, *, ca=False, extra=()):
        builder = (
            x509.CertificateBuilder()
            .subject_name(name(subject))
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=30))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        )
        for extension in extra:
            builder = builder.add_extension(extension, critical=False)
        return builder.sign(signer, hashes.SHA256())

    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca = issue("omnikrux fake CA", ca_key, name("omnikrux fake CA"), ca_key, ca=True)
    server_key = ec.generate_private_key(ec.SECP256R1())
    server = issue(
        "127.0.0.1",
        server_key,
        ca.subject,
        ca_key,
        extra=[
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
        ],
    )
    client_key = ec.generate_private_key(ec.SECP256R1())
    client = issue(
        "omnikrux fake client",
        client_key,
        ca.subject,
        ca_key,
        extra=[x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH])],
    )
    return TlsMaterial(
        ca_pem=_pem_cert(ca),
        server_cert_pem=_pem_cert(server),
        server_key_pem=_pem_key(server_key),
        client_cert_pem=_pem_cert(client),
        client_key_pem=_pem_key(client_key),
    )


@contextmanager
def _server_ssl(tls: TlsMaterial, *, require_client_cert: bool):
    with tempfile.TemporaryDirectory() as folder:
        cert, key = Path(folder, "server.pem"), Path(folder, "server.key")
        cert.write_text(tls.server_cert_pem)
        key.write_text(tls.server_key_pem)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(str(cert), str(key))
        if require_client_cert:
            context.load_verify_locations(cadata=tls.ca_pem)
            context.verify_mode = ssl.CERT_REQUIRED
        yield context


@asynccontextmanager
async def _serve(server, tls: TlsMaterial | None, *, mtls: bool = False):
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", server.handle)
    # No access log: it would record the paths a test sends to (the secrets of leak tests),
    # and those are the receiving tool's logs, not OmniKrux's.
    runner = web.AppRunner(app, shutdown_timeout=1, access_log=None)
    await runner.setup()
    try:
        with ExitStack() as stack:
            context = (
                stack.enter_context(_server_ssl(tls, require_client_cert=mtls)) if tls else None
            )
            site = web.TCPSite(runner, "127.0.0.1", 0, ssl_context=context)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            server.url = f"{'https' if tls else 'http'}://127.0.0.1:{port}"
            yield server
    finally:
        release = getattr(server, "release", None)
        if release is not None:
            release.set()
        await runner.cleanup()


@asynccontextmanager
async def serve_fake_prometheus(tls: TlsMaterial | None = None, *, mtls: bool = False):
    """A `FakePrometheus` on 127.0.0.1; HTTPS with `tls`, and a client certificate with `mtls`."""
    server = FakePrometheus()
    if mtls:
        server.require = ClientCert()
    async with _serve(server, tls, mtls=mtls):
        yield server


@asynccontextmanager
async def serve_fake_loki(tls: TlsMaterial | None = None, *, mtls: bool = False):
    server = FakeLoki()
    if mtls:
        server.require = ClientCert()
    async with _serve(server, tls, mtls=mtls):
        yield server


@asynccontextmanager
async def serve_fake_alertmanager(tls: TlsMaterial | None = None):
    server = FakeAlertmanager()
    async with _serve(server, tls):
        yield server


def grafana_answer(
    uid: str,
    title: str,
    *,
    folder: str | None = None,
    tags: tuple[str, ...] = (),
    version: int = 1,
    panels: list | None = None,
) -> dict:
    """A hand-written `/api/dashboards/uid/{uid}` answer, in the shape Grafana 11 to 13 send."""
    meta: dict = {"type": "db", "slug": title.lower().replace(" ", "-"), "version": version}
    if folder is not None:
        meta |= {"folderUid": f"f-{folder.lower()}", "folderTitle": folder}
    return {
        "dashboard": {
            "uid": uid,
            "title": title,
            "tags": list(tags),
            "version": version,
            "schemaVersion": 39,
            "panels": panels or [],
        },
        "meta": meta,
    }


@asynccontextmanager
async def serve_fake_grafana():
    server = FakeGrafana()
    async with _serve(server, None):
        yield server


class Canned:
    """A transport that answers every request the same, as a cluster's service proxy would."""

    def __init__(self, status: int, body: bytes = b"") -> None:
        from omnikrux.monitoring.sources.transport import TransportResponse

        self.answer = TransportResponse(status, body, "")

    async def request(self, method, path, **kwargs):
        return self.answer
