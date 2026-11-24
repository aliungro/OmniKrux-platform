"""Grafana variables and query syntax in the converter."""

import json
import re
from pathlib import Path

import pytest

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import inject_logql, inject_promql
from omnikrux.monitoring.transfer.detect import detect_format
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext
from omnikrux.monitoring.transfer.grafana.expressions import convert_expr

FIXTURES = Path(__file__).parent / "grafana_fixtures"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text("utf-8"))


NO_CONTEXT = GrafanaContext()


def conv(name, ctx=NO_CONTEXT):
    return convert_grafana(detect_format(load(name))[1], ctx, key="d-1")


def where_what(c):
    return [(s.where, s.what) for s in c.skipped]


def convert_dashboard(templating, exprs=("up",)):
    d = {
        "title": "T",
        "templating": {"list": templating},
        "panels": [
            {
                "id": i,
                "type": "stat",
                "title": f"P{i}",
                "gridPos": {"x": 0, "y": i, "w": 4, "h": 2},
                "datasource": "Prom",
                "targets": [{"refId": "A", "expr": e}],
            }
            for i, e in enumerate(exprs, start=1)
        ],
    }
    return convert_grafana(d, GrafanaContext(), key="d")


def qvar(name, query="label_values(up, job)", **extra):
    return {"name": name, "type": "query", "datasource": "Prom", "query": query, **extra}


def test_expressions():
    known = frozenset({"instance", "namespace", "job"})
    assert convert_expr('x{i=~"[[instance]]"}', known).text == 'x{i=~"${instance}"}'
    r = convert_expr('x{n=~"${namespace:regex}"}', known)
    assert r.text == 'x{n=~"${namespace}"}'
    assert r.notes == (
        (
            "The :regex format of $namespace",
            "OmniKrux substitutes variables its own way, so the format was dropped.",
        ),
    )
    assert convert_expr("rate(x[$__auto])", known).text == "rate(x[$__interval])"
    assert convert_expr("rate(x[$__rate_interval])", known).text == "rate(x[$__rate_interval])"
    assert (
        convert_expr("increase(x[$__range_s])", known).reason
        == "Uses $__range_s, which OmniKrux doesn't have."
    )
    assert (
        convert_expr('x{e="$env"}', known).reason
        == "Uses $env, a Grafana variable OmniKrux couldn't copy."
    )
    plain = 'label_replace(up, "a", "$1", "b", "(.*)") > 0 and y{z=~"^a$|b"}'
    assert convert_expr(plain, known).text == plain


def test_variables_from_the_modern_fixture():
    c = conv("gridpos_v39_objects")
    assert [
        (
            v["name"],
            v["source"],
            v["labelName"],
            v["match"],
            v["multi"],
            v["includeAll"],
            v["default"],
        )
        for v in c.doc["variables"]
    ] == [
        (
            "namespace",
            {"type": "prometheus", "id": "grafana:var:ds"},
            "namespace",
            "kube_namespace_status_phase",
            True,
            True,
            ["api", "web"],
        ),
        (
            "pod",
            {"type": "prometheus", "id": "grafana:var:ds"},
            "pod",
            'kube_pod_info{namespace=~"$namespace"}',
            True,
            True,
            "all",
        ),
        (
            "app",
            {"type": "loki", "id": "grafana:uid:loki-main"},
            "app",
            '{namespace=~"$namespace"}',
            False,
            False,
            ["api"],
        ),
    ]
    assert {
        ("Variable $env", "A custom variable"),
        ("Variable $window", "A interval variable"),
        ('Panel "Env pods"', "Query A"),
        ('Panel "Env pods"', "The whole panel"),
        ('Panel "Mixed"', "Query C"),
    } <= set(where_what(c))
    assert c.doc["panels"][0]["queries"][0]["expr"] == (
        'sum by (namespace) (rate(container_cpu_usage_seconds_total{namespace=~"${namespace}"}'
        "[$__rate_interval]))"
    )
    assert c.doc["panels"][0]["queries"][0]["legend"] == ""
    assert {r.key for r in c.refs} >= {"grafana:var:ds", "grafana:uid:loki-main"}


