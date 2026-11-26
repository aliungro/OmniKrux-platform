"""The alert's query text: the browser's `interpolate` rules with each variable's default."""

import json
from pathlib import Path

import pytest

from omnikrux.monitoring.alerts.rule_expr import (
    RATE_INTERVAL_FLOOR,
    RuleExprError,
    condition_expr,
    duration_text,
    eval_expr,
    is_log_query,
    parse_duration,
    render_message,
    rule_expr,
    same_query_text,
    substitute,
    tidy_query,
    to_prometheus_template,
)
from omnikrux.monitoring.alerts.types import STATE_ORDER, Condition, worst
from omnikrux.monitoring.dashboards.schema import DashboardInvalid, validate_dashboard

EXPR_CASES = json.loads((Path(__file__).parent / "alert_expr_cases.json").read_text("utf-8"))
REQUIRED = {
    "plain",
    "multi_default_all",
    "multi_default_values",
    "single_default_value",
    "single_without_default",
    "rate_interval_30s",
    "rate_interval_1m",
    "rate_interval_5m",
    "interval",
    "range_refused",
    "unquoted_multi_refused",
    "multi_default_all_in_quotes",
}


def test_case_file_is_complete():
    names = [c["name"] for c in EXPR_CASES]
    assert len(names) == len(set(names)) and REQUIRED <= set(names)
    for c in EXPR_CASES:
        assert set(c) == {"name", "doc", "panel_id", "expected", "problem"}
        assert (c["expected"] is None) == (c["problem"] is not None)


@pytest.mark.parametrize("case", EXPR_CASES, ids=[c["name"] for c in EXPR_CASES])
def test_rule_expr_shared_cases(case):
    panel = next(p for p in case["doc"]["panels"] if p["id"] == case["panel_id"])
    if case["problem"] is None:
        assert rule_expr(case["doc"], panel) == case["expected"]
        validate_dashboard(case["doc"], owner_kind="project")
    else:
        with pytest.raises(RuleExprError) as e:
            rule_expr(case["doc"], panel)
        assert str(e.value) == case["problem"]
        # The document validator refuses the same text with the same words, at the alert's query.
        with pytest.raises(DashboardInvalid) as d:
            validate_dashboard(case["doc"], owner_kind="project")
        assert [(p.path, p.message) for p in d.value.problems] == [
            ("panels[0].alert.query", case["problem"])
        ]


def test_rate_interval_follows_the_charts_floor():
    assert RATE_INTERVAL_FLOOR == 240
    for every, seconds, shown in (("30s", 30, "4m"), ("1m", 60, "4m"), ("5m", 300, "20m")):
        assert substitute("$__rate_interval", {}, seconds) == shown, every
    assert substitute("$__interval", {}, 30) == "30s"


@pytest.mark.parametrize(
    "text, variables, expected",
    [
        ('x{a="$v"}', {"v": (False, ['q"1'])}, 'x{a="q\\"1"}'),
        ("x{a='$v'}", {"v": (False, ["it's"])}, "x{a='it\\'s'}"),
        ("x{a=`$v`}", {"v": (False, ["ok"])}, "x{a=`ok`}"),
        ("x{a=$v}", {"v": (False, ["ok.1:2"])}, "x{a=ok.1:2}"),
        ("x # $v", {"v": (False, [])}, "x # $v"),
        ('x{a="$nope"}', {}, 'x{a="$nope"}'),
        ('"\\" $v"', {"v": (False, ["a"])}, '"\\" a"'),
    ],
)
def test_substitute_quote_contexts(text, variables, expected):
    assert substitute(text, variables, 60) == expected


@pytest.mark.parametrize(
    "text, variables",
    [
        ("x{a=$v}", {"v": (False, ["has space"])}),
        ("x{a=`$v`}", {"v": (False, ["a`b"])}),
        ('x{a="$v"}\r$w', {"v": (False, ["a"])}),
    ],
)
def test_substitute_refusals(text, variables):
    with pytest.raises(RuleExprError):
        substitute(text, variables, 60)


def test_lone_return_words():
    with pytest.raises(RuleExprError) as e:
        substitute('x{a="$v"}\r', {"v": (False, ["a"])}, 60)
    assert str(e.value) == (
        "The query has a carriage return outside quotes, so $v can't be placed safely. "
        "Remove it, or start a new line instead."
    )
    # A Windows line break is not a lone return.
    assert substitute('x{a="$v"}\r\n', {"v": (False, ["a"])}, 60) == 'x{a="a"}\r\n'


def test_duration_helpers():
    assert parse_duration("0s") == 0 and parse_duration("24h") == 86400
    for bad in ("", "5", "05m", "1d", "-1s", "5m "):
        with pytest.raises(ValueError):
            parse_duration(bad)
    assert [duration_text(s) for s in (30, 60, 90, 300, 7200, 3660)] == [
        "30s",
        "1m",
        "90s",
        "5m",
        "2h",
        "61m",
    ]


