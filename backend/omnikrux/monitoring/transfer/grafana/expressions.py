"""Grafana query text as OmniKrux query text: variable syntax and the built-in variables."""

import re
from dataclasses import dataclass

_TOKEN = re.compile(
    r"\[\[([A-Za-z_][A-Za-z0-9_]*)(?::([^\]]*))?\]\]"
    r"|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}"
    r"|\$([A-Za-z_][A-Za-z0-9_]*)"
)
_KEPT = ("__interval", "__rate_interval", "__range")
_FORMAT_DROPPED = "OmniKrux substitutes variables its own way, so the format was dropped."


@dataclass(frozen=True)
class ExprResult:
    text: str | None
    reason: str | None
    notes: tuple[tuple[str, str], ...] = ()


def convert_expr(expr: str, known: frozenset[str]) -> ExprResult:
    """`expr` with Grafana's variable syntax turned into OmniKrux's, or None and the reason
    when it uses a variable OmniKrux doesn't have."""
    notes: list[tuple[str, str]] = []
    problem: list[str] = []

    def swap(m: re.Match) -> str:
        if m.group(1) is not None:
            name, fmt, form = m.group(1), m.group(2), "[["
        elif m.group(3) is not None:
            name, fmt, form = m.group(3), m.group(4), "${"
        else:
            name, fmt, form = m.group(5), None, "$"
        if name == "__auto":
            return "$__interval"
        if name in _KEPT:
            return m.group(0) if form == "$" else f"${{{name}}}"
        if name.startswith("__"):
            problem.append(f"Uses ${name}, which OmniKrux doesn't have.")
            return m.group(0)
        if name not in known:
            problem.append(f"Uses ${name}, a Grafana variable OmniKrux couldn't copy.")
            return m.group(0)
        if fmt is not None:
            note = (f"The :{fmt} format of ${name}", _FORMAT_DROPPED)
            if note not in notes:
                notes.append(note)
        return m.group(0) if form == "$" else f"${{{name}}}"

    text = _TOKEN.sub(swap, expr)
    if problem:
        return ExprResult(None, problem[0], ())
    return ExprResult(text, None, tuple(notes))
