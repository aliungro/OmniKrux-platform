def test_spa_served_and_api_not_shadowed(tmp_settings, tmp_path):
    from fastapi.testclient import TestClient

    from omnikrux.main import create_app

    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<div id=root></div>")
    client = TestClient(create_app(tmp_settings.model_copy(update={"static_dir": static})))
    assert "id=root" in client.get("/clusters/whatever").text
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/nope").status_code == 404


def test_spa_serves_real_files_and_blocks_traversal(tmp_settings, tmp_path):
    from fastapi.testclient import TestClient

    from omnikrux.main import create_app

    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<div id=root></div>")
    (static / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("secret")
    client = TestClient(create_app(tmp_settings.model_copy(update={"static_dir": static})))
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert "secret" not in client.get("/%2e%2e/secret.txt").text
    assert "secret" not in client.get("/assets/..%2f..%2fsecret.txt").text
