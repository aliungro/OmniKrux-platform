"""Who may do what: the one hook every cluster-touching operation asks first.

v1 has no roles (spec §5.4), so everything is allowed; roles plug in here later. Callers look
it up as `authz.authorize` at call time, so it can be swapped."""


class NotAllowed(Exception):
    """The actor may not do this; `message` says so in plain words (answered with 403)."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


async def authorize(
    actor: str,
    action: str,
    cluster_id: str,
    namespace: str | None,
    kind_key: str | None,
    name: str | None,
) -> None:
    """Raise NotAllowed when `actor` may not do `action` on that object. Allows everything."""
