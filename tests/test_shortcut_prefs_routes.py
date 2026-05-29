"""HTTP route tests for /api/settings/shortcuts (sgs-ui-77x).

Stores shortcut enable/disable flags in the existing settings_app_prefs table
using a namespaced key (shortcut.<id>.enabled). The sentinel id "__master__"
controls the master enable/disable toggle.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402
from backend.settings_routes import router as settings_router  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "shortcut_prefs_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()

    app = FastAPI()
    app.include_router(settings_router)
    return TestClient(app)


def test_default_returns_empty_dict(client):
    r = client.get("/api/settings/shortcuts")
    assert r.status_code == 200
    assert r.json() == {}


def test_round_trip_single_key(client):
    r = client.put("/api/settings/shortcuts", json={"insert-downstream": False})
    assert r.status_code == 200
    assert r.json().get("insert-downstream") is False

    r2 = client.get("/api/settings/shortcuts")
    assert r2.json().get("insert-downstream") is False


def test_round_trip_master_toggle(client):
    client.put("/api/settings/shortcuts", json={"__master__": False})
    r = client.get("/api/settings/shortcuts")
    assert r.json().get("__master__") is False


def test_partial_update_preserves_others(client):
    client.put(
        "/api/settings/shortcuts",
        json={"nav-right": False, "nav-left": True},
    )
    client.put("/api/settings/shortcuts", json={"nav-right": True})
    r = client.get("/api/settings/shortcuts")
    assert r.json().get("nav-right") is True
    assert r.json().get("nav-left") is True


def test_coexists_with_app_prefs(client):
    # Set a normal app pref via existing endpoint, then a shortcut pref.
    # Reading shortcuts should NOT include the app pref.
    client.put("/api/settings/app-prefs/output_dir", json={"value": "/tmp/x"})
    client.put("/api/settings/shortcuts", json={"nav-right": False})

    r = client.get("/api/settings/shortcuts")
    assert "output_dir" not in r.json()
    assert r.json().get("nav-right") is False
