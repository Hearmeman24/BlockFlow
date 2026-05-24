"""HTTP route tests for the preset installer manifest layer
(sgs-ui-wisp-las.3 Stage A).

Stage A scope: backend can fetch the public registry manifest, cache it for
1h (fallback to stale cache on network failure), list installed presets
from Settings. NO actual install yet — that's Stage B.

Tests mock the HTTP boundary (curl_cffi.requests) to verify caching,
TTL, fallback semantics, and route shape.
"""
from __future__ import annotations

import io
import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_fake_popen(stdout: str = "", stderr: str = "", returncode: int = 0) -> MagicMock:
    """Build a MagicMock that mimics the Popen interface the streaming code
    consumes: line-iterable .stdout/.stderr (via readline), .wait(), .kill().
    StringIO works with `iter(stream.readline, '')` — yields lines until EOF.
    """
    proc = MagicMock()
    proc.stdout = io.StringIO(stdout)
    proc.stderr = io.StringIO(stderr)
    proc.wait.return_value = returncode
    proc.returncode = returncode
    return proc



def _install_preset_success_proc(num_files: int = 1, paths: list[str] | None = None) -> MagicMock:
    """sgs-ui-8ww helper: build a Popen-shaped mock whose stdout is a
    minimal successful `comfy-gen install-preset` event stream."""
    if paths is None:
        paths = [f"/runpod-volume/ComfyUI/models/m{i}/f{i}.safetensors" for i in range(num_files)]
    events = [
        {"type": "pod_spawned", "pod_id": "pod_test", "token": "tok"},
        {"type": "preflight_ok", "models_count": num_files,
         "total_bytes": 0, "volume_free_bytes": 0},
    ]
    for i, path in enumerate(paths):
        events.append({"type": "download_done", "file_index": i, "file": path,
                       "cached": False, "bytes": 0, "sha256": f"{i:064d}"})
    events.append({"type": "install_done", "ok": True, "files": num_files, "elapsed_sec": 1})
    stdout = "".join(json.dumps(e) + "\n" for e in events)
    return _make_fake_popen(stdout=stdout, returncode=0)

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
    # workflow NAMES are included so the ComfyGen dropdown can enumerate
    # one entry per (preset, workflow) without an N+1 detail fetch (sgs-ui-chf).
    assert qwen["workflows"] == [{"name": "Default"}]


# === installed presets detail ===============================================

def test_get_installed_detail_wraps_legacy_dict_workflow_json(client):
    """A row written before workflows[] (legacy single-dict workflow_json)
    must read back as a wrapped array so the ComfyGen block can treat all
    presets uniformly."""
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
    assert body["workflow_json"] == [
        {"name": "Default", "json": {"3": {"class_type": "KSampler"}}}
    ]


def test_get_installed_detail_returns_workflows_array_as_is(client):
    """Modern rows store the workflows[] form directly; read-path passes
    through unchanged."""
    payload = [
        {"name": "I2V", "json": {"3": {"class_type": "KSampler"}}},
        {"name": "V2V", "json": {"3": {"class_type": "KSampler"}, "4": {}}},
    ]
    settings_store.record_installed_preset(
        preset_id="multi-flow",
        version="0.1.0",
        disk_size_gb=10,
        workflow_json=json.dumps(payload),
    )
    r = client.get("/api/presets/installed/multi-flow")
    assert r.status_code == 200
    assert r.json()["workflow_json"] == payload


def test_get_installed_detail_404_when_missing(client):
    r = client.get("/api/presets/installed/never-installed")
    assert r.status_code == 404


# === Stage B: preset detail fetch ==========================================

