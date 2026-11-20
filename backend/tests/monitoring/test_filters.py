"""A project's label filter reaches every PromQL and LogQL selector, or the query is refused."""

import pytest

from omnikrux.monitoring.query.filters import (
    FilterError,
    Matcher,
    inject_logql,
    inject_promql,
    matchers_from_json,
    matchers_json,
    parse_matchers,
    render_matchers,
)

M = (Matcher("cluster", "=", "a"),)

UNREADABLE = "The query has an unclosed quote or bracket."
BAD_FILTER = 'Use label matchers like cluster="prod-east", separated by commas.'
NO_NAME = "A filter can't select by metric name."


def X(q: str) -> str:
    return inject_promql(q, M)


@pytest.mark.parametrize(
    "query, expected",
    [
        ("up", 'up{cluster="a"}'),
        ('up{job="x"}', 'up{job="x",cluster="a"}'),
        ("up{}", 'up{cluster="a"}'),
        ('{__name__=~"node_.*"}', '{__name__=~"node_.*",cluster="a"}'),
        (
            "sum by (job) (rate(http_requests_total[5m]))",
            'sum by (job) (rate(http_requests_total{cluster="a"}[5m]))',
        ),
        ("sum without(instance)(up)", 'sum without(instance)(up{cluster="a"})'),
        (
            "a / on(instance) group_left(node) b",
            'a{cluster="a"} / on(instance) group_left(node) b{cluster="a"}',
        ),
        ("rate(x[5m] offset 1h)", 'rate(x{cluster="a"}[5m] offset 1h)'),
        ("max_over_time(up[1h:5m])", 'max_over_time(up{cluster="a"}[1h:5m])'),
        (
            'label_replace(up, "dst", "$1", "src", "(.*)")',
            'label_replace(up{cluster="a"}, "dst", "$1", "src", "(.*)")',
        ),
        (
            'histogram_quantile(0.95, sum(rate(h_bucket{le!=""}[5m])) by (le))',
            'histogram_quantile(0.95, sum(rate(h_bucket{le!="",cluster="a"}[5m])) by (le))',
        ),
        ("up @ start()", 'up{cluster="a"} @ start()'),
        ("count(up) > bool 0", 'count(up{cluster="a"}) > bool 0'),
        ("topk(3, x) and on() y", 'topk(3, x{cluster="a"}) and on() y{cluster="a"}'),
        ("x > Inf", 'x{cluster="a"} > Inf'),
        ("up # all {targets}", 'up{cluster="a"} # all {targets}'),
        ('up{job=~"a{2}"}', 'up{job=~"a{2}",cluster="a"}'),
        ("1 + 2", "1 + 2"),
        ("vector(1)", "vector(1)"),
    ],
)
def test_inject_promql(query, expected):
    assert inject_promql(query, M) == expected


@pytest.mark.parametrize("query", ['up{job="x}', "rate(up[5m)", 'up{job="x"'])
def test_inject_promql_refuses_what_it_cannot_read(query):
    with pytest.raises(FilterError) as caught:
        inject_promql(query, M)
    assert str(caught.value) == UNREADABLE


