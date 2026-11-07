"""Kubernetes resource quantities as plain integers: CPU in millicores, memory in bytes."""

import math
import re
from decimal import Decimal

_NUMBER = r"(?P<num>(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"
_CPU = re.compile(rf"^{_NUMBER}(?P<suffix>[num])?$")
_BYTES = re.compile(rf"^{_NUMBER}(?P<suffix>Ki|Mi|Gi|Ti|Pi|Ei|[kMGTPEm])?$")

_CPU_MILLIS = {
    None: Decimal(1000),
    "m": Decimal(1),
    "u": Decimal("0.001"),
    "n": Decimal("0.000001"),
}
_BYTE_UNITS = {
    None: Decimal(1),
    "m": Decimal("0.001"),
    "k": Decimal(10) ** 3,
    "M": Decimal(10) ** 6,
    "G": Decimal(10) ** 9,
    "T": Decimal(10) ** 12,
    "P": Decimal(10) ** 15,
    "E": Decimal(10) ** 18,
    "Ki": Decimal(2) ** 10,
    "Mi": Decimal(2) ** 20,
    "Gi": Decimal(2) ** 30,
    "Ti": Decimal(2) ** 40,
    "Pi": Decimal(2) ** 50,
    "Ei": Decimal(2) ** 60,
}


def _parse(q: str, pattern: re.Pattern[str], units: dict[str | None, Decimal], what: str) -> int:
    match = pattern.match(q.strip()) if isinstance(q, str) else None
    if match is None:
        raise ValueError(f"not a {what} quantity: {q!r}")
    return math.ceil(Decimal(match["num"]) * units[match["suffix"]])


def parse_cpu_m(q: str) -> int:
    """Millicores, rounded up: `250m` is 250, `1.5` is 1500, `1234567n` is 2."""
    return _parse(q, _CPU, _CPU_MILLIS, "CPU")


def parse_bytes(q: str) -> int:
    """Bytes, rounded up: `1Gi`, `100M`, `1e3`."""
    return _parse(q, _BYTES, _BYTE_UNITS, "memory")