QWEN_FULL_PRESET = {
    "id": "qwen-image-lighting",
    "name": "Qwen Image 2512 — Lightning 4-step",
    "comfygen_min_version": "0.2.0",
    "tags": ["t2i"],
    "workflows": [
        {
            "name": "Default",
            "url": "https://example/workflow.json",
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        }
    ],
    "models": [
        {
            "source": "huggingface",
            "url": "https://example.com/unet.safetensors",
            "dest": "diffusion_models/unet.safetensors",
            "sha256": "a" * 64,
            "size_gb": 40.9,
        },
        {
            "source": "huggingface",
            "url": "https://example.com/clip.safetensors",
            "dest": "text_encoders/clip.safetensors",
            "sha256": "b" * 64,
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


def test_install_persists_to_settings_on_success(client, install_ready, mocker):
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(side_effect=[
                            _mock_response(_manifest([{**_qwen_preset_entry(), "preset_url": "https://example/preset.json"}])),
                            _mock_response(QWEN_FULL_PRESET),
                        ]))
    mocker.patch.object(preset_routes.subprocess, "Popen",
                        return_value=_install_preset_success_proc(num_files=2))

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
    # workflow_json is now persisted as a JSON-encoded wrapper
    # {workflows: [...], recommendations: {...}} (sgs-ui-fmy). Workflow URL
    # fetch isn't separately mocked here so the inner json can be empty;
    # what matters is that the column was populated and carries the
    # canonical 'Default' entry under the workflows list.
    import json as _json
    blob = _json.loads(ep["workflow_json"])
    workflows = blob["workflows"]
    assert isinstance(workflows, list)
    assert len(workflows) == 1
    assert workflows[0]["name"] == "Default"


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


# === Stage B: install log tail (sgs-ui-hh9) =================================
# The download subprocess streams comfy-gen's stderr (RunPod job progress —
# "[15s] Downloading 1/4: foo.safetensors 42% (188MiB/s)") via the pump
# thread. _install_state["log_tail"] mirrors that to the UI so /progress
# polls can render a live log block under the InstallProgressCard.

# === Stage B: multi-workflow presets (sgs-ui-chf) ===========================

def test_install_persists_workflows_array_with_names(client, install_ready, mocker):
    """preset.workflows[] → workflow_json stored as JSON-encoded list of
    {name, json} entries. Each URL-backed workflow gets fetched once."""
    wf_i2v = {"3": {"class_type": "WanAnimateI2V"}}
    wf_v2v = {"3": {"class_type": "WanAnimateV2V"}, "4": {}}
    preset = {
        **QWEN_FULL_PRESET,
        "id": "wan-animate",
        "workflows": [
            {"name": "I2V", "url": "https://example/i2v.json", "sha256": "0" * 64},
            {"name": "V2V", "url": "https://example/v2v.json", "sha256": "1" * 64},
        ],
    }
    # Route fetches by URL — dispatch on URL, not call order, so any extra
    # cache-warmup fetches don't shift the responses.
    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([{**_qwen_preset_entry(), "id": "wan-animate", "preset_url": "https://example/preset.json"}]))
        if "preset.json" in url:
            return _mock_response(preset)
        if "i2v.json" in url:
            return _mock_response(wf_i2v)
        if "v2v.json" in url:
            return _mock_response(wf_v2v)
        return _mock_response({}, status=404)
    mocker.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get)
    mocker.patch.object(preset_routes.subprocess, "Popen",
                        return_value=_install_preset_success_proc(num_files=2))

    r = client.post("/api/presets/install", json={"preset_id": "wan-animate"})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error")

    persisted = settings_store.get_installed_preset("wan-animate")
    assert persisted is not None
    workflows = json.loads(persisted["workflow_json"])["workflows"]
    assert workflows == [
        {"name": "I2V", "json": wf_i2v},
        {"name": "V2V", "json": wf_v2v},
    ]


def test_install_inline_workflow_skips_fetch(client, install_ready, mocker):
    """Inline workflow JSON doesn't need an HTTP fetch — persists directly."""
    inline = {"3": {"class_type": "KSampler"}}
    preset = {
        **QWEN_FULL_PRESET,
        "id": "inline-flow",
        "workflows": [{"name": "Default", "json": inline}],
    }
    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([{**_qwen_preset_entry(), "id": "inline-flow", "preset_url": "https://example/preset.json"}]))
        if "preset.json" in url:
            return _mock_response(preset)
        return _mock_response({}, status=404)
    mocker.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get)
    mocker.patch.object(preset_routes.subprocess, "Popen",
                        return_value=_install_preset_success_proc(num_files=2))

    r = client.post("/api/presets/install", json={"preset_id": "inline-flow"})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error")

    persisted = settings_store.get_installed_preset("inline-flow")
    workflows = json.loads(persisted["workflow_json"])["workflows"]
    assert workflows == [{"name": "Default", "json": inline}]