@pytest.mark.parametrize(
    "query, expected",
    [
        # Recording-rule names carry colons; numbers and durations are never metric names.
        ("job:http_requests:rate5m", 'job:http_requests:rate5m{cluster="a"}'),
        ("x * 1e3 + 0x1f - .5 + NaN", 'x{cluster="a"} * 1e3 + 0x1f - .5 + NaN'),
        ("rate(x[1h30m:1m])", 'rate(x{cluster="a"}[1h30m:1m])'),
        # Space between a metric and its braces, a trailing comma, quoted names.
        ('up {job="x"}', 'up {job="x",cluster="a"}'),
        ('up{job="x",}', 'up{job="x",cluster="a"}'),
        ('{"my.metric", job="x"}', '{"my.metric", job="x",cluster="a"}'),
        # Strings of every kind hide braces and quotes; a raw string has no escapes.
        ("up{job='a\"}'}", 'up{job=\'a"}\',cluster="a"}'),
        (
            'label_join(up, "d", ",", "a") + x',
            'label_join(up{cluster="a"}, "d", ",", "a") + x{cluster="a"}',
        ),
        ("f(`\\`) + up", 'f(`\\`) + up{cluster="a"}'),
        # Every selector across lines and comments.
        ('up # "quote\n+ down', 'up{cluster="a"} # "quote\n+ down{cluster="a"}'),
        ("SUM BY (job) (up)", 'SUM BY (job) (up{cluster="a"})'),
        ("sum by (job) # c\n (up)", 'sum by (job) # c\n (up{cluster="a"})'),
        # A keyword where an operand belongs is a metric name to Prometheus: filter it.
        ("rate(offset[5m])", 'rate(offset{cluster="a"}[5m])'),
        ("sum(and)", 'sum(and{cluster="a"})'),
        ("by", 'by{cluster="a"}'),
        ("bool", 'bool{cluster="a"}'),
        ("a + without", 'a{cluster="a"} + without{cluster="a"}'),
        ("a or on(x) b", 'a{cluster="a"} or on(x) b{cluster="a"}'),
        (
            "a unless ignoring(x) group_right b",
            'a{cluster="a"} unless ignoring(x) group_right b{cluster="a"}',
        ),
        (
            "x atan2 y offset -5m @ 1609746000",
            'x{cluster="a"} atan2 y{cluster="a"} offset -5m @ 1609746000',
        ),
    ],
)
def test_inject_promql_more_shapes(query, expected):
    assert X(query) == expected


def test_inject_promql_renders_every_matcher():
    ms = (Matcher("cluster", "=", "a"), Matcher("ns", "=~", 'x"y'))
    assert inject_promql("up", ms) == 'up{cluster="a",ns=~"x\\"y"}'


@pytest.mark.parametrize(
    "query",
    [
        "sum(up",
        "up)",
        "up}",
        "rate(up[5m]",
        "x[5m{a}]",
        "up{a={b}}",
        "sum by (a{b}) (up)",
        "f(`x)",
        "x + 'y",
    ],
)
def test_inject_promql_refuses_more_shapes(query):
    with pytest.raises(FilterError):
        X(query)


@pytest.mark.parametrize(
    "query, expected",
    [
        ('{app="api"}', '{app="api",cluster="a"}'),
        (
            '{app="api"} |= "error" | json | line_format "{{.msg}}"',
            '{app="api",cluster="a"} |= "error" | json | line_format "{{.msg}}"',
        ),
        (
            'sum by (app) (rate({app=~".+"}[5m]))',
            'sum by (app) (rate({app=~".+",cluster="a"}[5m]))',
        ),
        (
            '{app="api"} | regexp `(?P<x>{a})`',
            '{app="api",cluster="a"} | regexp `(?P<x>{a})`',
        ),
    ],
)
def test_inject_logql(query, expected):
    assert inject_logql(query, M) == expected


@pytest.mark.parametrize(
    "query, expected",
    [
        ("{}", '{cluster="a"}'),
        (
            'count_over_time({a="1"}[5m]) / count_over_time({a="2"}[5m])',
            'count_over_time({a="1",cluster="a"}[5m]) / count_over_time({a="2",cluster="a"}[5m])',
        ),
        # A quote inside a comment must not hide the next line's selector.
        (
            'count_over_time({a="1"}[5m]) # "\n+ count_over_time({a="2"}[5m]) # "',
            'count_over_time({a="1",cluster="a"}[5m]) # "\n+ count_over_time({a="2",cluster="a"}[5m]) # "',
        ),
        ('{a="x}"} |~ `\\`', '{a="x}",cluster="a"} |~ `\\`'),
        # Loki's scanner also reads '...' literals and Go comments: a quote in one hides nothing.
        (
            'count_over_time({a="1"} |= \'"\' [5m]) + count_over_time({b="2"} |= \'"\' [5m])',
            (
                'count_over_time({a="1",cluster="a"} |= \'"\' [5m])'
                ' + count_over_time({b="2",cluster="a"} |= \'"\' [5m])'
            ),
        ),
        (
            'count_over_time({a="1"}[5m]) /* " */ + count_over_time({b="2"}[5m]) // "',
            (
                'count_over_time({a="1",cluster="a"}[5m]) /* " */'
                ' + count_over_time({b="2",cluster="a"}[5m]) // "'
            ),
        ),
        ('{a="1"} // "\n+ {b="2"}', '{a="1",cluster="a"} // "\n+ {b="2",cluster="a"}'),
    ],
)
def test_inject_logql_more_shapes(query, expected):
    assert inject_logql(query, M) == expected


