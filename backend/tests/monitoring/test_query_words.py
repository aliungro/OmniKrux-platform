"""A tool's parse and limit errors in plain words."""

from omnikrux.monitoring.query.words import plain_query_error


def prom(what: str) -> str:
    return plain_query_error("promql", f'invalid parameter "query": 1:32: parse error: {what}')


def loki(what: str) -> str:
    return plain_query_error("logql", f"parse error at line 1, col 7: syntax error: {what}")


def test_promql_parse_errors_read_plainly():
    assert prom("unclosed left parenthesis") == (
        "The query doesn't read at line 1, column 32: a bracket is never closed."
    )
    assert prom('unknown function with name "rat"').endswith("there is no function named rat.")
    assert prom('unexpected identifier "foo"').endswith('"foo" isn\'t expected there.')
    assert prom("something new here").endswith("column 32: something new here.")


def test_logql_parse_errors_read_plainly():
    assert loki("unexpected $end, expecting } or ,") == (
        "The query doesn't read at line 1, column 7: the selector isn't closed with }."
    )
    assert loki("unexpected IDENTIFIER").endswith("column 7: unexpected IDENTIFIER.")


def test_loki_range_limit_says_the_limit():
    def limit(lim: str) -> str:
        return plain_query_error(
            "logql", f"the query time range exceeds the limit (query length: 800h, limit: {lim})"
        )

    assert limit("30d1h") == (
        "This Loki answers at most 30 days per query. Pick a shorter time range."
    )
    assert "30 days" in limit("721h")
    assert "at most 1 day per" in limit("24h")


def test_unknown_errors_pass_through():
    for language in ("promql", "logql"):
        assert plain_query_error(language, "parse error: unexpected thing") == (
            "parse error: unexpected thing"
        )
        assert plain_query_error(language, "") == ""
    assert plain_query_error("promql", "the query time range exceeds the limit (x)") == (
        "the query time range exceeds the limit (x)"
    )


def test_a_filtered_query_drops_the_position():
    text = 'invalid parameter "query": 1:32: parse error: unclosed left parenthesis'
    assert plain_query_error("promql", text, positioned=False) == (
        "The query doesn't read: a bracket is never closed."
    )
    logql = "parse error at line 1, col 7: syntax error: unexpected $end, expecting } or ,"
    assert plain_query_error("logql", logql, positioned=False) == (
        "The query doesn't read: the selector isn't closed with }."
    )
