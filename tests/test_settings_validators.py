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


def _r2_happy_client(mocker):
    """Fake boto3 client with all four operations in the round-trip succeeding."""
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.return_value = {}
    fake_client.put_object.return_value = {"ETag": '"abc"'}
    fake_client.generate_presigned_url.return_value = "https://x.example/presigned"
    fake_client.delete_object.return_value = {}
    return fake_client


def test_validate_r2_success(client, configured_r2, mocker):
    """sgs-ui-5nn option B: success path runs head_bucket THEN the full
    put/presigned-get/delete round-trip. All four operations + the presigned
    GET must be mocked."""
    fake_client = _r2_happy_client(mocker)
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)
    mocker.patch.object(
        settings_validators,
        "_r2_fetch_presigned",
        return_value=settings_validators.R2_ROUND_TRIP_PAYLOAD,
    )

    r = client.post("/api/settings/validate/r2")

    assert r.status_code == 200, r.json()
    body = r.json()
    assert body["ok"] is True
    fake_client.head_bucket.assert_called_once_with(Bucket="my-bucket")


def test_validate_r2_passes_correct_creds_to_boto3(client, configured_r2, mocker):
    """Regression for credential plumbing — boto3 client constructed from stored creds."""
    fake_client = _r2_happy_client(mocker)
    factory = mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)
    mocker.patch.object(
        settings_validators, "_r2_fetch_presigned",
        return_value=settings_validators.R2_ROUND_TRIP_PAYLOAD,
    )

    client.post("/api/settings/validate/r2")

    factory.assert_called_once_with(
        endpoint_url="https://abc.r2.cloudflarestorage.com",
        access_key_id="AKIA_TEST",
        secret_access_key="secret_test",
    )


def test_validate_r2_boto3_error_returns_ok_false(client, configured_r2, mocker):
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.side_effect = settings_validators.ValidationFailed("InvalidAccessKeyId")
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    r = client.post("/api/settings/validate/r2")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "InvalidAccessKeyId" in body["error"]


def test_validate_r2_access_denied_surfaced_verbatim(client, configured_r2, mocker):
    """boto3 ClientError stringifies as 'An error occurred (AccessDenied) when calling...';
    the validator must surface that as-is so the UI shows AWS's actual message."""
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.side_effect = Exception(
        "An error occurred (AccessDenied) when calling the HeadBucket operation: Access Denied"
    )
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    r = client.post("/api/settings/validate/r2")
    body = r.json()
    assert body["ok"] is False
    # No leading 'Exception:' type prefix — recognized error name surfaces clean
    assert body["error"].startswith("An error occurred (AccessDenied)")


def test_validate_r2_no_longer_calls_list_buckets(client, configured_r2, mocker):
    """Regression for the R2-token bug: R2 tokens scoped to one bucket lack
    ListBuckets permission. Validator must not call list_buckets at all."""
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.return_value = {}
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    client.post("/api/settings/validate/r2")

    fake_client.list_buckets.assert_not_called()


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


# === sgs-ui-5nn: CivitAI validator ==========================================

def test_validate_civitai_unconfigured_returns_400(client, store):
    r = client.post("/api/settings/validate/civitai")
    assert r.status_code == 400
    assert "civitai_api_key" in r.json()["detail"]


def test_validate_civitai_success(client, store, mocker):
    store.set_credential("civitai_api_key", "civ_valid_token")
    mocker.patch.object(
        settings_validators,
        "_civitai_auth_check",
        return_value={"username": "tester"},
    )
    r = client.post("/api/settings/validate/civitai")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["error"] is None


def test_validate_civitai_401_returns_ok_false(client, store, mocker):
    store.set_credential("civitai_api_key", "civ_bad")
    mocker.patch.object(
        settings_validators,
        "_civitai_auth_check",
        side_effect=settings_validators.ValidationFailed("HTTP 401: Unauthorized"),
    )
    r = client.post("/api/settings/validate/civitai")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "401" in body["error"]


def test_validate_civitai_network_error_returns_ok_false(client, store, mocker):
    store.set_credential("civitai_api_key", "civ_anything")
    mocker.patch.object(
        settings_validators,
        "_civitai_auth_check",
        side_effect=settings_validators.ValidationFailed("network error: timeout"),
    )
    r = client.post("/api/settings/validate/civitai")
    body = r.json()
    assert body["ok"] is False
    assert "network" in body["error"].lower() or "timeout" in body["error"].lower()


