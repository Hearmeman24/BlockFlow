"""HTTP route tests for the ComfyGen setup wizard (sgs-ui-wisp-las.2 Stage B).

The wizard orchestrates the runpod_api client + Settings store to spin up a
new ComfyGen endpoint. Tests mock runpod_api at the boundary so the wizard's
sequencing + credential plumbing + Settings persistence runs for real.

Routes covered:
  - POST /api/wizard/comfygen/provision   (create-new flow)
  - POST /api/wizard/comfygen/attach      (attach-existing flow)
  - GET  /api/wizard/comfygen/health/{ep} (proxy to RunPod /v2 health)
  - GET  /api/wizard/comfygen/tiers       (UI helper)
  - GET  /api/wizard/comfygen/preflight   (validate creds before launch)
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store, wizard_routes  # noqa: E402


@pytest.fixture
def app(tmp_path, monkeypatch):
    db_path = tmp_path / "wizard_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()

    fastapi_app = FastAPI()
    fastapi_app.include_router(wizard_routes.router)
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def all_creds_configured():
    """Populate Settings with all credentials the wizard needs."""
    settings_store.set_credential("runpod_api_key", "rpa_valid")
    settings_store.set_credential("r2_endpoint_url", "https://x.r2.cloudflarestorage.com")
    settings_store.set_credential("r2_access_key_id", "AKIA_TEST")
    settings_store.set_credential("r2_secret_access_key", "sekret")
    settings_store.set_credential("r2_bucket", "my-bucket")


@pytest.fixture
def all_creds_validated(all_creds_configured):
    """sgs-ui-5nn: provision/attach also check that creds were validated
    within the TTL. Tests that mutate Settings before posting need fresh
    validation rows; this fixture stamps them."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    settings_store.set_credential_validation(
        "runpod", {"ok": True, "error": None, "validated_at": now}
    )
    settings_store.set_credential_validation(
        "r2", {"ok": True, "error": None, "validated_at": now}
    )


# === preflight ==============================================================

def test_preflight_reports_all_credentials_missing(client):
    r = client.get("/api/wizard/comfygen/preflight")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is False
    assert "runpod_api_key" in body["missing"]
    # r2_endpoint_url is OPTIONAL (empty means default AWS S3 endpoint),
    # so it must NOT appear in the missing list when unset.
    assert "r2_endpoint_url" not in body["missing"]
    assert "r2_access_key_id" in body["missing"]
    assert "r2_secret_access_key" in body["missing"]
    assert "r2_bucket" in body["missing"]


def test_preflight_missing_empty_with_empty_endpoint_url_for_aws_s3(client):
    """Users on AWS S3 (not Cloudflare R2) leave r2_endpoint_url empty —
    boto3 defaults to the AWS endpoint. Preflight must NOT report r2_endpoint_url
    as missing.

    sgs-ui-5nn note: ready=True now also requires validation, so this test
    only asserts the `missing` field. Validation-gated readiness is covered
    in test_preflight_ready_when_required_services_validated_within_ttl.
    """
    settings_store.set_credential("runpod_api_key", "rpa")
    settings_store.set_credential("r2_access_key_id", "AKIA_aws")
    settings_store.set_credential("r2_secret_access_key", "secret_aws")
    settings_store.set_credential("r2_bucket", "hearmeman-loras")
    # r2_endpoint_url deliberately not set

    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["missing"] == []


def test_preflight_no_missing_when_all_present(client, all_creds_configured):
    """sgs-ui-5nn: presence of creds no longer implies ready=True; only
    `missing` is empty. ready=True needs validation (separate test)."""
    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["missing"] == []
    assert body["services"]["runpod"]["status"] == "unvalidated"
    assert body["services"]["r2"]["status"] == "unvalidated"


def test_preflight_lists_only_actually_missing_creds(client):
    settings_store.set_credential("runpod_api_key", "rpa")
    settings_store.set_credential("r2_endpoint_url", "https://x.r2.com")
    # access_key, secret, bucket NOT set

    r = client.get("/api/wizard/comfygen/preflight")
    body = r.json()
    assert body["ready"] is False
    assert "runpod_api_key" not in body["missing"]
    assert "r2_endpoint_url" not in body["missing"]
    assert "r2_access_key_id" in body["missing"]


