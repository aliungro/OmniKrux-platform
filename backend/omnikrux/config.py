import os
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Host headers the console answers to (DNS-rebinding guard). "*.localhost" allows any subdomain.
DEFAULT_ALLOWED_HOSTS = ("localhost", "127.0.0.1", "[::1]", "*.localhost")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OMNIKRUX_")

    data_dir: Path = Path(".omnikrux-data")
    database_url: str | None = None
    secret_key: str | None = None
    in_container: bool = False
    # Point 127.0.0.1-style kubeconfig servers at host.docker.internal. Unset: on in a container.
    # Turn off with --network host on Linux, where loopback already is the host.
    rewrite_loopback: bool | None = None
    kubeconfig: str | None = None
    static_dir: Path | None = None
    # OMNIKRUX_DEBUG_IMAGE: the image for debug containers and node shells.
    debug_image: str = "busybox:1.36"
    # OMNIKRUX_ALLOWED_HOSTS: comma-separated; "*" turns the Host check off.
    allowed_hosts: Annotated[list[str], NoDecode] = list(DEFAULT_ALLOWED_HOSTS)

    @field_validator("allowed_hosts", mode="before")
    @classmethod
    def _split_hosts(cls, value: object) -> object:
        if isinstance(value, str):
            return [h.strip() for h in value.split(",") if h.strip()]
        return value

    @property
    def db_url(self) -> str:
        return self.database_url or f"sqlite+aiosqlite:///{self.data_dir}/omnikrux.db"

    @property
    def loopback_rewrite(self) -> bool:
        return self.in_container if self.rewrite_loopback is None else self.rewrite_loopback

    @property
    def kubeconfig_paths(self) -> list[Path]:
        if self.kubeconfig is None:
            default = (
                Path("/kube/config") if self.in_container else Path.home() / ".kube" / "config"
            )
            return [default]
        return [Path(p) for p in self.kubeconfig.split(os.pathsep) if p]


@lru_cache
def get_settings() -> Settings:
    return Settings()
