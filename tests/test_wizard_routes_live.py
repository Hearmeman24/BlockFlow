"""LIVE end-to-end test for the ComfyGen setup wizard (sgs-ui-wisp-las.2 Stage B).

Gated by `BLOCKFLOW_LIVE_TESTS=1`. Reads RUNPOD_API_KEY from env.

This test exercises the FULL provisioning chain from BlockFlow's wizard
backend — not just the runpod_api client. It validates that the wizard
correctly orchestrates the API calls and persists Settings.

Flow:
  1. Pre-populate Settings with RUNPOD_API_KEY + dummy R2 creds (R2 connect
     is not exercised by provisioning itself; the values just get baked into
     the template env vars, which is fine — we tear down before any worker
     spins up).
  2. Fetch live RunPod deploy recommendations and provision the first option.
  3. Verify response shape + Settings was persisted correctly.
  4. Verify /api/wizard/comfygen/health returns valid worker counts.
  5. Tear down via direct runpod_api calls (drain → DELETE endpoint →
     deleteTemplate → DELETE volume).

Cost: ~$0 because workers stay at 0; only metadata operations occur.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import runpod_api, settings_store, wizard_routes  # noqa: E402

LIVE_ENABLED = os.environ.get("BLOCKFLOW_LIVE_TESTS") == "1"
API_KEY = os.environ.get("RUNPOD_API_KEY", "")

pytestmark = pytest.mark.skipif(
    not LIVE_ENABLED,
    reason="Live RunPod tests gated by BLOCKFLOW_LIVE_TESTS=1",
)


@pytest.fixture
def app(tmp_path, monkeypatch):
    if not API_KEY:
        pytest.skip("RUNPOD_API_KEY not set")

    db_path = tmp_path / "live_wizard.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()

    # Real RunPod key + dummy R2 creds (R2 isn't actually called during
    # provisioning; values just get embedded in template env).
    settings_store.set_credential("runpod_api_key", API_KEY)
    settings_store.set_credential("r2_endpoint_url", "https://example.r2.cloudflarestorage.com")
    settings_store.set_credential("r2_access_key_id", "dummy-access-key")
    settings_store.set_credential("r2_secret_access_key", "dummy-secret-key")
    settings_store.set_credential("r2_bucket", "blockflow-test-dummy-bucket")
    settings_store.set_credential_validation("runpod", {"ok": True, "error": None, "validated_at": "2099-01-01T00:00:00+00:00"})
    settings_store.set_credential_validation("r2", {"ok": True, "error": None, "validated_at": "2099-01-01T00:00:00+00:00"})

    fastapi_app = FastAPI()
    fastapi_app.include_router(wizard_routes.router)
    return fastapi_app


def _live_provision_payload(client: TestClient, *, volume_size_gb: int = 10, max_workers: int = 1) -> dict[str, object]:
    tiers_resp = client.get("/api/wizard/comfygen/tiers")
    assert tiers_resp.status_code == 200, tiers_resp.text
    tiers = tiers_resp.json()["tiers"]
    assert tiers, tiers_resp.json()
    tier = tiers[0]
    assert tier["datacenter"]
    assert tier["primary"]["gpu_type_id"]
    return {
        "tier": tier["id"],
        "datacenter": tier["datacenter"],
        "primary_gpu_id": tier["primary"]["gpu_type_id"],
        "fallback_gpu_ids": [],
        "volume_size_gb": volume_size_gb,
        "max_workers": max_workers,
    }


def test_live_wizard_provision_then_teardown(app):
    """End-to-end: BlockFlow wizard provisions a real ComfyGen endpoint, then
    cleans up. Validates the wizard backend's orchestration end-to-end."""
    client = TestClient(app)

    # Preflight should report ready
    pre = client.get("/api/wizard/comfygen/preflight")
    assert pre.status_code == 200
    assert pre.json()["ready"] is True, pre.json()
    assert pre.json()["missing"] == []

    # Provision (first live recommendation; workersMin/Max stay small)
    print("[live] provisioning ComfyGen endpoint via wizard...")
    payload = _live_provision_payload(client)
    provision_resp = client.post(
        "/api/wizard/comfygen/provision",
        json=payload,
    )

    endpoint_id: str | None = None
    template_id: str | None = None
    volume_id: str | None = None
    template_name: str | None = None

    try:
        if provision_resp.status_code != 200:
            print(f"[live] provision failed: HTTP {provision_resp.status_code}: {provision_resp.text}")
        assert provision_resp.status_code == 200
        body = provision_resp.json()

        assert body["status"] == "provisioning"
        endpoint_id = body["endpoint_id"]
        template_id = body["template_id"]
        template_name = body["template_name"]
        volume_id = body["volume_id"]
        assert endpoint_id and template_id and template_name and volume_id

        print(f"[live] provisioned: endpoint={endpoint_id} template={template_id} volume={volume_id}")

        # Settings should reflect the new endpoint
        ep = settings_store.get_endpoint("comfygen")
        assert ep is not None
        assert ep["endpoint_id"] == endpoint_id
        assert ep["template_id"] == template_id
        assert ep["volume_id"] == volume_id
        assert ep["gpu_tier"] == payload["tier"]
        assert ep["volume_size_gb"] == 10
        assert ep["max_workers"] == 1

        # Health proxy
        health_resp = client.get(f"/api/wizard/comfygen/health/{endpoint_id}")
        assert health_resp.status_code == 200
        workers = health_resp.json()["workers"]
        # Just-provisioned endpoint: 0 ready, 0 idle (no jobs queued)
        assert workers["ready"] == 0
        assert workers["idle"] == 0
        print(f"[live] endpoint health: {workers}")

    finally:
        # Best-effort cleanup. Use direct runpod_api so we don't depend on
        # tear-down routes that haven't been built yet (Stage 5.5).
        if endpoint_id:
            try:
                runpod_api.delete_endpoint(API_KEY, endpoint_id)
                print(f"[live] deleted endpoint {endpoint_id}")
            except Exception as exc:
                print(f"[live] WARN: endpoint cleanup failed: {exc}")

        if template_name:
            # Template deletion can take up to 2 min after the endpoint is gone.
            for attempt in range(6):
                try:
                    runpod_api.delete_template(API_KEY, template_name=template_name)
                    print(f"[live] deleted template {template_name}")
                    break
                except Exception as exc:
                    if attempt == 5:
                        print(f"[live] WARN: template cleanup failed: {exc}")
                        break
                    time.sleep(5)

        if volume_id:
            # Wait a few seconds for the endpoint deletion to release the volume
            for attempt in range(6):
                try:
                    runpod_api.delete_network_volume(API_KEY, volume_id)
                    print(f"[live] deleted volume {volume_id}")
                    break
                except Exception as exc:
                    if attempt == 5:
                        print(f"[live] WARN: volume cleanup failed: {exc}")
                        break
                    time.sleep(3)