# === sgs-ui-5nn: preflight validation gating ================================
#
# Old behavior: ready = True iff all required credentials are non-empty.
# New behavior: ready = True iff all required credentials are present AND
# validated successfully within the TTL window. Preflight is a pure reader;
# the UI calls /api/settings/validate/{service} to refresh stale validations.

def _stamp_validation(service: str, ok: bool, validated_at: str, error: str | None = None) -> None:
    settings_store.set_credential_validation(
        service,
        {"ok": ok, "error": error, "validated_at": validated_at},
    )


def _iso(seconds_ago: int = 0) -> str:
    from datetime import datetime, timedelta, timezone
    t = datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
    return t.isoformat(timespec="seconds")


def test_preflight_not_ready_when_creds_present_but_unvalidated(client, all_creds_configured):
    """The bug the user identified: creds non-empty was treated as 'ready'.
    With validation gating, unvalidated creds must keep ready=False."""
    r = client.get("/api/wizard/comfygen/preflight")
    body = r.json()
    assert body["ready"] is False
    assert body["services"]["runpod"]["status"] == "unvalidated"
    assert body["services"]["r2"]["status"] == "unvalidated"


def test_preflight_ready_when_required_services_validated_within_ttl(client, all_creds_configured):
    _stamp_validation("runpod", ok=True, validated_at=_iso(seconds_ago=60))
    _stamp_validation("r2", ok=True, validated_at=_iso(seconds_ago=60))

    r = client.get("/api/wizard/comfygen/preflight")
    body = r.json()
    assert body["ready"] is True
    assert body["services"]["runpod"]["status"] == "valid"
    assert body["services"]["r2"]["status"] == "valid"


def test_preflight_stale_validation_does_not_count_as_ready(client, all_creds_configured):
    """A 'valid' validation older than the TTL must surface as status=stale
    and ready=False — the wizard needs a fresh re-check."""
    _stamp_validation("runpod", ok=True, validated_at=_iso(seconds_ago=700))  # > 600s TTL
    _stamp_validation("r2", ok=True, validated_at=_iso(seconds_ago=60))

    r = client.get("/api/wizard/comfygen/preflight")
    body = r.json()
    assert body["ready"] is False
    assert body["services"]["runpod"]["status"] == "stale"
    assert body["services"]["r2"]["status"] == "valid"


def test_preflight_failed_validation_surfaces_error(client, all_creds_configured):
    _stamp_validation("runpod", ok=False, validated_at=_iso(0), error="HTTP 401")
    _stamp_validation("r2", ok=True, validated_at=_iso(0))

    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["ready"] is False
    assert body["services"]["runpod"]["status"] == "invalid"
    assert body["services"]["runpod"]["error"] == "HTTP 401"


def test_preflight_civitai_validated_does_not_gate_ready(client, all_creds_configured):
    """CivitAI is recommended, not required. ready must depend only on
    runpod + r2 validation."""
    _stamp_validation("runpod", ok=True, validated_at=_iso(0))
    _stamp_validation("r2", ok=True, validated_at=_iso(0))
    # CivitAI cred present but never validated
    settings_store.set_credential("civitai_api_key", "civ_tok")
    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["ready"] is True
    assert body["services"]["civitai"]["status"] == "unvalidated"
    assert body["services"]["civitai"]["required"] is False


def test_preflight_civitai_credentials_missing_does_not_gate_ready(
    client, all_creds_configured
):
    """If civitai_api_key is empty entirely (default state), wizard should still
    be launchable so long as required creds are valid."""
    _stamp_validation("runpod", ok=True, validated_at=_iso(0))
    _stamp_validation("r2", ok=True, validated_at=_iso(0))
    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["ready"] is True
    assert body["services"]["civitai"]["status"] == "credentials_missing"


def test_preflight_civitai_invalid_does_not_gate_ready(client, all_creds_configured):
    """Even with CivitAI validation failed, ready stays True so long as required
    services are valid. The UI surfaces CivitAI as a yellow warning, not a block."""
    _stamp_validation("runpod", ok=True, validated_at=_iso(0))
    _stamp_validation("r2", ok=True, validated_at=_iso(0))
    settings_store.set_credential("civitai_api_key", "civ_bad")
    _stamp_validation("civitai", ok=False, validated_at=_iso(0), error="HTTP 401")

    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["ready"] is True
    assert body["services"]["civitai"]["status"] == "invalid"