# === Stage B: hash pre-flight (sgs-ui-zr0) ==================================
# Before submitting the full download batch, BlockFlow asks the worker to
# hash the canonical paths and diffs against preset.json expected sha256s.
# Cached files drop out of the batch, stale files get deleted first.

def _hash_response(files: list[dict]) -> str:
    """Build the JSON shape comfy-gen hash --batch emits on stdout."""
    return json.dumps({"ok": True, "files": files, "elapsed_seconds": 1})


def _delete_response(results: list[dict]) -> str:
    return json.dumps({"ok": True, "results": results})


def _wait_for_install_state(*targets: str, attempts: int = 200, sleep_s: float = 0.02):
    import time as _t
    for _ in range(attempts):
        if preset_routes._install_state["state"] in targets:
            return
        _t.sleep(sleep_s)


# === Stage B: uninstall (sgs-ui-i7j) ========================================

def test_uninstall_drops_settings_row(client, install_ready, mocker):
    """Uninstall now actually deletes preset files on the volume via
    `comfy-gen delete --batch <paths>` before dropping the Settings row.
    Legacy rows without installed_paths still drop cleanly (no-op delete)."""
    settings_store.record_installed_preset(
        preset_id="qwen-image-lighting",
        version="0.2.0",
        workflow_json='{}',
        disk_size_gb=65,
        installed_paths=[
            "/runpod-volume/ComfyUI/models/diffusion_models/unet.safetensors",
            "/runpod-volume/ComfyUI/models/text_encoders/clip.safetensors",
        ],
    )

    delete_paths: list[list[str]] = []
    def _popen_side_effect(args, *a, **kw):
        assert args[:2] == ["comfy-gen", "delete"]
        batch_path = args[args.index("--batch") + 1]
        with open(batch_path) as f:
            delete_paths.append(json.load(f))
        return _make_fake_popen(
            stdout=_delete_response([{"path": p, "deleted": True} for p in delete_paths[-1]]),
            returncode=0,
        )
    mocker.patch.object(preset_routes.subprocess, "Popen", side_effect=_popen_side_effect)

    r = client.post("/api/presets/uninstall/qwen-image-lighting")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["deleted_count"] == 2
    # Delete was actually invoked with the persisted paths
    assert len(delete_paths) == 1
    assert sorted(delete_paths[0]) == sorted([
        "/runpod-volume/ComfyUI/models/diffusion_models/unet.safetensors",
        "/runpod-volume/ComfyUI/models/text_encoders/clip.safetensors",
    ])
    assert settings_store.get_installed_preset("qwen-image-lighting") is None


def test_uninstall_legacy_row_without_paths_just_drops_settings(client, install_ready, mocker):
    """A row recorded before sgs-ui-i7j has installed_paths == []. No
    delete subprocess call should be made — Settings drop is the whole op."""
    settings_store.record_installed_preset(
        preset_id="legacy",
        version="0.1.0",
        workflow_json='{}',
        disk_size_gb=10,
        # No installed_paths
    )
    popen_mock = mocker.patch.object(preset_routes.subprocess, "Popen")

    r = client.post("/api/presets/uninstall/legacy")
    assert r.status_code == 200
    assert popen_mock.call_count == 0
    assert settings_store.get_installed_preset("legacy") is None


def test_uninstall_partial_delete_failure_keeps_settings_row(client, install_ready, mocker):
    """If `comfy-gen delete` reports per-file errors (some files removed,
    others errored), the Settings row stays so the user can retry. Surface
    207 with per-path details."""
    settings_store.record_installed_preset(
        preset_id="partial",
        version="0.1.0",
        workflow_json='{}',
        disk_size_gb=10,
        installed_paths=["/runpod-volume/a.safetensors", "/runpod-volume/b.safetensors"],
    )
    def _popen_side_effect(args, *a, **kw):
        return _make_fake_popen(stdout=_delete_response([
            {"path": "/runpod-volume/a.safetensors", "deleted": True},
            {"path": "/runpod-volume/b.safetensors", "deleted": False, "error": "permission denied"},
        ]), returncode=0)
    mocker.patch.object(preset_routes.subprocess, "Popen", side_effect=_popen_side_effect)

    r = client.post("/api/presets/uninstall/partial")
    assert r.status_code == 207
    body = r.json()
    assert body["deleted_count"] == 1
    assert len(body["errors"]) == 1
    assert body["errors"][0]["path"] == "/runpod-volume/b.safetensors"
    # Row STAYS so user can retry
    assert settings_store.get_installed_preset("partial") is not None