@pytest.mark.parametrize(
    "query",
    ['{app="api}', '{app="api"', 'app="api"}', "{a={b}}", 'rate({a="b"}[5m]', '{a="b"} /* x'],
)
def test_inject_logql_refuses_what_it_cannot_read(query):
    with pytest.raises(FilterError) as caught:
        inject_logql(query, M)
    assert str(caught.value) == UNREADABLE


def test_empty_filter_changes_nothing():
    assert inject_promql("up", ()) == "up" and inject_logql('{a="b"}', ()) == '{a="b"}'


def test_parse_and_render_round_trip():
    ms = parse_matchers('cluster="prod-east", namespace=~"api|web"')
    assert ms == (Matcher("cluster", "=", "prod-east"), Matcher("namespace", "=~", "api|web"))
    assert render_matchers(ms) == 'cluster="prod-east",namespace=~"api|web"'
    assert parse_matchers('{cluster="a"}') == (Matcher("cluster", "=", "a"),)
    assert render_matchers((Matcher("x", "=", 'a"b\\c'),)) == 'x="a\\"b\\\\c"'


def test_parse_reads_every_operator_escape_and_empty_input():
    assert parse_matchers('a="1",b!="2" , c=~"3",d!~"4"') == (
        Matcher("a", "=", "1"),
        Matcher("b", "!=", "2"),
        Matcher("c", "=~", "3"),
        Matcher("d", "!~", "4"),
    )
    assert parse_matchers('x="a\\"b\\\\c\\nd"') == (Matcher("x", "=", 'a"b\\c\nd'),)
    assert render_matchers((Matcher("x", "=", "a\nb"),)) == 'x="a\\nb"'
    assert parse_matchers("") == () and parse_matchers("  ") == () and parse_matchers("{ }") == ()
    ms = (Matcher("x", "=", 'a"b\\c\nd'), Matcher("_y", "!~", ""))
    assert parse_matchers(render_matchers(ms)) == ms


@pytest.mark.parametrize(
    "bad", ["cluster", "cluster=prod", '1x="a"', '__name__="up"', 'a="b" c="d"']
)
def test_parse_refuses(bad):
    with pytest.raises(FilterError):
        parse_matchers(bad)


@pytest.mark.parametrize(
    "bad",
    [
        "cluster",
        "cluster=prod",
        '1x="a"',
        'a="b" c="d"',
        'a="b",',
        '{a="b"',
        'a=="b"',
        'a="b\\d"',
        'a="b',
    ],
)
def test_parse_refusal_says_what_to_write(bad):
    with pytest.raises(FilterError) as caught:
        parse_matchers(bad)
    assert str(caught.value) == BAD_FILTER


def test_parse_refuses_metric_name():
    with pytest.raises(FilterError) as caught:
        parse_matchers('__name__="up"')
    assert str(caught.value) == NO_NAME


def test_filter_error_is_a_value_error():
    assert issubclass(FilterError, ValueError)


def test_matchers_json_round_trip():
    ms = (Matcher("cluster", "=", "prod-east"), Matcher("ns", "!~", 'a"b'))
    assert matchers_from_json(matchers_json(ms)) == ms
    assert matchers_from_json(matchers_json(())) == ()


# --- Review fixes: comment ends, non-ASCII input, MetricsQL `or`, stored metric names ----------

SELECTOR = (
    "The query has a selector OmniKrux can't filter. Write its label matchers separated by commas."
)