def test_preflight_required_field_marks_services(client, all_creds_configured):
    _stamp_validation("runpod", ok=True, validated_at=_iso(0))
    _stamp_validation("r2", ok=True, validated_at=_iso(0))
    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["services"]["runpod"]["required"] is True
    assert body["services"]["r2"]["required"] is True
    assert body["services"]["civitai"]["required"] is False


def test_preflight_credentials_missing_overrides_validation(client):
    """Even if a stale validation row exists for r2, an empty r2_bucket
    means the credential is missing — that takes precedence."""
    # Set runpod fully + validated
    settings_store.set_credential("runpod_api_key", "rpa")
    _stamp_validation("runpod", ok=True, validated_at=_iso(0))
    # Set 3 of 4 R2 creds, leave r2_bucket missing, but persist a stale 'valid' row.
    settings_store.set_credential("r2_endpoint_url", "https://x.r2.com")
    settings_store.set_credential("r2_access_key_id", "AKIA")
    settings_store.set_credential("r2_secret_access_key", "sekret")
    _stamp_validation("r2", ok=True, validated_at=_iso(0))

    body = client.get("/api/wizard/comfygen/preflight").json()
    assert body["ready"] is False
    assert "r2_bucket" in body["missing"]
    assert body["services"]["r2"]["status"] == "credentials_missing"


# === tiers ==================================================================

def test_tiers_returns_three_tiers_with_required_fields(client):
    r = client.get("/api/wizard/comfygen/tiers")
    assert r.status_code == 200
    tiers = r.json()["tiers"]
    assert len(tiers) == 3

    ids = [t["id"] for t in tiers]
    assert ids == ["budget", "recommended", "performance"]

    for t in tiers:
        # Every tier exposes the fields the UI uses
        assert {"id", "name", "gpu_ids", "datacenter", "label", "region"} <= set(t.keys())
        assert isinstance(t["gpu_ids"], list) and len(t["gpu_ids"]) >= 1


# === provision (happy path) =================================================

def test_provision_calls_runpod_api_in_correct_sequence(client, all_creds_validated, mocker):
    """Volume → Template → Endpoint, each receiving the right args."""
    create_volume = mocker.patch.object(
        wizard_routes.runpod_api, "create_network_volume",
        return_value={"id": "vol_abc", "name": "v"},
    )
    create_template = mocker.patch.object(
        wizard_routes.runpod_api, "create_template",
        return_value={"id": "tmpl_abc", "name": "t"},
    )
    create_endpoint = mocker.patch.object(
        wizard_routes.runpod_api, "create_endpoint",
        return_value={"id": "ep_abc"},
    )

    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})

    assert r.status_code == 200
    body = r.json()
    assert body["endpoint_id"] == "ep_abc"
    assert body["template_id"] == "tmpl_abc"
    assert body["volume_id"] == "vol_abc"
    # template_name is returned so the caller can later issue deleteTemplate
    # (which requires NAME not ID per the RunPod teardown research)
    assert "template_name" in body and body["template_name"]

    # Sequence verification
    create_volume.assert_called_once()
    create_template.assert_called_once()
    create_endpoint.assert_called_once()

    # Volume args
    vol_kwargs = create_volume.call_args.kwargs
    assert vol_kwargs["size_gb"] == 200  # default
    assert vol_kwargs["datacenter_id"] == "EU-RO-1"  # budget tier's DC

    # Template args: R2 creds must be injected into env vars
    tmpl_kwargs = create_template.call_args.kwargs
    env = tmpl_kwargs["env"]
    assert env["AWS_ACCESS_KEY_ID"] == "AKIA_TEST"
    assert env["AWS_SECRET_ACCESS_KEY"] == "sekret"
    assert env["S3_BUCKET"] == "my-bucket"
    assert env["S3_ENDPOINT_URL"] == "https://x.r2.cloudflarestorage.com"
    assert env["RUNTIME_REPO_URL"]  # must be set to ComfyGen handler repo
    assert tmpl_kwargs["image_name"]  # ComfyGen image

    # Endpoint args: uses the just-created template + volume + tier GPUs
    ep_kwargs = create_endpoint.call_args.kwargs
    assert ep_kwargs["template_id"] == "tmpl_abc"
    assert ep_kwargs["network_volume_id"] == "vol_abc"
    assert ep_kwargs["gpu_type_ids"] == ["NVIDIA GeForce RTX 5090"]  # budget tier
    assert ep_kwargs["workers_max"] == 3  # default


