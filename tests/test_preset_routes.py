"""HTTP route tests for the preset installer manifest layer
(sgs-ui-wisp-las.3 Stage A).

Stage A scope: backend can fetch the public registry manifest, cache it for
1h (fallback to stale cache on network failure), list installed presets
from Settings. NO actual install yet — that's Stage B.

Tests mock the HTTP boundary (curl_cffi.requests) to verify caching,
TTL, fallback semantics, and route shape.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import preset_routes, settings_store  # noqa: E402


@pytest.fixture
def app(tmp_path, monkeypatch):
    db_path = tmp_path / "preset_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    # Isolate the manifest cache to a per-test tmp file so cross-test bleed
    # can't happen.
    monkeypatch.setattr(preset_routes, "_CACHE_PATH", tmp_path / "manifest_cache.json")
    # Reset the in-memory cache between tests
    preset_routes._cache_reset()

    fastapi_app = FastAPI()
    fastapi_app.include_router(preset_routes.router)
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


def _manifest(presets: list[dict]) -> dict:
    return {"manifest_version": 1, "presets": presets}


def _qwen_preset_entry() -> dict:
    return {
        "id": "qwen-image-lighting",
        "name": "Qwen Image 2512 — Lightning 4-step",
        "description": "Test description",
        "comfygen_min_version": "0.2.0",
        "tags": ["t2i", "qwen"],
        "disk_size_estimate_gb": 65,
        "gpu_tier_hint": "recommended",
        "preset_url": "https://example/preset.json",
    }


def _mock_response(body: dict, status: int = 200) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.text = json.dumps(body)
    m.json = lambda: body
    return m


# === manifest fetch =========================================================

def test_manifest_fetches_from_registry_url(client, mocker):
    """Happy path: GET /api/presets/manifest → fetch from registry URL,
    return the parsed manifest."""
    body = _manifest([_qwen_preset_entry()])
    fetch_mock = MagicMock(return_value=_mock_response(body))
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)

    r = client.get("/api/presets/manifest")

    assert r.status_code == 200
    assert r.json() == body
    fetch_mock.assert_called_once()
    # Verify the canonical URL is used
    assert "raw.githubusercontent.com/Hearmeman24/blockflow-presets" in fetch_mock.call_args.args[0]
    assert fetch_mock.call_args.args[0].endswith("/main/manifest.json")


def test_manifest_caches_within_ttl(client, mocker):
    """Second fetch within TTL hits the cache, not the network."""
    body = _manifest([_qwen_preset_entry()])
    fetch_mock = MagicMock(return_value=_mock_response(body))
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)

    r1 = client.get("/api/presets/manifest")
    r2 = client.get("/api/presets/manifest")

    assert r1.json() == r2.json() == body
    assert fetch_mock.call_count == 1, "second call should hit the cache"


def test_manifest_refreshes_after_ttl(client, mocker, monkeypatch):
    """Cache expires after the TTL; next call re-fetches."""
    body_v1 = _manifest([_qwen_preset_entry()])
    body_v2 = _manifest([{**_qwen_preset_entry(), "name": "Updated"}])

    responses = [_mock_response(body_v1), _mock_response(body_v2)]
    fetch_mock = MagicMock(side_effect=responses)
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)
    # Tight TTL so we don't have to sleep an hour
    monkeypatch.setattr(preset_routes, "_CACHE_TTL_SEC", 1)

    r1 = client.get("/api/presets/manifest").json()
    time.sleep(1.2)
    r2 = client.get("/api/presets/manifest").json()

    assert r1["presets"][0]["name"] == "Qwen Image 2512 — Lightning 4-step"
    assert r2["presets"][0]["name"] == "Updated"
    assert fetch_mock.call_count == 2


def test_manifest_falls_back_to_stale_cache_on_network_error(client, mocker):
    """If GitHub is unreachable and we have a cached manifest, return it with
    a {cache: 'stale'} flag so the UI can show 'showing offline copy'."""
    body = _manifest([_qwen_preset_entry()])
    # First call succeeds, second errors
    responses = [_mock_response(body), Exception("network unreachable")]
    fetch_mock = MagicMock(side_effect=responses)
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)

    client.get("/api/presets/manifest")  # populate cache

    # Force expiry so next call refetches
    preset_routes._force_cache_expired()
    r = client.get("/api/presets/manifest")

    assert r.status_code == 200
    payload = r.json()
    assert payload["presets"] == body["presets"]
    assert payload.get("cache") == "stale"


def test_manifest_returns_502_when_unreachable_and_no_cache(client, mocker):
    """No cache + network error → real 502 (UI shows 'cannot reach registry')."""
    fetch_mock = MagicMock(side_effect=Exception("network unreachable"))
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)

    r = client.get("/api/presets/manifest")
    assert r.status_code == 502
    assert "registry" in r.json()["detail"].lower() or "unreachable" in r.json()["detail"].lower()


def test_manifest_force_refresh_bypasses_cache(client, mocker):
    """?refresh=1 ignores the in-memory cache and fetches from network."""
    body_v1 = _manifest([_qwen_preset_entry()])
    body_v2 = _manifest([{**_qwen_preset_entry(), "name": "Refreshed"}])
    responses = [_mock_response(body_v1), _mock_response(body_v2)]
    fetch_mock = MagicMock(side_effect=responses)
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)

    client.get("/api/presets/manifest")
    r = client.get("/api/presets/manifest?refresh=1")

    assert r.json()["presets"][0]["name"] == "Refreshed"
    assert fetch_mock.call_count == 2


def test_manifest_returns_502_on_invalid_json_from_registry(client, mocker):
    """If the registry returns non-JSON (e.g. GitHub serving an error page),
    we shouldn't crash — return 502 with a clear message."""
    bad = MagicMock()
    bad.status_code = 200
    bad.text = "<html>not json</html>"
    bad.json = MagicMock(side_effect=ValueError("not json"))
    mocker.patch.object(preset_routes._cffi_requests, "get", MagicMock(return_value=bad))

    r = client.get("/api/presets/manifest")
    assert r.status_code == 502