def test_uninstall_404_when_not_installed(client):
    r = client.post("/api/presets/uninstall/never-was")
    assert r.status_code == 404


def test_uninstall_409_when_no_active_endpoint(client, mocker):
    """No ComfyGen endpoint configured → we can't delete files. Return 409
    rather than silently dropping the Settings row."""
    settings_store.record_installed_preset(
        preset_id="x", version="0.1.0", workflow_json='{}', disk_size_gb=10,
        installed_paths=["/runpod-volume/a.safetensors"],
    )
    # No endpoint set up
    r = client.post("/api/presets/uninstall/x")
    assert r.status_code == 409
    # Row still there
    assert settings_store.get_installed_preset("x") is not None


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


# === sgs-ui-fmy: preset recommendations =====================================
# Presets may carry author-supplied prose tips, scoped either globally
# (apply to every workflow in the preset) or per-workflow (apply to one
# specific workflow). Both scopes are optional and may be empty.
# Surfaced to the UI via /api/presets/installed/{id} response shape.

def test_get_installed_detail_returns_empty_recommendations_when_absent(client):
    """Legacy / current rows without recommendations still respond with the
    `recommendations` field — empty global + empty workflows map — so the
    frontend doesn't need to special-case missing data."""
    settings_store.record_installed_preset(
        preset_id="no-recs",
        version="0.1.0",
        disk_size_gb=10,
        workflow_json=json.dumps([{"name": "Default", "json": {"3": {}}}]),
    )
    r = client.get("/api/presets/installed/no-recs")
    assert r.status_code == 200
    body = r.json()
    assert body["recommendations"] == {"global": [], "workflows": {}}


def test_get_installed_detail_returns_recommendations_when_present(client):
    """When a preset row stores the wrapper shape with recommendations,
    the detail endpoint exposes both the global list and the per-workflow
    map keyed by workflow name."""
    wrapper = {
        "workflows": [
            {"name": "Replace Face", "json": {"3": {"class_type": "Sampler"}}},
            {"name": "Move", "json": {"3": {"class_type": "Sampler"}}},
        ],
        "recommendations": {
            "global": ["This preset works best with a character LoRA"],
            "workflows": {
                "Replace Face": ["Consider changing the mask area for better coverage"],
            },
        },
    }
    settings_store.record_installed_preset(
        preset_id="wan-animate",
        version="0.1.0",
        disk_size_gb=10,
        workflow_json=json.dumps(wrapper),
    )
    r = client.get("/api/presets/installed/wan-animate")
    assert r.status_code == 200
    body = r.json()
    # workflow_json is still the bare list of {name, json} entries.
    assert body["workflow_json"] == wrapper["workflows"]
    assert body["recommendations"] == wrapper["recommendations"]


def test_install_persists_recommendations_from_preset_json(client, install_ready, mocker):
    """preset.recommendations at the root of preset.json is persisted alongside
    the workflows[] list so the ComfyGen block can surface them inline."""
    preset = {
        **QWEN_FULL_PRESET,
        "id": "wan-animate",
        "workflows": [
            {"name": "Replace Face", "json": {"3": {"class_type": "WanAnimate"}}},
        ],
        "recommendations": {
            "global": ["Pairs best with a character LoRA"],
            "workflows": {
                "Replace Face": ["Bump mask coverage for tight crops"],
            },
        },
    }
    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([{**_qwen_preset_entry(), "id": "wan-animate", "preset_url": "https://example/preset.json"}]))
        if "preset.json" in url:
            return _mock_response(preset)
        return _mock_response({}, status=404)
    mocker.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get)
    mocker.patch.object(preset_routes.subprocess, "Popen",
                        return_value=_install_preset_success_proc(num_files=2))

    r = client.post("/api/presets/install", json={"preset_id": "wan-animate"})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error")

    # Detail endpoint exposes the same shape end-to-end.
    detail = client.get("/api/presets/installed/wan-animate").json()
    assert detail["recommendations"] == {
        "global": ["Pairs best with a character LoRA"],
        "workflows": {
            "Replace Face": ["Bump mask coverage for tight crops"],
        },
    }
    # And the workflows list is untouched by the recommendations addition.
    assert detail["workflow_json"] == [
        {"name": "Replace Face", "json": {"3": {"class_type": "WanAnimate"}}},
    ]


