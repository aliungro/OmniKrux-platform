"""Where each Grafana panel sits: old rows, gridPos, and a placement that never overlaps."""

import math
import re

GRID = 24
MAX_Y = 999
_PX = re.compile(r"\s*([0-9]+(?:\.[0-9]+)?)\s*(?:px)?\s*")


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        n = float(value)
    except OverflowError:
        return None
    return n if math.isfinite(n) and abs(n) <= 1e9 else None  # beyond this is not a size


def _clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


def _round(n: float) -> int:
    return math.floor(n + 0.5)


def _px(value: object) -> float | None:
    n = _number(value)
    if n is not None:
        return n
    if isinstance(value, str):
        m = _PX.fullmatch(value)
        if m:
            return float(m.group(1))
    return None


def rows_layout(rows: list) -> list[tuple[dict, dict]]:
    """Panels of a Grafana 4 dashboard (rows of spans) with a tentative grid layout."""
    out: list[tuple[dict, dict]] = []
    y = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_px = _px(row.get("height"))
        row_px = 250.0 if row_px is None else row_px
        panels = row.get("panels")
        x, top, bottom = 0, y, y
        for p in panels if isinstance(panels, list) else []:
            if not isinstance(p, dict):
                continue
            height_px = _px(p.get("height"))
            ph = _clamp(_round((height_px if height_px is not None else row_px) / 30), 2, 40)
            span = _number(p.get("span"))
            w = _clamp(_round((min(span, 100) if span else 12) * 2), 2, GRID)
            if x + w > GRID:
                x = 0
                top = bottom
            out.append((p, {"x": x, "y": top, "w": w, "h": ph}))
            x += w
            bottom = max(bottom, top + ph)
        y = bottom
    return out


def grid_pos(raw: object) -> dict:
    """A Grafana gridPos as a layout inside the grid; anything odd takes the default."""
    pos = raw if isinstance(raw, dict) else {}

    def whole(key: str, default: int) -> int:
        n = _number(pos.get(key))
        return int(n) if n else default  # 0 and missing both take the default

    w = _clamp(whole("w", 12), 2, GRID)
    h = _clamp(whole("h", 8), 2, 40)
    xn = _number(pos.get("x"))
    yn = _number(pos.get("y"))
    x = _clamp(int(xn) if xn else 0, 0, GRID - w)
    y = _clamp(int(yn) if yn else 0, 0, MAX_Y)
    return {"x": x, "y": y, "w": w, "h": h}


def _overlaps(a: dict, b: dict) -> bool:
    return (
        a["x"] < b["x"] + b["w"]
        and b["x"] < a["x"] + a["w"]
        and a["y"] < b["y"] + b["h"]
        and b["y"] < a["y"] + a["h"]
    )


def place(items: list[tuple[int, dict]]) -> list[tuple[int, dict]]:
    """Move panels apart (down) and then up into free space; the result is in (y, x) order.
    A panel that would end below the last row is left out."""
    placed: list[tuple[int, dict]] = []
    for index, layout in sorted(items, key=lambda it: (it[1]["y"], it[1]["x"], it[0])):
        cur = dict(layout)
        while cur["y"] <= MAX_Y:
            hit = [o for _, o in placed if _overlaps(cur, o)]
            if not hit:
                break
            cur["y"] = max(o["y"] + o["h"] for o in hit)  # the first row below what is in the way
        if cur["y"] > MAX_Y:
            continue
        above = [
            o["y"] + o["h"]
            for _, o in placed
            if o["x"] < cur["x"] + cur["w"]
            and cur["x"] < o["x"] + o["w"]
            and o["y"] + o["h"] <= cur["y"]
        ]
        cur["y"] = max(above, default=0)  # as high as the panels above it allow
        placed.append((index, cur))
    return sorted(placed, key=lambda it: (it[1]["y"], it[1]["x"], it[0]))


def compact(panels: list[dict]) -> list[dict]:
    """The editor's compaction over panel documents: sorted by y then x, each floated up while
    nothing is in its way. A panel that doesn't move keeps its layout object."""
    if not all(isinstance(p.get("layout"), dict) for p in panels):
        return panels  # a partial document has nothing to float
    placed: list[dict] = []
    for p in sorted(panels, key=lambda q: (q["layout"]["y"], q["layout"]["x"])):
        lay = p["layout"]
        y = lay["y"]
        while y > 0 and not any(_overlaps({**lay, "y": y - 1}, q["layout"]) for q in placed):
            y -= 1
        if y != lay["y"]:
            p["layout"] = {**lay, "y": y}
        placed.append(p)
    return placed
