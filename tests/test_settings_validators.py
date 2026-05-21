"""Tests for settings credential validators (sgs-ui-wisp-las.1 Stage 1.5).

Each validator reads credentials from the store and calls an external service.
Per the TDD doctrine: mock the boundary (the HTTP / boto3 client), not the
validator logic. The real validator code path runs against the mock so we
exercise the actual credential-reading + result-shaping behavior.

Validators in scope this stage:
  - runpod   (RunPod GraphQL whoami / gpuTypes)
  - r2       (boto3 list_buckets against the configured R2 endpoint)
  - openrouter (GET /api/v1/auth/key)

Validators NOT yet implemented (added in later stages as the UI needs them):
  - civitai, imgbb, tmpfiles, topaz
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store, settings_validators  # noqa: E402
from backend.settings_routes import router as settings_router  # noqa: E402


@pytest.fixture
def store(tmp_path, monkeypatch):
    db_path = tmp_path / "settings_validator_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    return settings_store


@pytest.fixture
def client(store):
    app = FastAPI()
    app.include_router(settings_router)
    return TestClient(app)


# === RunPod validator =======================================================

def test_validate_runpod_unconfigured_returns_400(client, store):
    r = client.post("/api/settings/validate/runpod")
    assert r.status_code == 400
    assert "runpod_api_key" in r.json()["detail"]


def test_validate_runpod_success(client, store, mocker):
    store.set_credential("runpod_api_key", "rpa_valid_key")
    # Mock the BOUNDARY: the function in settings_validators that posts to RunPod.
    # The validator's own credential-reading + result-shaping code runs for real.
    mock_post = mocker.patch.object(
        settings_validators,
        "_runpod_graphql_post",
        return_value={"data": {"gpuTypes": [{"id": "NVIDIA H100 80GB"}]}},
    )

    r = client.post("/api/settings/validate/runpod")

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["error"] is None
    # The validator must have passed the actual stored key to the HTTP call,
    # not a hardcoded or mock value
    mock_post.assert_called_once()
    assert mock_post.call_args.kwargs.get("api_key") == "rpa_valid_key" or "rpa_valid_key" in str(mock_post.call_args)


def test_validate_runpod_401_returns_ok_false(client, store, mocker):
    store.set_credential("runpod_api_key", "rpa_bad")
    mocker.patch.object(
        settings_validators,
        "_runpod_graphql_post",
        side_effect=settings_validators.ValidationFailed("HTTP 401: invalid api key"),
    )

    r = client.post("/api/settings/validate/runpod")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "401" in body["error"] or "invalid" in body["error"].lower()


def test_validate_runpod_network_error_returns_ok_false(client, store, mocker):
    store.set_credential("runpod_api_key", "rpa_anything")
    mocker.patch.object(
        settings_validators,
        "_runpod_graphql_post",
        side_effect=settings_validators.ValidationFailed("network error: timeout"),
    )

    r = client.post("/api/settings/validate/runpod")
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "network" in r.json()["error"].lower() or "timeout" in r.json()["error"].lower()


# === R2 validator ===========================================================

@pytest.fixture
def configured_r2(store):
    store.set_credential("r2_endpoint_url", "https://abc.r2.cloudflarestorage.com")
    store.set_credential("r2_access_key_id", "AKIA_TEST")
    store.set_credential("r2_secret_access_key", "secret_test")
    store.set_credential("r2_bucket", "my-bucket")


def test_validate_r2_unconfigured_returns_400_listing_missing(client, store):
    """If any of the 4 R2 fields is unset, fail loudly with a list of missing names."""
    r = client.post("/api/settings/validate/r2")
    assert r.status_code == 400
    detail = r.json()["detail"]
    # All four field names should be reported
    for missing in ("r2_endpoint_url", "r2_access_key_id", "r2_secret_access_key", "r2_bucket"):
        assert missing in detail


def test_validate_r2_partial_config_lists_only_missing(client, store):
    store.set_credential("r2_endpoint_url", "https://x.r2.cloudflarestorage.com")
    store.set_credential("r2_access_key_id", "AKIA_X")
    # r2_secret_access_key + r2_bucket missing

    r = client.post("/api/settings/validate/r2")
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "r2_secret_access_key" in detail
    assert "r2_bucket" in detail
    # already-configured ones are NOT listed as missing
    assert "r2_endpoint_url" not in detail
    assert "r2_access_key_id" not in detail


def test_validate_r2_success(client, configured_r2, mocker):
    # Mock the boto3 client factory at the boundary; validator constructs its own
    # client config (which we want to verify) but the network call is faked.
    fake_client = mocker.MagicMock()
    fake_client.list_buckets.return_value = {"Buckets": [{"Name": "my-bucket"}]}
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    r = client.post("/api/settings/validate/r2")

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    fake_client.list_buckets.assert_called_once()


def test_validate_r2_passes_correct_creds_to_boto3(client, configured_r2, mocker):
    """The validator must construct the boto3 client using the stored credentials,
    not hardcoded values. This is the regression-scope test for changes to credential
    plumbing.
    """
    fake_client = mocker.MagicMock()
    fake_client.list_buckets.return_value = {"Buckets": []}
    factory = mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    client.post("/api/settings/validate/r2")

    factory.assert_called_once_with(
        endpoint_url="https://abc.r2.cloudflarestorage.com",
        access_key_id="AKIA_TEST",
        secret_access_key="secret_test",
    )


def test_validate_r2_boto3_error_returns_ok_false(client, configured_r2, mocker):
    fake_client = mocker.MagicMock()
    fake_client.list_buckets.side_effect = settings_validators.ValidationFailed("InvalidAccessKeyId")
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    r = client.post("/api/settings/validate/r2")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "InvalidAccessKeyId" in body["error"]


def test_validate_r2_bucket_not_in_listing_returns_ok_false(client, configured_r2, mocker):
    """If the credentials work but the configured bucket isn't owned by them, that's a config error."""
    fake_client = mocker.MagicMock()
    fake_client.list_buckets.return_value = {"Buckets": [{"Name": "some-other-bucket"}]}
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    r = client.post("/api/settings/validate/r2")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "my-bucket" in body["error"]


# === OpenRouter validator ===================================================

def test_validate_openrouter_unconfigured_returns_400(client, store):
    r = client.post("/api/settings/validate/openrouter")
    assert r.status_code == 400
    assert "openrouter_api_key" in r.json()["detail"]


def test_validate_openrouter_success(client, store, mocker):
    store.set_credential("openrouter_api_key", "sk-or-v1-test")
    mocker.patch.object(
        settings_validators,
        "_openrouter_auth_check",
        return_value={"data": {"label": "test key"}},
    )

    r = client.post("/api/settings/validate/openrouter")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_validate_openrouter_passes_real_key(client, store, mocker):
    store.set_credential("openrouter_api_key", "sk-or-v1-actual")
    spy = mocker.patch.object(
        settings_validators,
        "_openrouter_auth_check",
        return_value={"data": {}},
    )

    client.post("/api/settings/validate/openrouter")

    # Real stored key reached the boundary, not a placeholder
    call_kwargs = spy.call_args.kwargs
    call_args = spy.call_args.args
    assert "sk-or-v1-actual" in (call_kwargs.get("api_key", ""), *call_args)


def test_validate_openrouter_invalid_key_returns_ok_false(client, store, mocker):
    store.set_credential("openrouter_api_key", "sk-or-v1-bad")
    mocker.patch.object(
        settings_validators,
        "_openrouter_auth_check",
        side_effect=settings_validators.ValidationFailed("HTTP 401"),
    )

    r = client.post("/api/settings/validate/openrouter")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "401" in body["error"]


# === unknown service ========================================================

def test_validate_unknown_service_returns_404(client):
    r = client.post("/api/settings/validate/no_such_service")
    assert r.status_code == 404
    assert "no_such_service" in r.json()["detail"]


# === regression: existing CRUD routes still work ============================

def test_validate_endpoint_does_not_break_credentials_crud(client, store):
    """Adding /api/settings/validate/* routes must not regress the existing CRUD endpoints."""
    r = client.put("/api/settings/credentials/some_key", json={"value": "v"})
    assert r.status_code == 200
    r2 = client.get("/api/settings/credentials/some_key")
    assert r2.json()["value"] == "v"
