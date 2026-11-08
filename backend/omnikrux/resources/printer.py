"""A CRD's additionalPrinterColumns as table columns: the JSONPath subset those use, and a row
builder. Anything outside the subset shows "—" rather than guessing."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from omnikrux.resources.rows import ResourceRow, StatusClass, base_row, parse_ts


@dataclass(frozen=True)
class PrinterColumn:
    name: str
    json_path: str
    type: str  # the CRD's: string, integer, number, boolean, date
    priority: int = 0

    @property
    def key(self) -> str:
        return "pc_" + (re.sub(r"[^a-z0-9]+", "_", self.name.lower()).strip("_") or "column")


def printer_columns(crd_columns: list[dict]) -> list[PrinterColumn]:
    """The columns kubectl shows by default (priority 0), in the CRD's order, with unique keys."""
    out: list[PrinterColumn] = []
    seen: set[str] = set()
    for raw in crd_columns:
        name, path = raw.get("name"), raw.get("jsonPath")
        priority = raw.get("priority") or 0
        if not isinstance(name, str) or not isinstance(path, str) or priority != 0:
            continue
        column = PrinterColumn(name, path, str(raw.get("type") or "string"), 0)
        if column.key in seen:
            continue
        seen.add(column.key)
        out.append(column)
    return out


_TOKEN = re.compile(
    r"""\.(?P<field>[A-Za-z_][\w\-]*)
    |\[(?P<index>\d+)\]
    |\[(?P<star>\*)\]
    |\[\?\(@\.(?P<fkey>[A-Za-z_][\w\-]*)\s*==\s*(?:"(?P<dq>[^"]*)"|'(?P<sq>[^']*)')\)\]
    """,
    re.VERBOSE,
)


def json_path(obj: dict, expr: str) -> list | None:
    """The values at `expr` (`.a.b`, `.a[0]`, `.a[*].b`, `.a[?(@.k=="v")].b`); [] when nothing is
    there, None when the expression is outside that subset."""
    expr = expr.strip()
    if not expr.startswith(".") or expr == ".":
        return None
    steps: list[tuple[str, Any]] = []
    pos = 0
    while pos < len(expr):
        match = _TOKEN.match(expr, pos)
        if match is None:
            return None
        pos = match.end()
        if match["field"] is not None:
            steps.append(("field", match["field"]))
        elif match["index"] is not None:
            steps.append(("index", int(match["index"])))
        elif match["star"] is not None:
            steps.append(("star", None))
        else:
            value = match["dq"] if match["dq"] is not None else match["sq"]
            steps.append(("filter", (match["fkey"], value)))
    current: list = [obj]
    for kind, arg in steps:
        nxt: list = []
        for item in current:
            if kind == "field":
                if isinstance(item, dict) and arg in item:
                    nxt.append(item[arg])
            elif not isinstance(item, list):
                continue
            elif kind == "index":
                if arg < len(item):
                    nxt.append(item[arg])
            elif kind == "star":
                nxt.extend(item)
            else:
                key, want = arg
                nxt.extend(e for e in item if isinstance(e, dict) and e.get(key) == want)
        current = nxt
    return [v for v in current if v is not None]


def _text(value: Any) -> Any:
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, dict | list):
        return None  # not a printable cell
    return value


def _cell(column: PrinterColumn, values: list | None) -> Any:
    if not values:
        return None
    if column.type == "date" and isinstance(values[0], str):
        try:
            return parse_ts(values[0])
        except ValueError:
            return None
    cells = [c for v in values if (c := _text(v)) is not None]
    if not cells:
        return None
    if len(cells) == 1:
        return cells[0]
    return ",".join(str(c) for c in cells)


def _status_class(cell: Any) -> StatusClass:
    text = str(cell).lower() if cell is not None else ""
    return "ok" if text == "true" else "bad" if text == "false" else "warn"


def printer_row_builder(
    columns: list[PrinterColumn], *, kind: str = ""
) -> Callable[[dict, str], ResourceRow]:
    """A row builder with one `pc_` column per printer column. `kind` names the rows' kind (list
    items from typed endpoints carry none); an object's own `kind` is the fallback."""

    def build(obj: dict, cluster_id: str) -> ResourceRow:
        row = base_row(obj, cluster_id, kind or obj.get("kind") or "")
        for column in columns:
            cell = _cell(column, json_path(obj, column.json_path))
            row.columns[column.key] = cell
            if column.name in ("Ready", "Status"):
                row.columns["status"] = cell
                row.columns["status_class"] = _status_class(cell)
        return row

    return build
