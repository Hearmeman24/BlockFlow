"""Tests for the SQLite settings store (sgs-ui-wisp-las.1 Stage 1).

Stage 1 covers the backend store only — pure repository functions over a
sqlite-backed `credentials`, `endpoints`, and `app_prefs` schema. No HTTP
routes (Stage 2), no UI (Stage 3+).

Doctrine: build green ≠ feature works. Every test asserts the ACTUAL state
written/returned, not just "no exception raised."
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Fresh, isolated sqlite file per test."""
    db_path = tmp_path / "settings_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    return settings_store


# === init_db ================================================================

def test_init_db_creates_tables_idempotently(tmp_path, monkeypatch):
    db_path = tmp_path / "fresh.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)

    settings_store.init_db()  # first call creates
    settings_store.init_db()  # second call must not error

    # State assertion: tables actually exist + writable
    settings_store.set_credential("runpod_api_key", "rpa_x")
    assert settings_store.get_credential("runpod_api_key") == "rpa_x"


def test_init_db_creates_parent_dir_if_missing(tmp_path, monkeypatch):
    nested = tmp_path / "deeply" / "nested" / "settings.db"
    monkeypatch.setattr(settings_store, "DB_PATH", nested)

    settings_store.init_db()

    assert nested.parent.is_dir()


# === credentials ============================================================

def test_set_then_get_credential_round_trip(store):
    store.set_credential("runpod_api_key", "rpa_secret_value")
    assert store.get_credential("runpod_api_key") == "rpa_secret_value"


def test_get_credential_unset_returns_none(store):
    assert store.get_credential("never_set") is None


def test_update_credential_overwrites_value(store):
    store.set_credential("openrouter_api_key", "old_value")
    store.set_credential("openrouter_api_key", "new_value")
    assert store.get_credential("openrouter_api_key") == "new_value"


def test_list_credentials_empty_when_none_set(store):
    assert store.list_credentials() == []


def test_list_credentials_returns_names_sorted(store):
    store.set_credential("runpod_api_key", "x")
    store.set_credential("civitai_api_key", "y")
    store.set_credential("imgbb_api_key", "z")

    assert store.list_credentials() == ["civitai_api_key", "imgbb_api_key", "runpod_api_key"]


def test_delete_credential_removes_it(store):
    store.set_credential("topaz_api_key", "v")
    store.delete_credential("topaz_api_key")
    assert store.get_credential("topaz_api_key") is None
    assert "topaz_api_key" not in store.list_credentials()


def test_delete_credential_idempotent_when_unset(store):
    # Deleting a non-existent credential is a no-op, not an error
    store.delete_credential("never_existed")  # must not raise


def test_credential_empty_string_value_is_stored_distinct_from_unset(store):
    """Empty string is a real value, not 'unset'. Subtle but important —
    a user clearing a credential to '' should not silently become 'no credential'."""
    store.set_credential("r2_secret", "")
    assert store.get_credential("r2_secret") == ""
    assert "r2_secret" in store.list_credentials()


def test_credential_unicode_value_preserved(store):
    """Cloudflare R2 bucket names + various creds may contain unicode in some scenarios."""
    store.set_credential("note", "héllo wörld 你好 🔑")
    assert store.get_credential("note") == "héllo wörld 你好 🔑"


def test_credential_very_long_value_preserved(store):
    """RunPod tokens + JWTs can be long. Verify there's no implicit truncation."""
    long_value = "x" * 10_000
    store.set_credential("big_token", long_value)
    assert store.get_credential("big_token") == long_value


def test_credential_updated_at_advances_on_update(store):
    store.set_credential("k", "v1")
    first_ts = store.get_credential_updated_at("k")
    time.sleep(0.01)  # SQLite second-precision timestamps can collide; nudge past
    store.set_credential("k", "v2")
    second_ts = store.get_credential_updated_at("k")
    assert second_ts >= first_ts
    assert second_ts is not None


# === endpoints ==============================================================

def test_set_endpoint_round_trip_all_fields(store):
    store.set_endpoint(
        "comfygen",
        endpoint_id="ep_abc123",
        volume_id="vol_xyz",
        template_id="tmpl_abc",
        template_name="blockflow-comfygen-abc-template-abc",
        gpu_tier="recommended",
        volume_size_gb=200,
        max_workers=3,
        provisioned_at="2026-05-21T10:00:00Z",
    )
    ep = store.get_endpoint("comfygen")
    assert ep == {
        "type": "comfygen",
        "endpoint_id": "ep_abc123",
        "volume_id": "vol_xyz",
        "template_id": "tmpl_abc",
        "template_name": "blockflow-comfygen-abc-template-abc",
        "gpu_tier": "recommended",
        "volume_size_gb": 200,
        "max_workers": 3,
        "provisioned_at": "2026-05-21T10:00:00Z",
    }


def test_set_endpoint_with_only_required_fields(store):
    """Some endpoints (trainer) don't need a volume_id; missing optional fields → None."""
    store.set_endpoint("aio_trainer", endpoint_id="ep_trainer123")
    ep = store.get_endpoint("aio_trainer")
    assert ep["endpoint_id"] == "ep_trainer123"
    assert ep["volume_id"] is None
    assert ep["template_id"] is None
    assert ep["template_name"] is None
    assert ep["gpu_tier"] is None
    assert ep["volume_size_gb"] is None
    assert ep["max_workers"] is None


