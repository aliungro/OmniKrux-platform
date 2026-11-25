"""A webhook receiver to run by hand for live checks of alert notifications.

    python -m tests.monitoring.webhook_receiver --port 9911

Prints one line per request, `<time> <path> <first 200 characters of the body>`, and answers 200.
Nothing else: no headers, no query string and no other behaviour. It does print the request path,
so never point a real secret URL (a Slack-style webhook, say) at it. It listens on 127.0.0.1 unless
`--host` says otherwise (then it prints a note: it is for local fakes only).
"""

import argparse
import sys
from collections.abc import Callable
from datetime import UTC, datetime

from aiohttp import web

LOOPBACK = "127.0.0.1"
PREVIEW = 200


def exposure_note(host: str) -> str | None:
    """A one-line warning when `host` listens beyond this machine, else None."""
    if host in (LOOPBACK, "localhost", "::1"):
        return None
    return (
        f"Listening on {host}: reachable beyond this machine. "
        "For local fakes only; never send it real secrets or URLs."
    )


def make_app(emit: Callable[[str], object] = print) -> web.Application:
    async def handle(request: web.Request) -> web.Response:
        text = (await request.read()).decode(errors="replace")
        body = text.replace("\r", " ").replace("\n", " ")[:PREVIEW]
        stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        emit(f"{stamp} {request.path} {body}")
        return web.Response(text="ok")

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handle)
    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default=LOOPBACK)
    parser.add_argument("--port", type=int, default=9911)
    args = parser.parse_args(argv)
    host = args.host
    if note := exposure_note(host):
        print(note, flush=True)
    web.run_app(
        make_app(lambda line: print(line, flush=True)),
        host=host,
        port=args.port,
        print=lambda *_: None,
    )


if __name__ == "__main__":
    main(sys.argv[1:])
