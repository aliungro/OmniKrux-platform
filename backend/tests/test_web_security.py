from types import SimpleNamespace

import pytest

from omnikrux.web_security import is_cross_origin


def ws(**headers):
    return SimpleNamespace(headers=headers)


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"host": "localhost:8080"}, False),  # no Origin: not a browser
        ({"host": "localhost:8080", "origin": "http://localhost:8080"}, False),
        ({"host": "LOCALHOST:8080", "origin": "http://localhost:8080"}, False),
        ({"host": "localhost:8080", "origin": "http://evil.example"}, True),
        ({"host": "localhost:8080", "origin": "http://localhost:9090"}, True),
        ({"origin": "http://localhost:8080"}, True),  # an Origin but no Host: refuse
    ],
)
def test_is_cross_origin(headers, expected):
    assert is_cross_origin(ws(**headers)) is expected
