from fastapi import FastAPI

from omnikrux.config import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    app = FastAPI(title="Omnikrux")
    app.state.settings = settings if settings is not None else get_settings()

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