def test_install_without_recommendations_persists_empty(client, install_ready, mocker):
    """A preset without a `recommendations` field still installs cleanly;
    the detail endpoint surfaces empty scopes (not null / missing)."""
    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([_qwen_preset_entry()]))
        if "preset.json" in url or "example" in url:
            return _mock_response(QWEN_FULL_PRESET)
        return _mock_response({}, status=404)
    mocker.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get)
    mocker.patch.object(preset_routes.subprocess, "Popen",
                        return_value=_install_preset_success_proc(num_files=2))

    r = client.post("/api/presets/install", json={"preset_id": "qwen-image-lighting"})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error")

    detail = client.get("/api/presets/installed/qwen-image-lighting").json()
    assert detail["recommendations"] == {"global": [], "workflows": {}}


# === sgs-ui-gb4: workflows[].settings pass-through ==========================

def _wan_animate_with_settings_preset() -> dict:
    """Preset with two workflows: one has settings, one doesn't."""
    return {
        **QWEN_FULL_PRESET,
        "id": "wan-animate",
        "workflows": [
            {
                "name": "Keep Background",
                "url": "https://example/kb.json",
                "sha256": "0" * 64,
                "settings": [
                    {
                        "node_id": "417",
                        "field": "force_rate",
                        "label": "Source FPS",
                        "type": "int",
                        "min": 1,
                        "max": 60,
                        "step": 1,
                    },
                    {
                        "node_id": "417",
                        "field": "frame_load_cap",
                        "label": "Max frames",
                        "type": "int",
                    },
                ],
            },
            {
                "name": "Replace Face",
                "url": "https://example/rf.json",
                "sha256": "1" * 64,
            },
        ],
    }


def test_install_persists_workflow_settings_through_install(client, install_ready, mocker):
    """workflows[].settings must round-trip end-to-end: preset.json → install
    → settings_store → /installed/{id} response carries the same array."""
    preset = _wan_animate_with_settings_preset()
    wf_kb = {"3": {"class_type": "KSampler"}}
    wf_rf = {"3": {"class_type": "WanAnimate"}}

    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([{**_qwen_preset_entry(), "id": "wan-animate", "preset_url": "https://example/preset.json"}]))
        if "preset.json" in url:
            return _mock_response(preset)
        if "kb.json" in url:
            return _mock_response(wf_kb)
        if "rf.json" in url:
            return _mock_response(wf_rf)
        return _mock_response({}, status=404)

    mocker.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get)
    mocker.patch.object(preset_routes.subprocess, "Popen",
                        return_value=_install_preset_success_proc(num_files=2))

    r = client.post("/api/presets/install", json={"preset_id": "wan-animate"})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error")

    detail = client.get("/api/presets/installed/wan-animate").json()
    flows = detail["workflow_json"]
    assert len(flows) == 2

    kb = next(f for f in flows if f["name"] == "Keep Background")
    assert kb["settings"] == [
        {
            "node_id": "417",
            "field": "force_rate",
            "label": "Source FPS",
            "type": "int",
            "min": 1,
            "max": 60,
            "step": 1,
        },
        {
            "node_id": "417",
            "field": "frame_load_cap",
            "label": "Max frames",
            "type": "int",
        },
    ]

    rf = next(f for f in flows if f["name"] == "Replace Face")
    # Workflows that didn't declare settings get NO settings key in the
    # response — UI treats absence as []. This keeps payloads small for
    # the common case.
    assert "settings" not in rf


