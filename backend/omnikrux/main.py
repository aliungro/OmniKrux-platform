from typing import Any

from fastapi import FastAPI


def create_app(settings: Any | None = None) -> FastAPI:
    # `settings` becomes a typed Settings object in Task 2.
    app = FastAPI(title="Omnikrux")
    app.state.settings = settings

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