def test_live_wizard_teardown_route_cleans_up_everything(app):
    """sgs-ui-wisp-las.1 Stage 5.5: tearing down via /api/wizard/comfygen/teardown
    deletes all 3 RunPod resources + the Settings record, end-to-end.

    Cost: ~$0 (no workers ever spin up; metadata-only operations)."""
    client = TestClient(app)

    # Provision a fresh endpoint to tear down
    r = client.post(
        "/api/wizard/comfygen/provision",
        json=_live_provision_payload(client),
    )
    assert r.status_code == 200, r.text
    provisioned = r.json()
    print(f"[live] provisioned to tear down: ep={provisioned['endpoint_id']} "
          f"template={provisioned['template_name']} vol={provisioned['volume_id']}")

    # Tear it down via the new route
    print("[live] calling POST /api/wizard/comfygen/teardown...")
    tr = client.post("/api/wizard/comfygen/teardown")
    assert tr.status_code == 200, tr.text
    body = tr.json()

    assert body["ok"] is True
    assert body["deleted"]["endpoint_id"] == provisioned["endpoint_id"]
    assert body["deleted"]["template_name"] == provisioned["template_name"]
    assert body["deleted"]["volume_id"] == provisioned["volume_id"]
    # All 4 cleanup steps succeeded (no soft-failure warnings)
    assert "drain" in body["successes"]
    assert "endpoint" in body["successes"]
    assert "template" in body["successes"]
    assert "volume" in body["successes"]
    print(f"[live] teardown successes: {body['successes']}, warnings: {body['warnings']}")

    # Settings record removed → row reverts to "not configured"
    assert settings_store.get_endpoint("comfygen") is None

    # Re-running teardown 404s (nothing left to tear down)
    rr = client.post("/api/wizard/comfygen/teardown")
    assert rr.status_code == 404