# === installed presets list =================================================

def test_list_installed_empty(client):
    r = client.get("/api/presets/installed")
    assert r.status_code == 200
    assert r.json() == {"installed": []}


def test_list_installed_returns_settings_rows(client):
    """Pre-populate Settings as if Stage B's install had completed."""
    settings_store.record_installed_preset(
        preset_id="qwen-image-lighting",
        version="0.2.0",
        disk_size_gb=65,
        workflow_json='{"3": {"class_type": "KSampler"}}',
    )
    settings_store.record_installed_preset(
        preset_id="another-preset",
        version="0.1.0",
        disk_size_gb=15,
        workflow_json='{}',
    )

    r = client.get("/api/presets/installed")
    assert r.status_code == 200
    body = r.json()
    ids = sorted(p["preset_id"] for p in body["installed"])
    assert ids == ["another-preset", "qwen-image-lighting"]
    qwen = next(p for p in body["installed"] if p["preset_id"] == "qwen-image-lighting")
    assert qwen["version"] == "0.2.0"
    assert qwen["disk_size_gb"] == 65
    # workflow_json is NOT in the list response (would bloat); UI fetches detail separately
    assert "workflow_json" not in qwen


# === installed presets detail ===============================================

def test_get_installed_detail_returns_workflow_json(client):
    settings_store.record_installed_preset(
        preset_id="qwen-image-lighting",
        version="0.2.0",
        disk_size_gb=65,
        workflow_json='{"3": {"class_type": "KSampler"}}',
    )
    r = client.get("/api/presets/installed/qwen-image-lighting")
    assert r.status_code == 200
    body = r.json()
    assert body["preset_id"] == "qwen-image-lighting"
    assert body["workflow_json"] == {"3": {"class_type": "KSampler"}}


def test_get_installed_detail_404_when_missing(client):
    r = client.get("/api/presets/installed/never-installed")
    assert r.status_code == 404


# === Stage B: preset detail fetch ==========================================

QWEN_FULL_PRESET = {
    "id": "qwen-image-lighting",
    "name": "Qwen Image 2512 — Lightning 4-step",
    "comfygen_min_version": "0.2.0",
    "tags": ["t2i"],
    "workflow": {
        "url": "https://example/workflow.json",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    },
    "models": [
        {
            "source": "huggingface",
            "url": "https://example.com/unet.safetensors",
            "dest": "diffusion_models/unet.safetensors",
            "size_gb": 40.9,
        },
        {
            "source": "huggingface",
            "url": "https://example.com/clip.safetensors",
            "dest": "text_encoders/clip.safetensors",
            "size_gb": 9.4,
        },
    ],
    "disk_size_estimate_gb": 55,
}


def test_get_preset_detail_fetches_from_registry(client, mocker):
    fetch_mock = MagicMock(return_value=_mock_response(QWEN_FULL_PRESET))
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)
    # Populate manifest cache so the route knows the preset_url
    preset_routes._cache["manifest"] = _manifest([{**_qwen_preset_entry(), "preset_url": "https://example/preset.json"}])
    preset_routes._cache["fetched_at"] = time.time()

    r = client.get("/api/presets/manifest/qwen-image-lighting")

    assert r.status_code == 200
    assert r.json()["id"] == "qwen-image-lighting"
    assert len(r.json()["models"]) == 2
    fetch_mock.assert_called_once_with("https://example/preset.json", timeout=preset_routes._HTTP_TIMEOUT_SEC)


