"""A webhook receiver to run by hand for live checks of alert notifications.

    python -m tests.monitoring.webhook_receiver --port 9911

Prints one line per request, `<time> <path> <first 200 characters of the body>`, and answers 200.
Nothing else: no headers, no query string (either may carry a token) and no other behaviour. It
binds to 127.0.0.1 only; any other `--host` is refused.
"""

import argparse
import sys
from collections.abc import Callable
from datetime import UTC, datetime

from aiohttp import web

LOOPBACK = "127.0.0.1"
PREVIEW = 200


def check_host(host: str) -> str:
    if host != LOOPBACK:
        raise SystemExit(f"The receiver binds to {LOOPBACK} only, not {host!r}.")
    return host


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
    host = check_host(args.host)
    web.run_app(
        make_app(lambda line: print(line, flush=True)),
        host=host,
        port=args.port,
        print=lambda *_: None,
    )


if __name__ == "__main__":
    main(sys.argv[1:])