def test_provision_persists_endpoint_to_settings(client, all_creds_validated, mocker):
    mocker.patch.object(wizard_routes.runpod_api, "create_network_volume",
                        return_value={"id": "vol_x"})
    mocker.patch.object(wizard_routes.runpod_api, "create_template",
                        return_value={"id": "tmpl_x"})
    mocker.patch.object(wizard_routes.runpod_api, "create_endpoint",
                        return_value={"id": "ep_x"})

    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})
    template_name = r.json()["template_name"]

    # State assertion: Settings store actually has the endpoint persisted
    ep = settings_store.get_endpoint("comfygen")
    assert ep is not None
    assert ep["endpoint_id"] == "ep_x"
    assert ep["template_id"] == "tmpl_x"
    # Regression for Stage B's live-smoke finding: template_name MUST be
    # persisted so tear-down can call deleteTemplate(name=...) later.
    assert ep["template_name"] == template_name
    assert ep["volume_id"] == "vol_x"
    assert ep["gpu_tier"] == "budget"


def test_provision_passes_user_supplied_volume_size_and_max_workers(client, all_creds_validated, mocker):
    create_volume = mocker.patch.object(wizard_routes.runpod_api, "create_network_volume",
                                        return_value={"id": "vol_x"})
    mocker.patch.object(wizard_routes.runpod_api, "create_template", return_value={"id": "tmpl_x"})
    create_endpoint = mocker.patch.object(wizard_routes.runpod_api, "create_endpoint",
                                          return_value={"id": "ep_x"})

    client.post("/api/wizard/comfygen/provision", json={
        "tier": "recommended",
        "volume_size_gb": 500,
        "max_workers": 1,
    })

    assert create_volume.call_args.kwargs["size_gb"] == 500
    assert create_endpoint.call_args.kwargs["workers_max"] == 1
    # tier-specific datacenter
    assert create_volume.call_args.kwargs["datacenter_id"] == "EUR-IS-1"


# === provision (failure modes) ==============================================

def test_provision_400_when_runpod_key_missing(client):
    """No credentials at all — should fail before any API call."""
    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})
    assert r.status_code == 400
    assert "runpod_api_key" in r.json()["detail"]


def test_provision_400_when_partial_r2_creds(client):
    settings_store.set_credential("runpod_api_key", "rpa")
    settings_store.set_credential("r2_endpoint_url", "https://x.r2.com")
    settings_store.set_credential("r2_access_key_id", "AKIA")
    # missing r2_secret_access_key + r2_bucket

    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    for missing in ("r2_secret_access_key", "r2_bucket"):
        assert missing in detail
    # r2_endpoint_url is NOT in the required list — empty = default AWS S3
    assert "r2_endpoint_url" not in detail


def test_provision_400_when_tier_invalid(client, all_creds_configured):
    """Pydantic Literal type rejects unknown tiers with 422 before our code
    runs — which is fine, the UI still sees a validation error."""
    r = client.post("/api/wizard/comfygen/provision", json={"tier": "ultra"})
    assert r.status_code in (400, 422)
    body = r.json()
    # Either way, the error mentions the bad input
    detail_str = str(body)
    assert "ultra" in detail_str or "tier" in detail_str


def test_provision_rolls_back_volume_if_template_creation_fails(client, all_creds_validated, mocker):
    """If template creation fails after volume was created, the volume should be deleted.

    Otherwise we leave dangling resources the user has to clean up manually."""
    mocker.patch.object(wizard_routes.runpod_api, "create_network_volume",
                        return_value={"id": "vol_will_orphan"})
    mocker.patch.object(wizard_routes.runpod_api, "create_template",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("template create failed"))
    delete_volume = mocker.patch.object(wizard_routes.runpod_api, "delete_network_volume")

    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})

    assert r.status_code == 500
    assert "template create failed" in r.json()["detail"]
    # Rollback: volume gets deleted
    delete_volume.assert_called_once_with("rpa_valid", "vol_will_orphan")
    # Settings was NOT mutated (provisioning failed)
    assert settings_store.get_endpoint("comfygen") is None


