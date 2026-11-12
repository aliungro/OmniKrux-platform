from pathlib import Path

from omnikrux.cloud.dirs import folder_state
from omnikrux.cloud.messages import unreadable_login


def test_login_folder_accepts_any_marker(tmp_path):
    assert folder_state(tmp_path, ("config", "credentials")).state == "missing"
    (tmp_path / "credentials").write_bytes(b"test login")
    folder = folder_state(tmp_path, ("config", "credentials"))
    assert folder.path == tmp_path
    assert folder.state == "found"


def test_login_folder_accepts_gcloud_configurations_directory(tmp_path):
    (tmp_path / "configurations").mkdir()
    folder = folder_state(tmp_path, ("application_default_credentials.json", "configurations"))
    assert folder.state == "found"


def test_unreadable_login_plain_message(tmp_path, monkeypatch):
    marker = tmp_path / "azureProfile.json"
    marker.write_bytes(b"test login")
    original_open = Path.open

    def deny_login(path, *args, **kwargs):
        if path == marker:
            raise PermissionError("private operating system details")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", deny_login)
    folder = folder_state(tmp_path, ("azureProfile.json",))
    assert folder.state == "unreadable"
    assert unreadable_login(folder.path) == (
        f"Found {tmp_path}, but the console can't read it (permission denied). "
        "Run the container as your own user, as the README shows."
    )
