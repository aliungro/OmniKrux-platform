"""Reading pasted text and telling what kind of file it is."""

import pytest

from omnikrux.monitoring.transfer.detect import (
    GRAFANA_LIST,
    MAX_IMPORT_BYTES,
    NOT_JSON,
    TOO_LARGE,
    UNKNOWN_FORMAT,
    detect_format,
    parse_import_text,
)
from omnikrux.monitoring.transfer.types import TransferError


def test_detects_each_shape():
    export = {"omnikrux": "monitoring-export", "formatVersion": 1}
    assert detect_format(export)[0] == "omnikrux_export"
    omni = {"schemaVersion": 1, "title": "A", "panels": [{"id": "p-1", "queries": []}]}
    assert detect_format(omni)[0] == "omnikrux_dashboard"
    fmt, inner = detect_format({"dashboard": {"title": "G", "panels": []}, "meta": {}})
    assert fmt == "grafana" and inner == {"title": "G", "panels": []}
    assert detect_format({"title": "Old", "rows": []})[0] == "grafana"
    new = {"title": "New", "schemaVersion": 39, "panels": [{"gridPos": {}}]}
    assert detect_format(new)[0] == "grafana"
    old = {"title": "G", "schemaVersion": 1, "panels": [{"gridPos": {}}]}
    assert detect_format(old)[0] == "grafana"
    assert detect_format({"title": "G", "schemaVersion": True, "panels": []})[0] == "grafana"


def test_refuses_what_it_cannot_read():
    cases = [([{}], GRAFANA_LIST), ({"hello": 1}, UNKNOWN_FORMAT), (7, UNKNOWN_FORMAT)]
    for value, message in cases:
        with pytest.raises(TransferError) as e:
            detect_format(value)
        assert e.value.message == message
        assert e.value.code in ("unknown_format", "invalid_input")
        assert e.value.status == 422


def test_parse_import_text_words():
    assert parse_import_text('{"a": [1, 2.5]}') == {"a": [1, 2.5]}
    with pytest.raises(TransferError) as e:
        parse_import_text('{"a": ')
    assert e.value.message.startswith("This isn't valid JSON: ")
    assert "line 1, column 7" in e.value.message and e.value.status == 422
    assert e.value.message.endswith("Check that the whole file or text was copied.")
    for text in ('{"a": NaN}', "[Infinity]", "[-Infinity]"):
        with pytest.raises(TransferError) as e:
            parse_import_text(text)
        assert e.value.code == "invalid_input"
        assert e.value.message.startswith(NOT_JSON.split("{")[0])
    with pytest.raises(TransferError) as e:
        parse_import_text("[" * 100_000)
    assert e.value.code == "invalid_input"
    with pytest.raises(TransferError) as e:
        parse_import_text(" " * (MAX_IMPORT_BYTES + 1))
    assert (e.value.status, e.value.code, e.value.message) == (413, "too_large", TOO_LARGE)
    assert parse_import_text(" " * (MAX_IMPORT_BYTES - 2) + "[]") == []


def test_schema_version_two_and_empty_panels():
    # A newer OmniKrux document is not mistaken for Grafana; the validator refuses it in words.
    newer = {"schemaVersion": 2, "title": "A", "panels": [{"id": "p-1", "queries": []}]}
    assert detect_format(newer)[0] == "omnikrux_dashboard"
    # Per the rule, schemaVersion 1 with no panels reads as an OmniKrux dashboard.
    assert (
        detect_format({"schemaVersion": 1, "title": "A", "panels": []})[0] == "omnikrux_dashboard"
    )
    assert detect_format({"schemaVersion": 39, "title": "A", "panels": []})[0] == "grafana"
    assert detect_format({"schemaVersion": 2, "title": "A", "panels": [1]})[0] == "grafana"