def test_legacy_workflow_row_has_no_settings_field(client):
    """A row written before sgs-ui-gb4 doesn't have settings; the detail
    endpoint must not invent it. ComfyGen block treats missing as []."""
    settings_store.record_installed_preset(
        preset_id="legacy",
        version="0.1.0",
        disk_size_gb=5,
        workflow_json='{"3": {"class_type": "KSampler"}}',
    )
    detail = client.get("/api/presets/installed/legacy").json()
    assert detail["workflow_json"] == [
        {"name": "Default", "json": {"3": {"class_type": "KSampler"}}}
    ]


def test_install_inline_workflow_carries_settings(client, install_ready, mocker):
    """Inline workflows (no URL fetch) still carry settings into the row."""
    inline = {"3": {"class_type": "KSampler", "inputs": {"steps": 4}}}
    preset = {
        **QWEN_FULL_PRESET,
        "id": "inline-settings",
        "workflows": [
            {
                "name": "Default",
                "json": inline,
                "settings": [
                    {"node_id": "3", "field": "steps", "label": "Steps", "type": "int"},
                ],
            }
        ],
    }

    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([{**_qwen_preset_entry(), "id": "inline-settings", "preset_url": "https://example/preset.json"}]))
        if "preset.json" in url:
            return _mock_response(preset)
        return _mock_response({}, status=404)
    mocker.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get)
    mocker.patch.object(preset_routes.subprocess, "Popen",
                        return_value=_install_preset_success_proc(num_files=2))

    r = client.post("/api/presets/install", json={"preset_id": "inline-settings"})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error")

    detail = client.get("/api/presets/installed/inline-settings").json()
    assert detail["workflow_json"] == [
        {
            "name": "Default",
            "json": inline,
            "settings": [
                {"node_id": "3", "field": "steps", "label": "Steps", "type": "int"},
            ],
        }
    ]


# === sgs-ui-gb4 follow-up: refresh installed presets ========================

def test_refresh_installed_presets_updates_workflow_blob(client):
    """A preset already in Settings gets its workflow_json blob replaced
    with the registry's latest copy on refresh. The new blob carries the
    newly-added workflows[].settings field through."""
    # Pre-populate Settings with the OLD blob (no settings on Replace Face)
    old_blob = {
        "workflows": [{"name": "Replace Face", "json": {"3": {"class_type": "WanAnimate"}}}],
        "recommendations": {"global": [], "workflows": {}},
    }
    settings_store.record_installed_preset(
        preset_id="wan-animate",
        version="0.2.0",
        disk_size_gb=50,
        workflow_json=json.dumps(old_blob),
        installed_paths=["/runpod-volume/ComfyUI/models/loras/some.safetensors"],
    )

    # Registry now serves a NEW preset.json with a Mask Expansion setting.
    new_preset = {
        **QWEN_FULL_PRESET,
        "id": "wan-animate",
        "workflows": [{
            "name": "Replace Face",
            "url": "https://example/rf.json",
            "sha256": "0" * 64,
            "settings": [
                {"node_id": "554", "field": "value", "label": "Mask Expansion", "type": "int"},
            ],
        }],
        "recommendations": {"global": ["Pair with a character LoRA"], "workflows": {}},
    }
    new_workflow_body = {"3": {"class_type": "WanAnimate"}, "554": {"class_type": "PrimitiveInt"}}

    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([
                {**_qwen_preset_entry(), "id": "wan-animate", "preset_url": "https://example/preset.json"},
            ]))
        if "preset.json" in url:
            return _mock_response(new_preset)
        if "rf.json" in url:
            return _mock_response(new_workflow_body)
        return _mock_response({}, status=404)

    import unittest.mock as _mock
    with _mock.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get):
        summary = preset_routes.refresh_installed_presets()

    assert {r["preset_id"] for r in summary["refreshed"]} == {"wan-animate"}
    assert summary["errors"] == []

    detail = client.get("/api/presets/installed/wan-animate").json()
    flows = detail["workflow_json"]
    assert flows[0]["name"] == "Replace Face"
    # NEW blob — settings now present
    assert flows[0]["settings"] == [
        {"node_id": "554", "field": "value", "label": "Mask Expansion", "type": "int"},
    ]
    # NEW recommendations now present
    assert detail["recommendations"] == {
        "global": ["Pair with a character LoRA"],
        "workflows": {},
    }
    # installed_paths preserved — a metadata refresh must NEVER nuke them,
    # else uninstall stops being able to remove the model files.
    raw = settings_store.get_installed_preset("wan-animate")
    assert raw["installed_paths"] == ["/runpod-volume/ComfyUI/models/loras/some.safetensors"]


