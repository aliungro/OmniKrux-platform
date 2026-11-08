import pytest

from omnikrux.resources.quantity import parse_bytes, parse_cpu_m


@pytest.mark.parametrize(
    "text,expected",
    [("250m", 250), ("1", 1000), ("1.5", 1500), ("1234567n", 2), ("500u", 1), ("1e3", 1_000_000)],
)
def test_cpu_quantity_parsing(text, expected):
    assert parse_cpu_m(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("12345Ki", 12641280),
        ("1Gi", 1073741824),
        ("100M", 100000000),
        ("1e3", 1000),
        ("129e6", 129000000),
        ("1k", 1000),
        ("1E", 10**18),
        ("1500m", 2),
        ("0", 0),
    ],
)
def test_quantity_parsing(text, expected):
    assert parse_bytes(text) == expected


@pytest.mark.parametrize("junk", ["", "abc", "1Zi", "Mi", "1 Gi x", "--1", "1.2.3"])
def test_junk_quantities_raise(junk):
    with pytest.raises(ValueError):
        parse_bytes(junk)
    with pytest.raises(ValueError):
        parse_cpu_m(junk)


@pytest.mark.parametrize("huge", ["1e999999999", "1e-999999999", "9" * 40 + "e99999999999"])
def test_absurd_exponents_raise_value_error(huge):
    with pytest.raises(ValueError):
        parse_bytes(huge)
    with pytest.raises(ValueError):
        parse_cpu_m(huge)