def test_provision_rolls_back_volume_and_template_if_endpoint_creation_fails(client, all_creds_validated, mocker):
    mocker.patch.object(wizard_routes.runpod_api, "create_network_volume",
                        return_value={"id": "vol_x"})
    mocker.patch.object(wizard_routes.runpod_api, "create_template",
                        return_value={"id": "tmpl_x"})
    mocker.patch.object(wizard_routes.runpod_api, "create_endpoint",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("quota exceeded"))
    delete_volume = mocker.patch.object(wizard_routes.runpod_api, "delete_network_volume")
    delete_template = mocker.patch.object(wizard_routes.runpod_api, "delete_template")

    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})

    assert r.status_code == 500
    delete_template.assert_called_once()
    delete_volume.assert_called_once()
    assert settings_store.get_endpoint("comfygen") is None


# === attach (attach-existing flow) ==========================================

def test_attach_persists_existing_endpoint_after_health_check(client, all_creds_validated, mocker):
    """User provides an endpoint ID; we verify it's reachable via /health, then store it."""
    health = mocker.patch.object(wizard_routes.runpod_api, "get_endpoint_health",
                                 return_value={"workers": {"ready": 0, "idle": 0}})

    r = client.post("/api/wizard/comfygen/attach", json={
        "endpoint_id": "ep_user_existing",
        "volume_id": "vol_user_existing",
    })

    assert r.status_code == 200
    health.assert_called_once_with("rpa_valid", "ep_user_existing")
    ep = settings_store.get_endpoint("comfygen")
    assert ep["endpoint_id"] == "ep_user_existing"
    assert ep["volume_id"] == "vol_user_existing"


def test_attach_400_when_health_check_fails(client, all_creds_validated, mocker):
    mocker.patch.object(wizard_routes.runpod_api, "get_endpoint_health",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("HTTP 404"))

    r = client.post("/api/wizard/comfygen/attach", json={"endpoint_id": "ep_bad"})

    assert r.status_code == 400
    assert "ep_bad" in r.json()["detail"] or "404" in r.json()["detail"]
    assert settings_store.get_endpoint("comfygen") is None


def test_attach_400_when_runpod_key_missing(client):
    r = client.post("/api/wizard/comfygen/attach", json={"endpoint_id": "ep_x"})
    assert r.status_code == 400
    assert "runpod_api_key" in r.json()["detail"]


# === sgs-ui-5nn: provision + attach validation gating =======================

def test_provision_refuses_when_runpod_unvalidated(client, all_creds_configured, mocker):
    """Backend defense in depth: even if the UI is bypassed, provision must
    refuse to spawn RunPod resources without fresh validation."""
    create_volume = mocker.patch.object(wizard_routes.runpod_api, "create_network_volume")
    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})
    assert r.status_code == 400
    assert "validated" in r.json()["detail"].lower()
    create_volume.assert_not_called()


def test_provision_refuses_when_r2_unvalidated(client, all_creds_configured, mocker):
    settings_store.set_credential_validation(
        "runpod", {"ok": True, "error": None, "validated_at": _iso(0)}
    )
    # r2 deliberately not validated
    create_volume = mocker.patch.object(wizard_routes.runpod_api, "create_network_volume")
    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})
    assert r.status_code == 400
    assert "r2" in r.json()["detail"].lower() or "validated" in r.json()["detail"].lower()
    create_volume.assert_not_called()


def test_provision_refuses_when_validation_is_stale(client, all_creds_configured, mocker):
    """A stale 'valid' row (older than TTL) must NOT pass the gate."""
    settings_store.set_credential_validation(
        "runpod", {"ok": True, "error": None, "validated_at": _iso(seconds_ago=700)}
    )
    settings_store.set_credential_validation(
        "r2", {"ok": True, "error": None, "validated_at": _iso(0)}
    )
    create_volume = mocker.patch.object(wizard_routes.runpod_api, "create_network_volume")
    r = client.post("/api/wizard/comfygen/provision", json={"tier": "budget"})
    assert r.status_code == 400
    create_volume.assert_not_called()