def test_refresh_installed_presets_skips_presets_not_in_manifest(client):
    """A preset that was archived from the registry stays in Settings — we
    don't silently uninstall on the user's behalf."""
    settings_store.record_installed_preset(
        preset_id="archived",
        version="0.1.0",
        disk_size_gb=10,
        workflow_json=json.dumps({"workflows": [{"name": "Default", "json": {}}], "recommendations": {}}),
        installed_paths=["/keep/me.safetensors"],
    )

    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([]))  # archived not present
        return _mock_response({}, status=404)

    import unittest.mock as _mock
    with _mock.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get):
        summary = preset_routes.refresh_installed_presets()

    assert summary["refreshed"] == []
    assert any(s["preset_id"] == "archived" for s in summary["skipped"])
    # Row untouched
    raw = settings_store.get_installed_preset("archived")
    assert raw is not None
    assert raw["installed_paths"] == ["/keep/me.safetensors"]


def test_refresh_installed_presets_records_error_when_detail_fetch_fails(client):
    """If we can reach the manifest but the preset.json fetch fails, the
    existing Settings row is preserved and the failure is reported in the
    summary — no silent data loss."""
    settings_store.record_installed_preset(
        preset_id="wan-animate",
        version="0.2.0",
        disk_size_gb=50,
        workflow_json=json.dumps({"workflows": [{"name": "Replace Face", "json": {"3": {}}}], "recommendations": {}}),
        installed_paths=["/x.safetensors"],
    )

    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([
                {**_qwen_preset_entry(), "id": "wan-animate", "preset_url": "https://example/preset.json"},
            ]))
        if "preset.json" in url:
            return _mock_response({}, status=500)
        return _mock_response({}, status=404)

    import unittest.mock as _mock
    with _mock.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get):
        summary = preset_routes.refresh_installed_presets()

    assert summary["refreshed"] == []
    assert any(e["preset_id"] == "wan-animate" for e in summary["errors"])
    detail = client.get("/api/presets/installed/wan-animate").json()
    assert detail["workflow_json"][0]["name"] == "Replace Face"


def test_refresh_installed_presets_returns_empty_when_nothing_installed(client):
    """No installed rows → nothing to do, no network calls, empty summary."""
    summary = preset_routes.refresh_installed_presets()
    assert summary == {"refreshed": [], "skipped": [], "errors": []}


def test_refresh_installed_route_returns_summary(client, mocker):
    """POST /api/presets/refresh-installed returns the same summary as the
    underlying function — used by the manual 'Refresh' UI affordance."""
    settings_store.record_installed_preset(
        preset_id="wan-animate",
        version="0.2.0",
        disk_size_gb=50,
        workflow_json=json.dumps({"workflows": [{"name": "Replace Face", "json": {}}], "recommendations": {}}),
        installed_paths=[],
    )
    new_preset = {
        **QWEN_FULL_PRESET,
        "id": "wan-animate",
        "workflows": [{"name": "Replace Face", "json": {"3": {}}}],
    }
    def _fake_get(url, **kw):
        if "manifest.json" in url:
            return _mock_response(_manifest([
                {**_qwen_preset_entry(), "id": "wan-animate", "preset_url": "https://example/preset.json"},
            ]))
        if "preset.json" in url:
            return _mock_response(new_preset)
        return _mock_response({}, status=404)
    mocker.patch.object(preset_routes._cffi_requests, "get", side_effect=_fake_get)

    r = client.post("/api/presets/refresh-installed")
    assert r.status_code == 200
    body = r.json()
    assert {p["preset_id"] for p in body["refreshed"]} == {"wan-animate"}