def test_validate_civitai_passes_real_token(client, store, mocker):
    store.set_credential("civitai_api_key", "civ_actual_token")
    spy = mocker.patch.object(
        settings_validators,
        "_civitai_auth_check",
        return_value={"username": "tester"},
    )
    client.post("/api/settings/validate/civitai")
    assert spy.call_args.kwargs.get("api_key") == "civ_actual_token"


# === sgs-ui-6px: HuggingFace token validator ================================

def test_validate_huggingface_unconfigured_returns_400(client, store):
    r = client.post("/api/settings/validate/huggingface")
    assert r.status_code == 400
    assert "hf_token" in r.json()["detail"]


def test_validate_huggingface_success(client, store, mocker):
    store.set_credential("hf_token", "hf_valid_xxx")
    mocker.patch.object(
        settings_validators,
        "_huggingface_auth_check",
        return_value={"name": "aviv-test", "type": "user"},
    )
    r = client.post("/api/settings/validate/huggingface")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["error"] is None


def test_validate_huggingface_401_returns_ok_false(client, store, mocker):
    store.set_credential("hf_token", "hf_bad")
    mocker.patch.object(
        settings_validators,
        "_huggingface_auth_check",
        side_effect=settings_validators.ValidationFailed("HTTP 401: invalid token"),
    )
    r = client.post("/api/settings/validate/huggingface")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "401" in body["error"]


def test_validate_huggingface_passes_real_token(client, store, mocker):
    store.set_credential("hf_token", "hf_actual_token")
    spy = mocker.patch.object(
        settings_validators,
        "_huggingface_auth_check",
        return_value={"name": "tester"},
    )
    client.post("/api/settings/validate/huggingface")
    assert spy.call_args.kwargs.get("token") == "hf_actual_token"


def test_huggingface_in_validators_and_credentials_map():
    """Registry plumbing: huggingface must be both runnable and map to
    hf_token for cache-invalidation when the credential changes."""
    assert "huggingface" in settings_validators.VALIDATORS
    assert settings_validators.VALIDATOR_CREDENTIALS["huggingface"] == ("hf_token",)


# === sgs-ui-5nn: R2 round-trip extension ====================================

def test_validate_r2_does_round_trip_after_head_bucket(client, configured_r2, mocker):
    """sgs-ui-5nn option B: after head_bucket passes, validator must perform a
    put/presigned-get/delete round-trip on the test key 'sgs-ui/.preflight-test'
    to verify the worker's actual code path works (put + get perms + presigned URLs)."""
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.return_value = {}
    fake_client.put_object.return_value = {"ETag": '"abc"'}
    fake_client.generate_presigned_url.return_value = "https://x.example/presigned"
    fake_client.delete_object.return_value = {}
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)
    # Mock the HTTP GET on the presigned URL
    mocker.patch.object(
        settings_validators,
        "_r2_fetch_presigned",
        return_value=settings_validators.R2_ROUND_TRIP_PAYLOAD,
    )

    r = client.post("/api/settings/validate/r2")

    assert r.status_code == 200, r.json()
    assert r.json()["ok"] is True
    fake_client.head_bucket.assert_called_once_with(Bucket="my-bucket")
    fake_client.put_object.assert_called_once()
    put_kwargs = fake_client.put_object.call_args.kwargs
    assert put_kwargs["Bucket"] == "my-bucket"
    assert put_kwargs["Key"] == "sgs-ui/.preflight-test"
    fake_client.generate_presigned_url.assert_called_once()
    fake_client.delete_object.assert_called_once_with(
        Bucket="my-bucket", Key="sgs-ui/.preflight-test"
    )


def test_validate_r2_put_failure_surfaced(client, configured_r2, mocker):
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.return_value = {}
    fake_client.put_object.side_effect = Exception(
        "An error occurred (AccessDenied) when calling the PutObject operation"
    )
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)

    r = client.post("/api/settings/validate/r2")
    body = r.json()
    assert body["ok"] is False
    assert "AccessDenied" in body["error"]
    assert "PutObject" in body["error"]


def test_validate_r2_presigned_get_mismatch_surfaced(client, configured_r2, mocker):
    """If the round-trip GET returns content different from what we PUT,
    surface that — it usually means presigned-URL host config is wrong."""
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.return_value = {}
    fake_client.put_object.return_value = {"ETag": '"abc"'}
    fake_client.generate_presigned_url.return_value = "https://x.example/presigned"
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)
    mocker.patch.object(
        settings_validators,
        "_r2_fetch_presigned",
        return_value=b"WRONG-CONTENT",
    )

    r = client.post("/api/settings/validate/r2")
    body = r.json()
    assert body["ok"] is False
    assert "round-trip" in body["error"].lower() or "mismatch" in body["error"].lower()
    # delete_object must still be called for cleanup even on mismatch
    fake_client.delete_object.assert_called_once()