def test_attach_refuses_when_r2_unvalidated(client, all_creds_configured, mocker):
    """sgs-ui-5nn Q11: attach must validate R2 round-trip (cached) before
    persisting the endpoint. The UI's attach button is the only path where
    a user can hook up an existing endpoint, and we want to catch the
    'attached endpoint uses a different bucket' class of failures upfront."""
    settings_store.set_credential_validation(
        "runpod", {"ok": True, "error": None, "validated_at": _iso(0)}
    )
    # r2 deliberately not validated
    health = mocker.patch.object(wizard_routes.runpod_api, "get_endpoint_health")
    r = client.post(
        "/api/wizard/comfygen/attach", json={"endpoint_id": "ep_x"}
    )
    assert r.status_code == 400
    assert "r2" in r.json()["detail"].lower() or "validated" in r.json()["detail"].lower()
    health.assert_not_called()
    assert settings_store.get_endpoint("comfygen") is None


# === health (proxy) =========================================================

def test_health_proxies_to_runpod_api(client, all_creds_configured, mocker):
    workers = {"ready": 2, "idle": 1, "running": 0, "initializing": 0}
    mocker.patch.object(wizard_routes.runpod_api, "get_endpoint_health",
                        return_value={"workers": workers})

    r = client.get("/api/wizard/comfygen/health/ep_abc")

    assert r.status_code == 200
    assert r.json() == {"workers": workers}


def test_health_returns_400_when_runpod_key_missing(client):
    r = client.get("/api/wizard/comfygen/health/ep_abc")
    assert r.status_code == 400


def test_health_returns_502_when_runpod_unreachable(client, all_creds_configured, mocker):
    mocker.patch.object(wizard_routes.runpod_api, "get_endpoint_health",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("network error"))
    r = client.get("/api/wizard/comfygen/health/ep_abc")
    assert r.status_code == 502
    assert "network" in r.json()["detail"].lower()


# === teardown (sgs-ui-wisp-las.1 Stage 5.5) =================================

@pytest.fixture
def comfygen_endpoint_configured():
    """Pretend the user previously provisioned a ComfyGen endpoint via the
    wizard — populate Settings as if Stage B's provision route had run."""
    settings_store.set_credential("runpod_api_key", "rpa_valid")
    settings_store.set_endpoint(
        "comfygen",
        endpoint_id="ep_abc",
        template_id="tmpl_abc",
        template_name="blockflow-comfygen-abc-template-abc",
        volume_id="vol_abc",
        gpu_tier="budget",
        volume_size_gb=200,
        max_workers=3,
    )


def test_teardown_calls_runpod_api_in_correct_order(client, comfygen_endpoint_configured, mocker):
    """Drain workers → delete endpoint → delete template (by NAME) → delete volume."""
    drain = mocker.patch.object(wizard_routes.runpod_api, "update_endpoint_workers")
    del_ep = mocker.patch.object(wizard_routes.runpod_api, "delete_endpoint")
    del_tmpl = mocker.patch.object(wizard_routes.runpod_api, "delete_template")
    del_vol = mocker.patch.object(wizard_routes.runpod_api, "delete_network_volume")

    r = client.post("/api/wizard/comfygen/teardown")

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # Each step ran exactly once with the right ID/name
    drain.assert_called_once_with("rpa_valid", "ep_abc", workers_min=0, workers_max=0)
    del_ep.assert_called_once_with("rpa_valid", "ep_abc")
    del_tmpl.assert_called_once_with("rpa_valid", template_name="blockflow-comfygen-abc-template-abc")
    del_vol.assert_called_once_with("rpa_valid", "vol_abc")
    # Response shape: report what was deleted so the UI can render confirmation
    assert body["deleted"]["endpoint_id"] == "ep_abc"
    assert body["deleted"]["template_name"] == "blockflow-comfygen-abc-template-abc"
    assert body["deleted"]["volume_id"] == "vol_abc"