def test_get_preset_detail_404_when_not_in_manifest(client, mocker):
    """If the preset_id isn't in the manifest, no preset_url to fetch from."""
    preset_routes._cache["manifest"] = _manifest([])
    preset_routes._cache["fetched_at"] = time.time()

    r = client.get("/api/presets/manifest/never-existed")
    assert r.status_code == 404


def test_get_preset_detail_refreshes_manifest_when_cache_empty(client, mocker):
    """If the in-memory manifest cache is empty, refetch it before resolving
    the preset detail."""
    manifest = _manifest([{**_qwen_preset_entry(), "preset_url": "https://example/preset.json"}])
    fetch_mock = MagicMock(side_effect=[
        _mock_response(manifest),     # first call: manifest refresh
        _mock_response(QWEN_FULL_PRESET),  # second: preset detail
    ])
    mocker.patch.object(preset_routes._cffi_requests, "get", fetch_mock)

    r = client.get("/api/presets/manifest/qwen-image-lighting")

    assert r.status_code == 200
    assert fetch_mock.call_count == 2


# === Stage B: install ======================================================

def _all_creds_and_endpoint():
    """Helper to populate everything install needs."""
    settings_store.set_credential("runpod_api_key", "rpa_test")
    settings_store.set_endpoint("comfygen", endpoint_id="ep_test", template_name="tn", volume_id="vol")


@pytest.fixture
def install_ready(app):
    _all_creds_and_endpoint()
    # Reset install state between tests
    preset_routes._reset_install_state()


def test_install_starts_subprocess_with_batch_download(client, install_ready, mocker):
    """Install kicks off comfy-gen download --batch in a background thread.
    Returns 202 with the job id immediately."""
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(side_effect=[
                            _mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "https://example/preset.json"}])),
                            _mock_response(QWEN_FULL_PRESET),
                        ]))

    # Mock the subprocess so the install doesn't actually shell out
    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = '{"ok": true, "downloaded_files": 2}'
    fake_proc.stderr = ""
    run_mock = mocker.patch.object(preset_routes.subprocess, "run", return_value=fake_proc)

    r = client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})

    assert r.status_code == 202
    body = r.json()
    assert body["preset_id"] == "qwen-image-lighting"
    assert body["state"] in ("queued", "running")

    # Wait for the background thread to finish (the mocked subprocess returns instantly)
    import time as _t
    for _ in range(50):
        if preset_routes._install_state["state"] in ("completed", "error"):
            break
        _t.sleep(0.02)

    # Subprocess was called with comfy-gen download --batch + endpoint id
    run_mock.assert_called_once()
    args = run_mock.call_args.args[0]
    assert args[0] == "comfy-gen"
    assert args[1] == "download"
    assert "--batch" in args
    assert "--endpoint-id" in args
    assert "ep_test" in args


def test_install_persists_to_settings_on_success(client, install_ready, mocker):
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(side_effect=[
                            _mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "https://example/preset.json"}])),
                            _mock_response(QWEN_FULL_PRESET),
                        ]))
    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = '{"ok": true}'
    fake_proc.stderr = ""
    mocker.patch.object(preset_routes.subprocess, "run", return_value=fake_proc)

    client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})

    # Wait for completion
    import time as _t
    for _ in range(100):
        if preset_routes._install_state["state"] == "completed":
            break
        _t.sleep(0.02)

    ep = settings_store.get_installed_preset("qwen-image-lighting")
    assert ep is not None
    assert ep["version"] == "0.2.0"
    assert ep["disk_size_gb"] == 55
    # workflow_json is persisted as a JSON string (parseable dict). In this
    # test the workflow URL fetch isn't separately mocked so the dict can be
    # empty; what matters is that the column was populated.
    import json as _json
    assert isinstance(_json.loads(ep["workflow_json"]), dict)


def test_install_409_when_already_running(client, install_ready, mocker):
    """Block concurrent installs — return 409 with the current preset id."""
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(return_value=_mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "x"}]))))

    # Pretend an install is already in flight
    preset_routes._install_state.update({
        "state": "running",
        "preset_id": "in-progress-preset",
    })

    r = client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})
    assert r.status_code == 409
    assert "in-progress-preset" in r.json()["detail"]


def test_install_404_when_preset_not_in_manifest(client, install_ready, mocker):
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(return_value=_mock_response(_manifest([]))))

    r = client.post("/api/presets/install", json={"preset_id": "ghost"})
    assert r.status_code == 404


def test_install_400_when_no_endpoint_configured(client, mocker):
    """Can't install without a ComfyGen endpoint to download onto."""
    settings_store.set_credential("runpod_api_key", "rpa_test")
    # No endpoint set
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(return_value=_mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "x"}]))))

    r = client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})
    assert r.status_code == 400
    assert "ComfyGen endpoint" in r.json()["detail"] or "comfygen" in r.json()["detail"].lower()


