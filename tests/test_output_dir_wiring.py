"""sgs-ui-se7: backend honors the Settings → App tab `output_dir` pref.

Pre-fix: the Settings UI persists `output_dir` via setAppPref, but no
backend code reads it — LOCAL_OUTPUT_DIR is hardcoded everywhere
(/outputs static mount, services.py, routes.py, tmpfiles.py).

Post-fix:
  - config.resolve_local_output_dir(default, store) is a pure resolver:
    pref set + valid → returns the override
    pref unset / dir missing / dir not writable → returns default (with warning)
  - main.py calls the resolver at startup (after init_db) and reassigns
    config.LOCAL_OUTPUT_DIR so the /outputs StaticFiles mount and every
    config.LOCAL_OUTPUT_DIR-attribute read picks it up.
  - PUT /api/settings/app-prefs/output_dir validates the path is a
    writable directory before persisting (400 on bad input).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config as _config  # noqa: E402
from backend import settings_routes, settings_store  # noqa: E402


# === resolve_local_output_dir (pure function) ================================

def test_resolver_no_pref_returns_default(tmp_path):
    default = tmp_path / "default_output"
    default.mkdir()
    store = MagicMock()
    store.get_app_pref.return_value = None
    assert _config.resolve_local_output_dir(default=default, store=store) == default


def test_resolver_valid_pref_returns_override(tmp_path):
    default = tmp_path / "default_output"
    default.mkdir()
    override = tmp_path / "vault_output"
    override.mkdir()
    store = MagicMock()
    store.get_app_pref.return_value = str(override)
    assert _config.resolve_local_output_dir(default=default, store=store) == override


def test_resolver_missing_dir_falls_back_to_default(tmp_path):
    default = tmp_path / "default_output"
    default.mkdir()
    store = MagicMock()
    store.get_app_pref.return_value = str(tmp_path / "does_not_exist")
    assert _config.resolve_local_output_dir(default=default, store=store) == default


def test_resolver_file_at_path_falls_back_to_default(tmp_path):
    default = tmp_path / "default_output"
    default.mkdir()
    notadir = tmp_path / "I_am_a_file.txt"
    notadir.write_text("hi")
    store = MagicMock()
    store.get_app_pref.return_value = str(notadir)
    assert _config.resolve_local_output_dir(default=default, store=store) == default


def test_resolver_unwritable_dir_falls_back_to_default(tmp_path):
    default = tmp_path / "default_output"
    default.mkdir()
    locked = tmp_path / "locked_output"
    locked.mkdir()
    locked.chmod(0o500)  # r-x, no write
    store = MagicMock()
    store.get_app_pref.return_value = str(locked)
    try:
        assert _config.resolve_local_output_dir(default=default, store=store) == default
    finally:
        locked.chmod(0o700)  # restore so pytest can clean up


def test_resolver_empty_string_pref_is_treated_as_unset(tmp_path):
    """Edge case: legacy code may persist empty strings instead of NULL."""
    default = tmp_path / "default_output"
    default.mkdir()
    store = MagicMock()
    store.get_app_pref.return_value = ""
    assert _config.resolve_local_output_dir(default=default, store=store) == default


# === PUT /api/settings/app-prefs/output_dir validates the value ==============

@pytest.fixture
def app(tmp_path, monkeypatch):
    db_path = tmp_path / "settings_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()

    fastapi_app = FastAPI()
    fastapi_app.include_router(settings_routes.router)
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


def test_put_output_dir_rejects_nonexistent_path(client, tmp_path):
    bad = tmp_path / "does_not_exist"
    r = client.put(
        "/api/settings/app-prefs/output_dir",
        json={"value": str(bad)},
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "does not exist" in detail or "not a directory" in detail
    # Make sure it wasn't persisted.
    assert settings_store.get_app_pref("output_dir") is None


def test_put_output_dir_rejects_file_path(client, tmp_path):
    f = tmp_path / "afile.txt"
    f.write_text("nope")
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(f)})
    assert r.status_code == 400
    assert "not a directory" in r.json()["detail"]


def test_put_output_dir_rejects_unwritable_dir(client, tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(locked)})
        assert r.status_code == 400
        assert "not writable" in r.json()["detail"]
    finally:
        locked.chmod(0o700)


def test_put_output_dir_accepts_valid_dir(client, tmp_path):
    good = tmp_path / "vault_output"
    good.mkdir()
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(good)})
    assert r.status_code == 200
    assert settings_store.get_app_pref("output_dir") == str(good)


def test_put_output_dir_empty_string_clears_setting(client, tmp_path):
    """Setting output_dir to empty string is the UX for 'go back to default'.
    Empty must be persisted (not rejected) so resolve_local_output_dir's
    empty-as-unset branch can kick in."""
    good = tmp_path / "v"
    good.mkdir()
    client.put("/api/settings/app-prefs/output_dir", json={"value": str(good)})
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": ""})
    assert r.status_code == 200
    assert settings_store.get_app_pref("output_dir") == ""


def test_put_other_app_pref_is_unvalidated(client):
    """Validation kicks in ONLY for output_dir, not every app pref."""
    r = client.put(
        "/api/settings/app-prefs/run_history_retention_days",
        json={"value": "30"},
    )
    assert r.status_code == 200
    assert settings_store.get_app_pref("run_history_retention_days") == "30"
