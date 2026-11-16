import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


@dataclass(frozen=True)
class CloudDirs:
    azure: Path
    aws: Path
    gcloud: Path
    oci: Path


@dataclass(frozen=True)
class LoginFolder:
    path: Path
    state: Literal["found", "missing", "unreadable"]


def folder_state(path: Path, markers: tuple[str, ...]) -> LoginFolder:
    unreadable = False
    for marker in markers:
        candidate = path / marker
        try:
            if candidate.is_dir():
                with os.scandir(candidate):
                    pass
            else:
                with candidate.open("rb"):
                    pass
            return LoginFolder(path, "found")
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError:
            unreadable = True
    return LoginFolder(path, "unreadable" if unreadable else "missing")