def test_validate_r2_delete_failure_is_warning_not_failure(client, configured_r2, mocker):
    """The test object MUST be deleted on success path. If delete fails, that's
    a real problem — surface it. But the validator should still report ok=True
    if put + get succeeded (the user's worker round-trip works, the orphan is
    a known issue surfaced via info, not a hard failure)."""
    fake_client = mocker.MagicMock()
    fake_client.head_bucket.return_value = {}
    fake_client.put_object.return_value = {"ETag": '"abc"'}
    fake_client.generate_presigned_url.return_value = "https://x.example/presigned"
    fake_client.delete_object.side_effect = Exception("AccessDenied: DeleteObject")
    mocker.patch.object(settings_validators, "_make_r2_client", return_value=fake_client)
    mocker.patch.object(
        settings_validators,
        "_r2_fetch_presigned",
        return_value=settings_validators.R2_ROUND_TRIP_PAYLOAD,
    )

    r = client.post("/api/settings/validate/r2")
    body = r.json()
    # Round-trip succeeded — ok=True. Delete failure surfaced via info.
    assert body["ok"] is True
    assert body["info"] and body["info"].get("cleanup_warning")
    assert "DeleteObject" in body["info"]["cleanup_warning"]


# === sgs-ui-5nn: validation persistence =====================================

def test_validate_runpod_persists_result_in_store(client, store, mocker):
    """Successful validation must record validated_at + ok in the store (keyed
    by SERVICE name, not credential name — service 'runpod' covers the single
    'runpod_api_key' credential)."""
    store.set_credential("runpod_api_key", "rpa_persist")
    mocker.patch.object(
        settings_validators,
        "_runpod_graphql_post",
        return_value={"data": {"gpuTypes": [{"id": "X"}]}},
    )

    before = store.get_credential_validation("runpod")
    assert before is None

    r = client.post("/api/settings/validate/runpod")
    assert r.status_code == 200

    after = store.get_credential_validation("runpod")
    assert after is not None
    assert after["ok"] is True
    assert after["validated_at"]
    assert after["error"] is None


def test_validate_runpod_failed_validation_persisted(client, store, mocker):
    store.set_credential("runpod_api_key", "rpa_bad")
    mocker.patch.object(
        settings_validators,
        "_runpod_graphql_post",
        side_effect=settings_validators.ValidationFailed("HTTP 401"),
    )
    client.post("/api/settings/validate/runpod")
    record = store.get_credential_validation("runpod")
    assert record is not None
    assert record["ok"] is False
    assert "401" in record["error"]


def test_validation_record_cleared_when_underlying_credential_changes(store):
    """Changing a credential value (e.g. runpod_api_key) must invalidate the
    cached validation for every service that depends on it (here, 'runpod')."""
    store.set_credential("runpod_api_key", "rpa_old")
    store.set_credential_validation(
        "runpod",
        {"ok": True, "error": None, "validated_at": "2026-01-01T00:00:00+00:00"},
    )
    assert store.get_credential_validation("runpod") is not None

    store.set_credential("runpod_api_key", "rpa_new")
    assert store.get_credential_validation("runpod") is None


def test_validation_record_cleared_for_r2_when_any_r2_field_changes(store):
    """The R2 validator depends on 4 credentials — changing ANY of them
    must clear the cached r2 validation."""
    for field in ("r2_endpoint_url", "r2_access_key_id", "r2_secret_access_key", "r2_bucket"):
        store.set_credential(field, f"orig_{field}")
    store.set_credential_validation(
        "r2", {"ok": True, "error": None, "validated_at": "2026-01-01T00:00:00+00:00"}
    )
    assert store.get_credential_validation("r2") is not None

    # Change only one field — r2 validation should still clear.
    store.set_credential("r2_bucket", "new-bucket")
    assert store.get_credential_validation("r2") is None


def test_validation_record_preserved_when_credential_value_unchanged(store):
    """Saving the same credential value (e.g. resave from settings UI) should
    NOT clear the validation cache — only an actual value change does."""
    store.set_credential("runpod_api_key", "rpa_same")
    store.set_credential_validation(
        "runpod", {"ok": True, "error": None, "validated_at": "2026-01-01T00:00:00+00:00"}
    )
    store.set_credential("runpod_api_key", "rpa_same")  # resave same value
    assert store.get_credential_validation("runpod") is not None
