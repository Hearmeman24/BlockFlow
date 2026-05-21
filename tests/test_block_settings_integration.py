"""Tests for lora_train + dataset_create reading credentials from Settings
(sgs-ui-wisp-las.6).

Both blocks previously read RunPod / S3 credentials from env vars + their
own hardcoded defaults. Post-.6 they read from Settings (the store from .1)
exclusively — no env fallbacks, no hardcoded defaults.

Tests assert:
- Missing Settings produce 400 with a clear list of what's missing
- Present Settings produce the right values inside the block's
  credential getters
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402


@pytest.fixture
def fresh_store(tmp_path, monkeypatch):
    db_path = tmp_path / "block_settings_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    return settings_store


def _load_lora_train():
    """Force-reimport the lora_train backend module so it picks up the
    patched settings_store.DB_PATH."""
    if "custom_blocks.lora_train.backend.block" in sys.modules:
        del sys.modules["custom_blocks.lora_train.backend.block"]
    spec = importlib.util.spec_from_file_location(
        "lora_train_backend",
        ROOT / "custom_blocks" / "lora_train" / "backend.block.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# === lora_train: missing creds list ========================================

def test_lora_train_missing_creds_helper_lists_all_missing(fresh_store):
    """The block exposes _missing_credentials() returning the list of names
    that are unset. Used by the /run handler to produce a 400 detail."""
    mod = _load_lora_train()
    missing = mod._missing_credentials()
    # All required creds should be in the missing list when store is empty
    for name in ("runpod_lora_endpoint_id", "r2_access_key_id", "r2_secret_access_key", "r2_bucket"):
        assert name in missing, f"expected {name} in missing list, got {missing}"


def test_lora_train_missing_creds_empty_when_all_configured(fresh_store):
    fresh_store.set_credential("r2_access_key_id", "AKIA")
    fresh_store.set_credential("r2_secret_access_key", "secret")
    fresh_store.set_credential("r2_bucket", "my-bucket")
    fresh_store.set_credential("runpod_lora_endpoint_id", "ep_trainer")

    mod = _load_lora_train()
    assert mod._missing_credentials() == []


def test_lora_train_partial_creds_lists_only_missing(fresh_store):
    fresh_store.set_credential("r2_access_key_id", "AKIA")
    # missing: secret, bucket, endpoint_id

    mod = _load_lora_train()
    missing = mod._missing_credentials()
    assert "r2_access_key_id" not in missing
    assert "r2_secret_access_key" in missing
    assert "r2_bucket" in missing
    assert "runpod_lora_endpoint_id" in missing


# === lora_train: getter functions return Settings values ===================

def test_lora_train_get_endpoint_id_reads_settings(fresh_store):
    fresh_store.set_credential("runpod_lora_endpoint_id", "ep_user_trainer")
    mod = _load_lora_train()
    assert mod._get_runpod_lora_endpoint_id() == "ep_user_trainer"


def test_lora_train_get_endpoint_id_returns_empty_when_unset(fresh_store):
    """Distinct from raising — handler decides whether to 400."""
    mod = _load_lora_train()
    assert mod._get_runpod_lora_endpoint_id() == ""


def test_lora_train_get_s3_creds_reads_settings(fresh_store):
    fresh_store.set_credential("r2_access_key_id", "AKIA_real")
    fresh_store.set_credential("r2_secret_access_key", "sekret_real")
    fresh_store.set_credential("r2_bucket", "my-real-bucket")
    fresh_store.set_credential("r2_region", "eu-west-2")
    fresh_store.set_credential("r2_endpoint_url", "https://x.r2.cloudflarestorage.com")

    mod = _load_lora_train()
    creds = mod._get_s3_creds()
    assert creds["access_key_id"] == "AKIA_real"
    assert creds["secret_access_key"] == "sekret_real"
    assert creds["bucket"] == "my-real-bucket"
    assert creds["region"] == "eu-west-2"
    assert creds["endpoint_url"] == "https://x.r2.cloudflarestorage.com"


def test_lora_train_get_s3_creds_defaults_region_to_auto_when_unset(fresh_store):
    fresh_store.set_credential("r2_access_key_id", "AKIA")
    fresh_store.set_credential("r2_secret_access_key", "secret")
    fresh_store.set_credential("r2_bucket", "b")
    # r2_region NOT set

    mod = _load_lora_train()
    creds = mod._get_s3_creds()
    assert creds["region"] == "auto"


# === No hardcoded fallbacks ================================================

def test_lora_train_no_hardcoded_endpoint_id_in_source(fresh_store):
    """Regression: the old default '7cimkii50xunxw' must NOT appear in the
    source file. Replaces .9's grep gate for this specific token."""
    source_path = ROOT / "custom_blocks" / "lora_train" / "backend.block.py"
    source = source_path.read_text()
    assert "7cimkii50xunxw" not in source, "endpoint ID hardcoded — must come from Settings"


def test_lora_train_no_hardcoded_bucket_in_source(fresh_store):
    """hearmeman-loras bucket name must come from Settings, not hardcoded."""
    source_path = ROOT / "custom_blocks" / "lora_train" / "backend.block.py"
    source = source_path.read_text()
    assert "hearmeman-loras" not in source, "bucket hardcoded — must come from Settings"


# === dataset_create: runpod key sourcing ===================================

def _load_dataset_create():
    if "custom_blocks.dataset_create.backend.block" in sys.modules:
        del sys.modules["custom_blocks.dataset_create.backend.block"]
    spec = importlib.util.spec_from_file_location(
        "dataset_create_backend",
        ROOT / "custom_blocks" / "dataset_create" / "backend.block.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_dataset_create_reads_runpod_key_from_settings(fresh_store):
    fresh_store.set_credential("runpod_api_key", "rpa_from_settings")
    mod = _load_dataset_create()
    assert mod._get_runpod_api_key() == "rpa_from_settings"


def test_dataset_create_returns_empty_runpod_key_when_unset(fresh_store):
    mod = _load_dataset_create()
    assert mod._get_runpod_api_key() == ""
