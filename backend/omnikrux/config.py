import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OMNIKRUX_")

    data_dir: Path = Path(".omnikrux-data")
    database_url: str | None = None
    secret_key: str | None = None
    in_container: bool = False
    kubeconfig: str | None = None
    static_dir: Path | None = None

    @property
    def db_url(self) -> str:
        return self.database_url or f"sqlite+aiosqlite:///{self.data_dir}/omnikrux.db"

    @property
    def kubeconfig_paths(self) -> list[Path]:
        if self.kubeconfig is None:
            default = Path("/kube/config") if self.in_container else Path.home() / ".kube" / "config"
            return [default]
        return [Path(p) for p in self.kubeconfig.split(os.pathsep) if p]


@lru_cache
def get_settings() -> Settings:
    return Settings()