@pytest.mark.parametrize(
    "query, expected",
    [
        # Prometheus ends a line comment at "\r" as well as "\n": what follows is query again.
        ("up # x\r or y", 'up{cluster="a"} # x\r or y{cluster="a"}'),
        ('up # "\r+ y', 'up{cluster="a"} # "\r+ y{cluster="a"}'),
        ("sum by (job) # c\r (up)", 'sum by (job) # c\r (up{cluster="a"})'),
        ('up{job="x" # "\r}', 'up{job="x" # "\r,cluster="a"}'),
    ],
)
def test_promql_comment_ends_at_carriage_return(query, expected):
    assert X(query) == expected


def test_logql_comment_ends_only_at_newline():
    # Loki reads to "\n": a "\r" stays inside the comment, so the selector after it is comment.
    assert inject_logql('{a="1"} # x\r{b="2"}', M) == '{a="1",cluster="a"} # x\r{b="2"}'
    assert inject_logql('{a="1"} # x\n{b="2"}', M) == '{a="1",cluster="a"} # x\n{b="2",cluster="a"}'


NON_ASCII = [
    "up + ²",
    "²",
    "up + ٣",
    "x[٣m]",
    ".²",
    "up + x",
    "up or x",
    'up{a="1"} ²',
    "up #   or y",
    '²{a="1"}',
]

_RUN_ALL = """
import json, sys
from omnikrux.monitoring.query.filters import FilterError, Matcher, inject_logql, inject_promql
M = (Matcher("cluster", "=", "a"),)
out = {}
for name, inject in (("promql", inject_promql), ("logql", inject_logql)):
    for q in json.loads(sys.argv[1]):
        try:
            out[name + " " + q] = inject(q, M)
        except FilterError:
            out[name + " " + q] = None
print(json.dumps(out))
"""


def test_non_ascii_input_never_hangs():
    # In a child process with a timeout: a scanner that stops advancing fails the test instead of
    # blocking the run.
    import json
    import subprocess
    import sys

    done = subprocess.run(
        [sys.executable, "-c", _RUN_ALL, json.dumps(NON_ASCII)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=True,
    )
    results = json.loads(done.stdout)
    assert len(results) == 2 * len(NON_ASCII)
    # A non-ASCII digit is no number: the metric next to it is still filtered.
    assert results["promql up + ²"] == 'up{cluster="a"} + ²'
    assert results['promql ²{a="1"}'] == '²{a="1",cluster="a"}'


@pytest.mark.parametrize(
    "query",
    [
        '{a="1" or b="2"}',
        'up{a="1" or b="2"}',
        'up{a="1" OR b="2"}',
        'up{a="1"or b="2"}',
        'up{a="1" b="2"}',
        'up{a="1" "b"}',
        'up{a b="1"}',
        "up{a=}",
        'up{a=="1"}',
        'up{="1"}',
        'up{,a="1"}',
        'up{a="1",,}',
        'up{a~"1"}',
    ],
)
@pytest.mark.parametrize("inject", [inject_promql, inject_logql])
def test_selector_with_anything_but_matchers_is_refused(inject, query):
    with pytest.raises(FilterError) as caught:
        inject(query, M)
    assert str(caught.value) == SELECTOR


@pytest.mark.parametrize(
    "query, expected",
    [
        ('{"a.b"="x"}', '{"a.b"="x",cluster="a"}'),
        ('up{ job = "x" , env !~ "y" }', 'up{ job = "x" , env !~ "y" ,cluster="a"}'),
        ('up{job="x", # note\n}', 'up{job="x", # note\ncluster="a"}'),
    ],
)
def test_selector_grammar_still_reads_valid_matchers(query, expected):
    assert X(query) == expected


def test_render_refuses_a_stored_metric_name():
    with pytest.raises(FilterError) as caught:
        render_matchers((Matcher("__name__", "=", "up"),))
    assert str(caught.value) == NO_NAME
    with pytest.raises(FilterError):
        inject_promql("up", (Matcher("__name__", "=~", ".+"),))
