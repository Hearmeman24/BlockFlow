from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
APP_PATH = ROOT / "app.py"


def _load_app_module():
    spec = importlib.util.spec_from_file_location("blockflow_app_entry", APP_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_packaged_mode_flag_or_env(monkeypatch):
    app = _load_app_module()

    monkeypatch.delenv("BLOCKFLOW_PACKAGED", raising=False)
    assert app._is_packaged_mode([]) is False
    assert app._is_packaged_mode(["--packaged"]) is True

    monkeypatch.setenv("BLOCKFLOW_PACKAGED", "1")
    assert app._is_packaged_mode([]) is True


def test_find_standalone_server_prefers_direct_server(tmp_path):
    app = _load_app_module()
    direct = tmp_path / ".next" / "standalone" / "server.js"
    nested = tmp_path / ".next" / "standalone" / "apps" / "blockflow" / "server.js"
    nested.parent.mkdir(parents=True)
    nested.write_text("nested", encoding="utf-8")
    direct.parent.mkdir(parents=True, exist_ok=True)
    direct.write_text("direct", encoding="utf-8")

    assert app._find_standalone_server(tmp_path) == direct


def test_find_standalone_server_falls_back_to_nested(tmp_path):
    app = _load_app_module()
    nested = tmp_path / ".next" / "standalone" / "apps" / "blockflow" / "server.js"
    nested.parent.mkdir(parents=True)
    nested.write_text("nested", encoding="utf-8")

    assert app._find_standalone_server(tmp_path) == nested


def test_find_standalone_server_missing_is_clear(tmp_path):
    app = _load_app_module()

    with pytest.raises(FileNotFoundError, match="Missing Next.js standalone server"):
        app._find_standalone_server(tmp_path)


def test_frontend_command_dev_uses_npm_dev():
    app = _load_app_module()

    command, cwd = app._frontend_command(packaged=False, frontend_port=4123)

    assert command == ["npm", "run", "dev", "--", "--port", "4123"]
    assert cwd == app.FRONTEND_DIR


def test_frontend_command_packaged_uses_standalone_server(monkeypatch, tmp_path):
    app = _load_app_module()
    server = tmp_path / "standalone" / "server.js"
    server.parent.mkdir()
    server.write_text("", encoding="utf-8")
    monkeypatch.setattr(app, "_find_standalone_server", lambda: server)

    command, cwd = app._frontend_command(packaged=True, frontend_port=4123)

    assert command == ["node", str(server)]
    assert cwd == server.parent


def test_backend_command_uses_uvicorn_module():
    app = _load_app_module()

    command = app._backend_command(8123)

    assert command[-5:] == ["backend.main:app", "--host", "127.0.0.1", "--port", "8123"]


def test_no_open_env_is_documented_for_smoke_tests():
    source = APP_PATH.read_text(encoding="utf-8")

    assert "BLOCKFLOW_NO_OPEN" in source
    assert "Ready at" in source