def test_rows_fixture_variables_and_old_syntax():
    c = conv("rows_v14")
    assert (
        c.doc["variables"][0].items()
        >= {"name": "instance", "match": "node_uname_info", "default": "all"}.items()
    )
    assert "${instance}" in c.doc["panels"][0]["queries"][0]["expr"]


def test_variable_skips_have_their_words():
    c = convert_dashboard(
        [
            qvar("a", query="label_values(up, job)", regex="/prod.*/"),
            qvar("b", query="query_result(up)"),
            qvar("c", query='label_values(up{x="$later"}, job)'),
            qvar("later"),
            qvar("__bad"),
            qvar("d", query='label_values(up{x="$nothing"}, job)'),
            {
                "name": "e",
                "type": "query",
                "datasource": {"type": "mysql", "uid": "m"},
                "query": "label_values(job)",
            },
            {"name": "f", "type": "constant", "query": "1"},
        ]
    )
    assert [v["name"] for v in c.doc["variables"]] == ["a", "later"]
    got = {(s.where, s.what, s.reason) for s in c.skipped}
    regex_reason = "OmniKrux lists every value; the regex filter was dropped."
    assert ("Variable $a", "Its regex", regex_reason) in got
    only_label = "Only label_values(...) queries can become OmniKrux variables."
    assert ("Variable $b", "Its query", only_label) in got
    assert ("Variable $c", "Its query", "It uses a variable defined after it.") in got
    name_reason = "OmniKrux variable names use letters, digits and _ and don't start with __."
    assert ("Variable $__bad", "Its name", name_reason) in got
    unknown = "Uses $nothing, a Grafana variable OmniKrux couldn't copy."
    assert ("Variable $d", "Its query", unknown) in got
    assert ("Variable $e", "Its data source", "mysql variables aren't supported yet.") in got
    only_values = "Only label values variables are in OmniKrux."
    assert ("Variable $f", "A constant variable", only_values) in got


def test_a_variable_past_the_twentieth():
    c = convert_dashboard([qvar(f"v{i}") for i in range(22)])
    assert len(c.doc["variables"]) == 20
    assert ("Variable $v20", "A variable past the 20th") in where_what(c)


@pytest.mark.parametrize(
    "current, multi, include_all, want",
    [
        ({"value": "$__all"}, False, True, "all"),
        ({"value": ["$__all"]}, True, False, []),
        ({"value": ["a", "b"]}, True, False, ["a", "b"]),
        ({"value": "a"}, False, False, ["a"]),
        ({"value": ""}, False, False, []),
        (None, False, False, []),
    ],
)
def test_current_value_becomes_the_default(current, multi, include_all, want):
    v = qvar("x", multi=multi, includeAll=include_all)
    if current is not None:
        v["current"] = current
    c = convert_dashboard([v])
    assert c.doc["variables"][0]["default"] == want


def test_a_single_value_variable_keeps_one_start_value():
    c = convert_dashboard([qvar("x", current={"value": ["a", "b"]})])
    assert c.doc["variables"][0]["default"] == ["a"]
    assert ("Variable $x", "Its current value") in where_what(c)


def test_label_values_without_a_selector_and_definition_text():
    v = {"name": "x", "type": "query", "datasource": "Prom", "definition": "label_values(job)"}
    c = convert_dashboard([v])
    var = c.doc["variables"][0]
    assert (var["labelName"], var["match"]) == ("job", "")


@pytest.mark.parametrize(
    "name", ["rows_v14", "gridpos_v22_inputs", "gridpos_v39_objects", "api_wrapper_v38"]
)
def test_every_converted_query_takes_a_filter(name):
    c = conv(name)
    assert c.doc is not None

    def fill(text):
        text = re.sub(r"\$\{?(__interval|__rate_interval|__range)\}?", "2m", text)
        return re.sub(r"\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*", ".+", text)

    matchers = (Matcher("cluster", "=", "a"),)
    pairs = [(q["source"]["type"], q["expr"]) for p in c.doc["panels"] for q in p["queries"]]
    pairs += [(v["source"]["type"], v["match"]) for v in c.doc["variables"] if v["match"]]
    assert pairs
    for kind, expr in pairs:
        text = fill(expr)
        out = inject_logql(text, matchers) if kind == "loki" else inject_promql(text, matchers)
        assert 'cluster="a"' in out
