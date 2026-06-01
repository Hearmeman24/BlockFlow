"""HTTP route tests for settings (sgs-ui-wisp-las.1 Stage 1).

Validates the full HTTP path against the real settings store via TestClient.
Tests assert ACTUAL state — body shape, state written to the store, side
effects — not just status codes.

Scope: CRUD for credentials, endpoints, app_prefs. Validation endpoints (which
call external services) are out of scope here — they belong in Stage 1.5 and
require the mock-at-boundary pattern.
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
    db_path = tmp_path / "settings_routes_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()

    app = FastAPI()
    app.include_router(settings_router)
    return TestClient(app)


# === credentials CRUD =======================================================

def test_list_credentials_empty(client):
    r = client.get("/api/settings/credentials")
    assert r.status_code == 200
    assert r.json() == {"credentials": []}


def test_put_credential_stores_and_get_returns_it(client):
    r = client.put("/api/settings/credentials/runpod_api_key", json={"value": "rpa_secret"})
    assert r.status_code == 200
    assert r.json() == {"name": "runpod_api_key", "saved": True}

    # State assertion: actually persisted in the store
    assert settings_store.get_credential("runpod_api_key") == "rpa_secret"

    # And the GET endpoint reads it back
    r2 = client.get("/api/settings/credentials/runpod_api_key")
    assert r2.status_code == 200
    body = r2.json()
    assert body["name"] == "runpod_api_key"
    assert body["value"] == "rpa_secret"
    assert "updated_at" in body and body["updated_at"]


def test_get_credential_not_found(client):
    r = client.get("/api/settings/credentials/never_set")
    assert r.status_code == 404


def test_put_credential_update_overwrites(client):
    client.put("/api/settings/credentials/openrouter_api_key", json={"value": "old"})
    client.put("/api/settings/credentials/openrouter_api_key", json={"value": "new"})
    r = client.get("/api/settings/credentials/openrouter_api_key")
    assert r.json()["value"] == "new"


def test_delete_credential(client):
    client.put("/api/settings/credentials/topaz_api_key", json={"value": "x"})
    r = client.delete("/api/settings/credentials/topaz_api_key")
    assert r.status_code == 204
    assert client.get("/api/settings/credentials/topaz_api_key").status_code == 404


def test_delete_credential_idempotent(client):
    """Deleting an unset credential returns 204, not 404 — idempotent."""
    r = client.delete("/api/settings/credentials/never_existed")
    assert r.status_code == 204


def test_put_credential_missing_value_field_returns_400(client):
    """PUT body must include `value`."""
    r = client.put("/api/settings/credentials/runpod_api_key", json={})
    assert r.status_code in (400, 422)
    # No leak into the store
    assert settings_store.get_credential("runpod_api_key") is None


def test_put_credential_with_empty_string_value_is_allowed(client):
    """Empty-string is a valid value distinct from unset."""
    r = client.put("/api/settings/credentials/r2_secret", json={"value": ""})
    assert r.status_code == 200
    r2 = client.get("/api/settings/credentials/r2_secret")
    assert r2.json()["value"] == ""


def test_put_credential_unicode_value_preserved(client):
    client.put("/api/settings/credentials/note", json={"value": "héllo 你好 🔑"})
    r = client.get("/api/settings/credentials/note")
    assert r.json()["value"] == "héllo 你好 🔑"


def test_list_credentials_returns_sorted_names(client):
    client.put("/api/settings/credentials/runpod_api_key", json={"value": "x"})
    client.put("/api/settings/credentials/civitai_api_key", json={"value": "y"})
    client.put("/api/settings/credentials/imgbb_api_key", json={"value": "z"})

    r = client.get("/api/settings/credentials")
    assert r.json() == {"credentials": ["civitai_api_key", "imgbb_api_key", "runpod_api_key"]}


# === endpoints CRUD =========================================================

def test_list_endpoints_empty(client):
    r = client.get("/api/settings/endpoints")
    assert r.status_code == 200
    assert r.json() == {"endpoints": []}


def test_put_endpoint_full_round_trip(client):
    payload = {
        "endpoint_id": "ep_abc123",
        "volume_id": "vol_xyz",
        "template_id": "tmpl_abc",
        "gpu_tier": "recommended",
        "volume_size_gb": 200,
        "max_workers": 3,
        "provisioned_at": "2026-05-21T10:00:00Z",
    }
    r = client.put("/api/settings/endpoints/comfygen", json=payload)
    assert r.status_code == 200

    # State assertion: actually persisted
    ep = settings_store.get_endpoint("comfygen")
    assert ep["endpoint_id"] == "ep_abc123"
    assert ep["volume_id"] == "vol_xyz"
    assert ep["max_workers"] == 3

    # GET returns the same shape
    r2 = client.get("/api/settings/endpoints/comfygen")
    assert r2.status_code == 200
    body = r2.json()
    assert body["type"] == "comfygen"
    assert body["endpoint_id"] == "ep_abc123"
    assert body["volume_id"] == "vol_xyz"
    assert body["max_workers"] == 3


def test_put_endpoint_minimal_required_fields_only(client):
    """Only endpoint_id is required; optional fields default to null."""
    r = client.put("/api/settings/endpoints/aio_trainer", json={"endpoint_id": "ep_t1"})
    assert r.status_code == 200

    r2 = client.get("/api/settings/endpoints/aio_trainer")
    body = r2.json()
    assert body["endpoint_id"] == "ep_t1"
    assert body["volume_id"] is None
    assert body["template_id"] is None


def test_put_endpoint_invalid_type_returns_400(client):
    """Endpoint type is constrained — only 'comfygen' and 'aio_trainer' allowed."""
    r = client.put("/api/settings/endpoints/random_unknown_type", json={"endpoint_id": "x"})
    assert r.status_code == 400
    assert "endpoint type" in r.json().get("detail", "").lower() or "type" in r.json().get("detail", "").lower()
    # No leak into the store
    assert settings_store.get_endpoint("random_unknown_type") is None


def test_put_endpoint_missing_endpoint_id_returns_400(client):
    r = client.put("/api/settings/endpoints/comfygen", json={"volume_id": "vol_x"})
    assert r.status_code in (400, 422)
    # No leak
    assert settings_store.get_endpoint("comfygen") is None


def test_get_endpoint_not_found(client):
    r = client.get("/api/settings/endpoints/comfygen")
    assert r.status_code == 404


def test_delete_endpoint(client):
    client.put("/api/settings/endpoints/comfygen", json={"endpoint_id": "ep_x"})
    r = client.delete("/api/settings/endpoints/comfygen")
    assert r.status_code == 204
    assert client.get("/api/settings/endpoints/comfygen").status_code == 404


def test_delete_endpoint_idempotent(client):
    r = client.delete("/api/settings/endpoints/aio_trainer")
    assert r.status_code == 204


def test_list_endpoints_returns_configured_types_sorted(client):
    client.put("/api/settings/endpoints/comfygen", json={"endpoint_id": "c1"})
    client.put("/api/settings/endpoints/aio_trainer", json={"endpoint_id": "t1"})

    r = client.get("/api/settings/endpoints")
    body = r.json()
    types = [e["type"] for e in body["endpoints"]]
    assert types == ["aio_trainer", "comfygen"]


def test_put_endpoint_update_is_full_replace(client):
    """A subsequent PUT replaces the full row — fields omitted become null."""
    client.put("/api/settings/endpoints/comfygen", json={"endpoint_id": "ep_a", "volume_id": "vol_a", "gpu_tier": "budget"})
    client.put("/api/settings/endpoints/comfygen", json={"endpoint_id": "ep_b", "gpu_tier": "performance"})

    r = client.get("/api/settings/endpoints/comfygen")
    body = r.json()
    assert body["endpoint_id"] == "ep_b"
    assert body["gpu_tier"] == "performance"
    assert body["volume_id"] is None  # cleared, not preserved


# === app_prefs CRUD =========================================================

def test_app_pref_put_then_get(client, tmp_path):
    # sgs-ui-se7: output_dir is now path-validated on PUT, so use a real dir.
    out = tmp_path / "blockflow_out"
    out.mkdir()
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(out)})
    assert r.status_code == 200

    r2 = client.get("/api/settings/app-prefs/output_dir")
    assert r2.status_code == 200
    assert r2.json() == {"name": "output_dir", "value": str(out)}


def test_app_pref_get_unset_returns_null_value(client):
    r = client.get("/api/settings/app-prefs/never_set")
    assert r.status_code == 200
    assert r.json() == {"name": "never_set", "value": None}


def test_app_pref_get_with_default_query_param(client):
    r = client.get("/api/settings/app-prefs/never_set?default=fallback_value")
    assert r.status_code == 200
    assert r.json() == {"name": "never_set", "value": "fallback_value"}


def test_app_pref_update(client):
    client.put("/api/settings/app-prefs/retention_days", json={"value": "90"})
    client.put("/api/settings/app-prefs/retention_days", json={"value": "30"})
    r = client.get("/api/settings/app-prefs/retention_days")
    assert r.json()["value"] == "30"


def test_app_pref_put_missing_value_returns_400(client):
    r = client.put("/api/settings/app-prefs/output_dir", json={})
    assert r.status_code in (400, 422)


# === isolation across namespaces (regression) ===============================

def test_credentials_endpoints_prefs_are_isolated_namespaces(client):
    """Setting credentials/name=X does not affect endpoints/X or app-prefs/X.

    The three URL spaces are completely independent in the store.
    """
    client.put("/api/settings/credentials/comfygen", json={"value": "this_is_a_credential"})
    client.put("/api/settings/endpoints/comfygen", json={"endpoint_id": "ep_real"})
    client.put("/api/settings/app-prefs/comfygen", json={"value": "this_is_a_pref"})

    assert client.get("/api/settings/credentials/comfygen").json()["value"] == "this_is_a_credential"
    assert client.get("/api/settings/endpoints/comfygen").json()["endpoint_id"] == "ep_real"
    assert client.get("/api/settings/app-prefs/comfygen").json()["value"] == "this_is_a_pref"


# === GET validation status (sgs-ui storage R2 gating) =======================
# The Storage tab needs to read the *cached* validation verdict for a service
# WITHOUT running a live (slow, network) validation. A successful validation
# stays valid until an underlying credential value changes or a real provider
# auth failure records an invalid verdict.

def _stamp_r2_validation(ok: bool, *, age_seconds: int = 0, error=None):
    from datetime import datetime, timedelta, timezone
    ts = (datetime.now(timezone.utc) - timedelta(seconds=age_seconds)).isoformat(timespec="seconds")
    settings_store.set_credential_validation("r2", {"ok": ok, "error": error, "validated_at": ts})


def _configure_r2():
    settings_store.set_credential("r2_access_key_id", "AKIA_TEST")
    settings_store.set_credential("r2_secret_access_key", "sekret")
    settings_store.set_credential("r2_bucket", "my-bucket")


def test_validation_status_unknown_service_404(client):
    r = client.get("/api/settings/validate/not_a_service")
    assert r.status_code == 404


def test_validation_status_credentials_missing(client):
    r = client.get("/api/settings/validate/r2")
    assert r.status_code == 200
    assert r.json()["status"] == "credentials_missing"


def test_validation_status_unvalidated_when_creds_present_no_verdict(client):
    _configure_r2()
    r = client.get("/api/settings/validate/r2")
    assert r.json()["status"] == "unvalidated"


def test_validation_status_valid_when_ok(client):
    _configure_r2()
    _stamp_r2_validation(True, age_seconds=0)
    body = client.get("/api/settings/validate/r2").json()
    assert body["status"] == "valid"
    assert body["validated_at"]


def test_validation_status_valid_when_ok_even_if_old(client):
    _configure_r2()
    _stamp_r2_validation(True, age_seconds=601)
    assert client.get("/api/settings/validate/r2").json()["status"] == "valid"


def test_validation_status_invalid_surfaces_error(client):
    _configure_r2()
    _stamp_r2_validation(False, error="head_bucket AccessDenied")
    body = client.get("/api/settings/validate/r2").json()
    assert body["status"] == "invalid"
    assert body["error"] == "head_bucket AccessDenied"


def test_validation_status_endpoint_url_is_optional_for_r2(client):
    """r2_endpoint_url empty (AWS S3 default) must NOT report credentials_missing
    once the three required fields are present."""
    _configure_r2()  # leaves r2_endpoint_url unset
    assert client.get("/api/settings/validate/r2").json()["status"] == "unvalidated"


def test_validation_status_changing_credential_resets_to_unvalidated(client):
    """Regression: store auto-clears the cached verdict when an underlying
    credential changes, so the status endpoint must drop back to unvalidated."""
    _configure_r2()
    _stamp_r2_validation(True, age_seconds=0)
    assert client.get("/api/settings/validate/r2").json()["status"] == "valid"
    # mutate a dependency credential
    client.put("/api/settings/credentials/r2_bucket", json={"value": "other-bucket"})
    assert client.get("/api/settings/validate/r2").json()["status"] == "unvalidated"
