import pytest
from cryptography.fernet import Fernet

from omnikrux.config import Settings
from omnikrux.security.secrets import SecretBox, SecretError


def test_round_trip(tmp_path):
    box = SecretBox.from_settings(Settings(data_dir=tmp_path))
    assert box.decrypt(box.encrypt(b"kubeconfig")) == b"kubeconfig"


def test_generated_key_is_persisted_and_reused(tmp_path):
    token = SecretBox.from_settings(Settings(data_dir=tmp_path)).encrypt(b"x")
    assert (tmp_path / "secret.key").exists()
    assert SecretBox.from_settings(Settings(data_dir=tmp_path)).decrypt(token) == b"x"


def test_explicit_key_wins_and_wrong_key_fails(tmp_path):
    k1, k2 = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    token = SecretBox.from_settings(Settings(data_dir=tmp_path, secret_key=k1)).encrypt(b"x")
    with pytest.raises(SecretError):
        SecretBox.from_settings(Settings(data_dir=tmp_path, secret_key=k2)).decrypt(token)