def test_condition_and_eval_expr():
    c = Condition("each", "above", 0.3, 300, 60)
    assert condition_expr("rate(x[5m])", c) == "(rate(x[5m])) > 0.3"
    assert condition_expr("x", Condition("total", "below", 2.0, 0, 60)) == "sum(x) < 2"
    assert condition_expr("x", Condition("each", "below", -1.5, 0, 60)) == "(x) < -1.5"
    assert eval_expr("x", "total") == "sum(x)" and eval_expr("x", "each") == "x"


def test_the_wrapper_adds_no_line_break_around_the_query():
    each = Condition("each", "above", 0.0, 0, 60)
    assert condition_expr("vector(1)", each) == "(vector(1)) > 0"
    assert condition_expr("sum(up)", Condition("each", "below", 1.0, 0, 60)) == "(sum(up)) < 1"
    # A `#` inside a string is not a comment; one on an earlier line has ended already.
    assert condition_expr('up{a="#"}', each) == '(up{a="#"}) > 0'
    assert condition_expr("# why\nup", each) == "(# why\nup) > 0"


def test_a_trailing_comment_cannot_swallow_the_wrapper():
    each = condition_expr("up # note", Condition("each", "above", 0.3, 0, 60))
    total = condition_expr("up # note", Condition("total", "below", 2.0, 0, 60))
    assert each == "(up # note\n) > 0.3" and total == "sum(up # note\n) < 2"
    assert eval_expr("up # note", "total") == "sum(up # note\n)"


def test_is_log_query():
    assert is_log_query('  {app="api"} |= "x"') and not is_log_query("sum(rate(x[5m]))")


def _as_typed(template: str) -> str:
    """What Prometheus prints for the escaped text: the string actions, evaluated."""
    return template.replace('{{ "{{" }}', "{{").replace('{{ "}}" }}', "}}")


def test_templates():
    assert (
        to_prometheus_template("p95 for {{route}} is {{value}}")
        == "p95 for {{ $labels.route }} is {{ $value }}"
    )
    assert to_prometheus_template("{x} {{a}}") == "{x} {{ $labels.a }}"


@pytest.mark.parametrize(
    "text",
    ['{{ query "up" }}', "{{ .Labels }}", "a {{ b", "a }} b", "{{{value}}}", "{{ range . }}"],
)
def test_other_template_text_is_written_as_typed(text):
    out = to_prometheus_template(text)
    assert _as_typed(out) == text
    assert render_message(text, {}, None) == text


def test_template_actions_never_survive_outside_the_placeholders():
    out = to_prometheus_template('{{ query "up" | first | value }} {{value}}')
    assert out.endswith("{{ $value }}")
    assert out.startswith('{{ "{{" }} query "up" | first | value {{ "}}" }}')


MESSAGE_CASES = json.loads((Path(__file__).parent / "alert_message_cases.json").read_text("utf-8"))


@pytest.mark.parametrize("case", MESSAGE_CASES, ids=[c["name"] for c in MESSAGE_CASES])
def test_render_message_shared_cases(case):
    assert render_message(case["message"], case["labels"], case["value"]) == case["expected"]


def test_message_case_file_pins_the_number_format():
    shown = {c["name"]: c["expected"] for c in MESSAGE_CASES}
    assert shown["small_has_no_exponent"] == "0.0000123"
    assert shown["huge_has_no_exponent"] == "1" + "0" * 21
    assert shown["no_value_is_a_dash"] == "–"


def test_worst():
    assert worst(["ok", "pending", "unreachable"]) == "unreachable" and worst([]) == "ok"
    assert worst(["paused", "ok"]) == "ok"
    assert STATE_ORDER[0] == "firing" and STATE_ORDER[-1] == "paused"


def test_rule_query_is_wrapped_without_stray_lines():
    typed = "\n\n  count(up == 1)\n\n   \n  # still up\n\n"
    each = Condition("each", "above", 0.0, 0, 60)
    assert condition_expr(typed, each) == "(count(up == 1)\n  # still up\n) > 0"
    assert condition_expr("count(up == 1)\n\n\n", each) == "(count(up == 1)) > 0"
    assert eval_expr("\n sum(x)\n\n", "total") == "sum(sum(x))"
    assert eval_expr("\n sum(x)\n\n", "each") == "sum(x)"


def test_a_raw_string_keeps_its_blank_lines():
    each = Condition("each", "above", 0.0, 0, 60)
    typed = '\n\nup{path=~`a\n\n  \nb`}\n\n# "`" in a comment\n\n'
    assert condition_expr(typed, each) == '(up{path=~`a\n\n  \nb`}\n# "`" in a comment\n) > 0'
    assert tidy_query('x{a="`"}\n\ny') == 'x{a="`"}\ny'


def test_a_stored_text_is_the_same_query_whatever_its_spacing():
    assert same_query_text("(\n  count(up == 1)\n\n\n) > 0", "(count(up == 1)\n) > 0")
    assert same_query_text("(up # a note\n) > 0", "(up  # a note\n\n) > 0")
    assert not same_query_text('(up{a="x  y"}\n) > 0', '(up{a="x y"}\n) > 0')
    assert not same_query_text("(a or b\n) > 0", "(aorb\n) > 0")
    assert not same_query_text("(up\n) > 0", "(up\n) > 1")