def test_install_records_error_on_subprocess_failure(client, install_ready, mocker):
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(side_effect=[
                            _mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "x"}])),
                            _mock_response(QWEN_FULL_PRESET),
                        ]))
    fake_proc = MagicMock()
    fake_proc.returncode = 1
    fake_proc.stdout = "{}"
    fake_proc.stderr = "Download failed: network timeout"
    mocker.patch.object(preset_routes.subprocess, "run", return_value=fake_proc)

    client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})

    import time as _t
    for _ in range(100):
        if preset_routes._install_state["state"] == "error":
            break
        _t.sleep(0.02)

    assert preset_routes._install_state["state"] == "error"
    assert "Download failed" in preset_routes._install_state["error"]
    # Settings NOT populated on failure
    assert settings_store.get_installed_preset("qwen-image-lighting") is None


def test_install_progress_returns_current_state(client):
    """The progress route is a simple snapshot of the module-level state."""
    preset_routes._install_state.update({
        "state": "running",
        "preset_id": "qwen-image-lighting",
        "started_at": "2026-05-21T15:00:00",
        "files_total": 4,
    })

    r = client.get("/api/presets/install/progress")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "running"
    assert body["preset_id"] == "qwen-image-lighting"
    assert body["files_total"] == 4


# === Stage B: uninstall ====================================================

def test_uninstall_drops_settings_row(client):
    settings_store.record_installed_preset(
        preset_id="qwen-image-lighting",
        version="0.2.0",
        workflow_json='{}',
        disk_size_gb=65,
    )
    assert settings_store.get_installed_preset("qwen-image-lighting") is not None

    r = client.post("/api/presets/uninstall/qwen-image-lighting")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert settings_store.get_installed_preset("qwen-image-lighting") is None


def test_uninstall_404_when_not_installed(client):
    r = client.post("/api/presets/uninstall/never-was")
    assert r.status_code == 404


# === Stage B: disk-budget pre-check ========================================

def test_disk_budget_returns_total_from_runpod_minus_settings_used(client, install_ready, mocker):
    mocker.patch.object(preset_routes.runpod_api, "get_network_volume",
                        return_value={"id": "vol_test", "size": 200})
    # Pretend two presets already installed
    settings_store.record_installed_preset(
        preset_id="a", version="0.1.0", workflow_json="{}", disk_size_gb=50,
    )
    settings_store.record_installed_preset(
        preset_id="b", version="0.1.0", workflow_json="{}", disk_size_gb=30,
    )

    r = client.get("/api/presets/disk-budget")
    assert r.status_code == 200
    body = r.json()
    assert body["total_gb"] == 200
    assert body["used_estimate_gb"] == 80
    assert body["free_estimate_gb"] == 120


def test_disk_budget_returns_total_None_when_runpod_unreachable(client, install_ready, mocker):
    """RunPod transient failure shouldn't blow up the budget endpoint —
    return total/free as None so the UI can show 'unknown'."""
    mocker.patch.object(preset_routes.runpod_api, "get_network_volume",
                        side_effect=preset_routes.runpod_api.RunPodAPIError("HTTP 502"))

    r = client.get("/api/presets/disk-budget")
    assert r.status_code == 200
    body = r.json()
    assert body["total_gb"] is None
    assert body["free_estimate_gb"] is None
    # used_estimate_gb still works (Settings-only)
    assert body["used_estimate_gb"] == 0


def test_install_400_when_preset_exceeds_disk_budget(client, install_ready, mocker):
    """65GB preset + 50GB already used + 100GB volume → only 50GB free → reject."""
    mocker.patch.object(preset_routes.runpod_api, "get_network_volume",
                        return_value={"id": "vol_test", "size": 100})
    settings_store.record_installed_preset(
        preset_id="existing", version="0.1.0", workflow_json="{}", disk_size_gb=50,
    )

    big_preset = {**QWEN_FULL_PRESET, "disk_size_estimate_gb": 65}
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(side_effect=[
                            _mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "x"}])),
                            _mock_response(big_preset),
                        ]))

    r = client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})

    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "insufficient disk" in detail.lower()
    assert "65" in detail  # needed
    assert "50" in detail  # free estimate (100 - 50)


def test_install_proceeds_when_disk_budget_unknown(client, install_ready, mocker):
    """If RunPod is unreachable for the volume query, fall through (don't
    block on a check we can't perform)."""
    mocker.patch.object(preset_routes.runpod_api, "get_network_volume",
                        side_effect=preset_routes.runpod_api.RunPodAPIError("HTTP 502"))
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(side_effect=[
                            _mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "x"}])),
                            _mock_response(QWEN_FULL_PRESET),
                        ]))
    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = '{}'
    fake_proc.stderr = ""
    mocker.patch.object(preset_routes.subprocess, "run", return_value=fake_proc)

    r = client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})
    assert r.status_code == 202