def test_teardown_removes_settings_record_on_success(client, comfygen_endpoint_configured, mocker):
    mocker.patch.object(wizard_routes.runpod_api, "update_endpoint_workers")
    mocker.patch.object(wizard_routes.runpod_api, "delete_endpoint")
    mocker.patch.object(wizard_routes.runpod_api, "delete_template")
    mocker.patch.object(wizard_routes.runpod_api, "delete_network_volume")

    assert settings_store.get_endpoint("comfygen") is not None
    client.post("/api/wizard/comfygen/teardown")
    assert settings_store.get_endpoint("comfygen") is None


def test_teardown_404_when_no_endpoint_configured(client):
    settings_store.set_credential("runpod_api_key", "rpa_valid")
    # No endpoint in Settings
    r = client.post("/api/wizard/comfygen/teardown")
    assert r.status_code == 404
    assert "no comfygen endpoint" in r.json()["detail"].lower()


def test_teardown_400_when_runpod_key_missing(client):
    settings_store.set_endpoint(
        "comfygen",
        endpoint_id="ep_x",
        template_name="t",
        volume_id="v",
    )
    r = client.post("/api/wizard/comfygen/teardown")
    assert r.status_code == 400
    assert "runpod_api_key" in r.json()["detail"]


def test_teardown_continues_when_endpoint_already_gone(client, comfygen_endpoint_configured, mocker):
    """If the endpoint was already deleted out of band (RunPod console, prior
    failed teardown), the teardown route shouldn't abort — it should still
    try template + volume cleanup so Settings can be reset to clean state."""
    mocker.patch.object(wizard_routes.runpod_api, "update_endpoint_workers",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("HTTP 404: endpoint not found"))
    mocker.patch.object(wizard_routes.runpod_api, "delete_endpoint",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("HTTP 404"))
    del_tmpl = mocker.patch.object(wizard_routes.runpod_api, "delete_template")
    del_vol = mocker.patch.object(wizard_routes.runpod_api, "delete_network_volume")

    r = client.post("/api/wizard/comfygen/teardown")

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # Template + volume cleanup still ran
    del_tmpl.assert_called_once()
    del_vol.assert_called_once()
    # Caller learns about the soft failures via a 'warnings' field
    assert "warnings" in body
    assert any("endpoint" in w.lower() for w in body["warnings"])
    # Settings was cleaned up anyway
    assert settings_store.get_endpoint("comfygen") is None


def test_teardown_keeps_settings_when_RunPod_hard_fails(client, comfygen_endpoint_configured, mocker):
    """If ALL three deletes fail (RunPod outage, auth revoked), don't wipe
    Settings — the user needs to see what failed and retry."""
    mocker.patch.object(wizard_routes.runpod_api, "update_endpoint_workers",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("HTTP 500"))
    mocker.patch.object(wizard_routes.runpod_api, "delete_endpoint",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("HTTP 500"))
    mocker.patch.object(wizard_routes.runpod_api, "delete_template",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("HTTP 500"))
    mocker.patch.object(wizard_routes.runpod_api, "delete_network_volume",
                        side_effect=wizard_routes.runpod_api.RunPodAPIError("HTTP 500"))

    r = client.post("/api/wizard/comfygen/teardown")

    assert r.status_code == 502
    # Settings record still there for retry
    assert settings_store.get_endpoint("comfygen") is not None


def test_teardown_handles_missing_template_name_gracefully(client, mocker):
    """Pre-.6 endpoints might lack template_name (was added in B.5 fix).
    Teardown should still delete endpoint + volume and report a warning."""
    settings_store.set_credential("runpod_api_key", "rpa_valid")
    settings_store.set_endpoint(
        "comfygen",
        endpoint_id="ep_legacy",
        template_id="tmpl_legacy",
        template_name=None,  # explicitly missing
        volume_id="vol_legacy",
    )
    mocker.patch.object(wizard_routes.runpod_api, "update_endpoint_workers")
    del_ep = mocker.patch.object(wizard_routes.runpod_api, "delete_endpoint")
    del_tmpl = mocker.patch.object(wizard_routes.runpod_api, "delete_template")
    del_vol = mocker.patch.object(wizard_routes.runpod_api, "delete_network_volume")

    r = client.post("/api/wizard/comfygen/teardown")

    assert r.status_code == 200
    del_ep.assert_called_once()
    del_vol.assert_called_once()
    # Template skipped because we have no name to delete with
    del_tmpl.assert_not_called()
    assert any("template_name" in w for w in r.json()["warnings"])
