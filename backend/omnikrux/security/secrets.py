import contextlib
import os

from cryptography.fernet import Fernet, InvalidToken

from omnikrux.config import Settings


class SecretError(Exception):
    """Raised when a secret cannot be decrypted (wrong key or tampered data)."""


class SecretBox:
    def __init__(self, key: bytes) -> None:
        self._fernet = Fernet(key)

    @classmethod
    def from_settings(cls, settings: Settings) -> "SecretBox":
        if settings.secret_key:
            return cls(settings.secret_key.encode())
        key_file = settings.data_dir / "secret.key"
        if key_file.exists():
            return cls(key_file.read_bytes().strip())
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        key = Fernet.generate_key()
        key_file.write_bytes(key)
        with contextlib.suppress(OSError):
            os.chmod(key_file, 0o600)
        return cls(key)

    def encrypt(self, data: bytes) -> bytes:
        return self._fernet.encrypt(data)

    def decrypt(self, token: bytes) -> bytes:
        try:
            return self._fernet.decrypt(token)
        except InvalidToken as exc:
            raise SecretError("could not decrypt secret: wrong key or tampered data") from exc