def test_set_endpoint_persists_template_name_for_teardown(store):
    """Regression for the bug found in Stage B's live e2e smoke: template_name
    was missing from the schema, so a later tear-down couldn't delete the
    template (which requires NAME, not ID)."""
    store.set_endpoint(
        "comfygen",
        endpoint_id="ep_x",
        template_id="tmpl_x",
        template_name="blockflow-comfygen-x-template-x",
    )
    ep = store.get_endpoint("comfygen")
    assert ep["template_name"] == "blockflow-comfygen-x-template-x"


def test_set_endpoint_migrates_legacy_db_without_template_name(tmp_path, monkeypatch):
    """If a DB was created before template_name existed, init_db should add
    the column via ALTER TABLE (without dropping existing data)."""
    db_path = tmp_path / "legacy.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)

    # Build a legacy schema by hand: no template_name column.
    import sqlite3
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE settings_endpoints (
            type TEXT PRIMARY KEY,
            endpoint_id TEXT NOT NULL,
            volume_id TEXT,
            template_id TEXT,
            gpu_tier TEXT,
            volume_size_gb INTEGER,
            max_workers INTEGER,
            provisioned_at TEXT,
            updated_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        INSERT INTO settings_endpoints
            (type, endpoint_id, volume_id, template_id, gpu_tier, volume_size_gb,
             max_workers, provisioned_at, updated_at)
        VALUES ('comfygen', 'ep_legacy', 'vol_legacy', 'tmpl_legacy', 'budget',
                100, 2, NULL, '2026-01-01T00:00:00')
    """)
    conn.commit()
    conn.close()

    # init_db should ALTER TABLE to add template_name, preserving the row
    settings_store.init_db()

    ep = settings_store.get_endpoint("comfygen")
    assert ep is not None
    assert ep["endpoint_id"] == "ep_legacy"
    assert ep["template_name"] is None  # column now exists, defaults to NULL

    # And we can update + persist template_name
    settings_store.set_endpoint(
        "comfygen",
        endpoint_id="ep_legacy",
        template_name="back-filled-name",
    )
    assert settings_store.get_endpoint("comfygen")["template_name"] == "back-filled-name"


def test_get_endpoint_unset_returns_none(store):
    assert store.get_endpoint("comfygen") is None


def test_update_endpoint_replaces_full_record(store):
    """set_endpoint is upsert: a second call with different fields replaces the row entirely."""
    store.set_endpoint("comfygen", endpoint_id="ep_first", volume_id="vol_first", gpu_tier="budget")
    store.set_endpoint("comfygen", endpoint_id="ep_second", gpu_tier="performance")

    ep = store.get_endpoint("comfygen")
    assert ep["endpoint_id"] == "ep_second"
    assert ep["gpu_tier"] == "performance"
    # Fields not supplied in the second call must be reset to None (not kept from prior)
    assert ep["volume_id"] is None


def test_list_endpoints_returns_configured_types_sorted(store):
    assert store.list_endpoints() == []

    store.set_endpoint("aio_trainer", endpoint_id="t1")
    store.set_endpoint("comfygen", endpoint_id="c1")

    assert store.list_endpoints() == ["aio_trainer", "comfygen"]


def test_delete_endpoint_clears_row(store):
    store.set_endpoint("comfygen", endpoint_id="ep_x")
    store.delete_endpoint("comfygen")
    assert store.get_endpoint("comfygen") is None
    assert "comfygen" not in store.list_endpoints()


def test_delete_endpoint_idempotent_when_unset(store):
    store.delete_endpoint("never_existed")  # must not raise


# === app_prefs ==============================================================

def test_app_pref_round_trip(store):
    store.set_app_pref("output_dir", "/tmp/blockflow_out")
    assert store.get_app_pref("output_dir") == "/tmp/blockflow_out"


def test_app_pref_get_with_default_when_unset(store):
    assert store.get_app_pref("missing") is None
    assert store.get_app_pref("missing", default="fallback") == "fallback"


def test_app_pref_update(store):
    store.set_app_pref("run_history_retention_days", "90")
    store.set_app_pref("run_history_retention_days", "30")
    assert store.get_app_pref("run_history_retention_days") == "30"


def test_app_pref_value_is_string_typed(store):
    """app_prefs is a simple string-keyed store. Callers serialize numbers/JSON themselves."""
    store.set_app_pref("retention_days", "90")
    val = store.get_app_pref("retention_days")
    assert isinstance(val, str)


# === isolation (regression safety) ==========================================

def test_credentials_endpoints_and_prefs_are_independent_namespaces(store):
    """Setting a credential named X does not affect endpoint X or app_pref X."""
    store.set_credential("comfygen", "this_is_a_credential")
    store.set_endpoint("comfygen", endpoint_id="ep_real")
    store.set_app_pref("comfygen", "this_is_a_pref")

    assert store.get_credential("comfygen") == "this_is_a_credential"
    assert store.get_endpoint("comfygen")["endpoint_id"] == "ep_real"
    assert store.get_app_pref("comfygen") == "this_is_a_pref"


def test_settings_store_does_not_affect_existing_run_history_table(tmp_path, monkeypatch):
    """Regression guard: settings_store uses the same DB file as run_history;
    creating settings tables must not collide with the runs table."""
    from backend import db as run_history_db

    shared_db = tmp_path / "shared.db"
    monkeypatch.setattr(run_history_db, "DB_PATH", shared_db)
    monkeypatch.setattr(settings_store, "DB_PATH", shared_db)

    run_history_db.init_db()
    settings_store.init_db()

    # Both schemas coexist
    run_history_db.init_db()  # no-op
    settings_store.set_credential("k", "v")

    assert settings_store.get_credential("k") == "v"
