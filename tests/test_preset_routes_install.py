"""sgs-ui-8ww: install-preset CLI flow.

BlockFlow now shells out to `comfy-gen install-preset --preset-id <id>
--volume-id <vid>`. The CLI streams line-delimited JSON events on stdout;
this module verifies _install_state is driven correctly off those events
and that the cancel route signals the subprocess cleanly.
"""
from __future__ import annotations

import io
import json
import signal
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import preset_routes, runpod_api, settings_store  # noqa: E402

# === fixtures ===============================================================

@pytest.fixture
def app(tmp_path, monkeypatch):
    db_path = tmp_path / "preset_install_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    monkeypatch.setattr(preset_routes, "_CACHE_PATH", tmp_path / "manifest_cache.json")
    preset_routes._cache_reset()
    preset_routes._reset_install_state()

    settings_store.set_credential("runpod_api_key", "rpa_test")
    settings_store.set_endpoint(
        "comfygen", endpoint_id="ep_test", template_name="tn", volume_id="vol_test",
    )

    fastapi_app = FastAPI()
    fastapi_app.include_router(preset_routes.router)
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


def _manifest_with(preset_id: str = "qwen-image-lighting") -> dict:
    return {
        "manifest_version": 1,
        "presets": [{
            "id": preset_id,
            "name": preset_id,
            "comfygen_min_version": "0.2.0",
            "disk_size_estimate_gb": 50,
            "preset_url": "https://example/preset.json",
        }],
    }


def _full_preset(preset_id: str = "qwen-image-lighting", n_models: int = 4) -> dict:
    return {
        "id": preset_id,
        "name": preset_id,
        "comfygen_min_version": "0.2.0",
        "disk_size_estimate_gb": 50,
        "workflows": [{"name": "Default", "json": {"3": {}}}],
        "models": [
            {"source": "huggingface", "url": f"https://x/file{i}.safetensors",
             "dest": f"diffusion_models/file{i}.safetensors", "sha256": f"{i:064d}",
             "size_gb": 1.0}
            for i in range(n_models)
        ],
    }


def _ok_response(body):
    m = MagicMock()
    m.status_code = 200
    m.text = json.dumps(body)
    m.json = lambda: body
    return m


def _events_to_stdout(events: list[dict]) -> str:
    """Render a list of event dicts as the CLI's line-delimited JSON stdout."""
    return "".join(json.dumps(e) + "\n" for e in events)


def _make_proc(stdout: str = "", stderr: str = "", returncode: int = 0) -> MagicMock:
    """Mimic subprocess.Popen with line-iterable stdout/stderr."""
    proc = MagicMock()
    proc.stdout = io.StringIO(stdout)
    proc.stderr = io.StringIO(stderr)
    proc.wait.return_value = returncode
    proc.returncode = returncode
    proc.poll.return_value = returncode
    return proc


def _wait_for_install_state(*targets: str, attempts: int = 300, sleep_s: float = 0.02):
    for _ in range(attempts):
        if preset_routes._install_state["state"] in targets:
            return
        time.sleep(sleep_s)


def _mock_registry_fetches(mocker, preset: dict):
    """Patch curl_cffi.requests.get so the manifest and preset.json resolve
    to in-memory bodies."""
    mocker.patch.object(
        preset_routes._cffi_requests, "get",
        MagicMock(side_effect=[
            _ok_response(_manifest_with(preset["id"])),
            _ok_response(preset),
        ])
    )


# === Task 1: backend wiring =================================================

def test_install_drives_state_through_full_event_stream(client, mocker):
    """Happy path: queued → running → completed; files_total comes from
    preflight_ok; files_done increments per download_done."""
    preset = _full_preset(n_models=4)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_abc", "token": "tok"},
        {"type": "preflight_start"},
        {"type": "preflight_ok", "preset_id": preset["id"], "models_count": 4,
         "total_bytes": 50_000_000_000, "volume_free_bytes": 200_000_000_000},
        *[{"type": "download_start", "file_index": i,
           "file": f"/runpod-volume/ComfyUI/models/diffusion_models/file{i}.safetensors"}
          for i in range(4)],
        *[{"type": "download_done", "file_index": i,
           "file": f"/runpod-volume/ComfyUI/models/diffusion_models/file{i}.safetensors",
           "cached": False, "bytes": 12_000_000_000, "sha256": f"{i:064d}"}
          for i in range(4)],
        {"type": "install_done", "ok": True, "files": 4, "elapsed_sec": 280},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202

    _wait_for_install_state("completed", "error", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "completed", s
    assert s["files_total"] == 4
    assert s["files_done"] == 4
    assert s["pod_id"] == "pod_abc"
    assert s["total_download_bytes"] == 50_000_000_000
    # all 4 were not cached → missing_count is 4
    assert s["missing_count"] == 4
    assert s["cached_count"] == 0
    # Settings row recorded with pod_id + cost
    row = settings_store.get_installed_preset(preset["id"])
    assert row is not None
    assert row["pod_id"] == "pod_abc"
    assert row["install_mode"] == "cpu"
    assert row["cost_per_hr_at_spawn"] == pytest.approx(0.06)
    assert len(row["installed_paths"]) == 4

    # Verify the CLI was invoked with the right argv shape.
    args = preset_routes.subprocess.Popen.call_args.args[0]
    assert args[:2] == ["comfy-gen", "install-preset"]
    assert "--preset-id" in args and preset["id"] in args
    assert "--volume-id" in args and "vol_test" in args


def test_install_error_event_marks_failed_and_keeps_pod_id(client, mocker):
    """install_error mid-stream → state=error, error includes the reason,
    pod_id stays populated so the UI can render a logs link."""
    preset = _full_preset(n_models=2)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_xyz", "token": "tok"},
        {"type": "preflight_ok", "preset_id": preset["id"], "models_count": 2,
         "total_bytes": 0, "volume_free_bytes": 0},
        {"type": "download_start", "file_index": 0, "file": "a"},
        {"type": "install_error", "stage": "download",
         "reason": "aria2c exit 122: disk quota exceeded"},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=1)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "error"
    assert "aria2c exit 122" in s["error"]
    assert s["pod_id"] == "pod_xyz"
    assert settings_store.get_installed_preset(preset["id"]) is None


def test_preflight_fail_marks_failed_without_downloads(client, mocker):
    """preflight_fail terminal → state=error, no download_* events ever
    recorded → cached/missing counts stay zero."""
    preset = _full_preset(n_models=2)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_p", "token": "tok"},
        {"type": "preflight_start"},
        {"type": "preflight_fail",
         "reason": "preset not found in registry manifest"},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=1)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "error"
    assert "preset not found" in s["error"]
    assert s["files_done"] == 0
    assert s["cached_count"] == 0 and s["missing_count"] == 0


def test_subprocess_exits_nonzero_without_terminal_event(client, mocker):
    """No terminal event + non-zero exit → state=error with 'no terminal
    event' surfaced; stderr tail is hinted into the error message."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout=_events_to_stdout([{"type": "pod_spawned", "pod_id": "p1", "token": "t"}]),
        stderr="comfy-gen: pod spawn raced with health check\n",
        returncode=1,
    )
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "error"
    assert "no terminal event" in s["error"]


def test_concurrent_install_returns_409(client, mocker):
    """Second POST while the first install is still running → 409 with the
    in-flight preset id in the detail."""
    preset = _full_preset(n_models=1)
    # Reuse the same mock for both requests' registry fetches.
    fetches = [
        _ok_response(_manifest_with(preset["id"])),
        _ok_response(preset),
        _ok_response(_manifest_with(preset["id"])),
        _ok_response(preset),
    ]
    mocker.patch.object(preset_routes._cffi_requests, "get",
                        MagicMock(side_effect=fetches))

    # Pretend an install is already running.
    preset_routes._install_state.update({
        "state": "running",
        "preset_id": "previous-preset",
    })

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 409
    assert "previous-preset" in r.json()["detail"]


# === Task 1 edge case 5: cancel via the cancel route ========================

def test_cancel_signals_subprocess_and_marks_cancelled(client, mocker):
    """POST /api/presets/install/cancel → SIGINT to the tracked subprocess
    → state ends 'cancelled' once the subprocess exits."""
    preset = _full_preset(n_models=2)
    _mock_registry_fetches(mocker, preset)

    # Build a proc whose stdout blocks until we let it finish, so the cancel
    # route has a live subprocess to signal.
    release = threading.Event()

    class _BlockingStdout:
        def __init__(self):
            self._sent = False

        def readline(self):
            if not self._sent:
                self._sent = True
                return json.dumps(
                    {"type": "pod_spawned", "pod_id": "pod_c", "token": "t"}
                ) + "\n"
            # Block until cancel arrives, then EOF.
            release.wait(timeout=5)
            return ""

    sigint_calls: list[int] = []

    proc = MagicMock()
    proc.stdout = _BlockingStdout()
    proc.stderr = io.StringIO("")

    def _send_signal(sig):
        sigint_calls.append(sig)
        # Simulate the CLI catching SIGINT and exiting.
        release.set()
    proc.send_signal.side_effect = _send_signal
    proc.wait.return_value = 130  # 128+SIGINT
    proc.returncode = 130
    proc.poll.return_value = 130

    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202

    # Wait until the runner has stored the proc handle and progressed to
    # running.
    for _ in range(200):
        if (preset_routes._install_proc["proc"] is not None
                and preset_routes._install_state["state"] == "running"):
            break
        time.sleep(0.02)

    r = client.post("/api/presets/install/cancel")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "cancelling"

    _wait_for_install_state("cancelled", "error", "completed")

    assert sigint_calls == [signal.SIGINT]
    s = preset_routes._install_state
    assert s["state"] == "cancelled"
    assert settings_store.get_installed_preset(preset["id"]) is None


def test_cancel_returns_409_when_no_install_in_progress(client):
    r = client.post("/api/presets/install/cancel")
    assert r.status_code == 409


# === Task 2: volume resolution ==============================================

def test_install_uses_volume_id_from_endpoint_settings_when_present(client, mocker):
    """If settings_endpoints already carries volume_id, we don't hit the
    RunPod REST API at all — saves one network round-trip per install."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout=_events_to_stdout([
            {"type": "pod_spawned", "pod_id": "p", "token": "t"},
            {"type": "preflight_ok", "models_count": 1, "total_bytes": 0,
             "volume_free_bytes": 0},
            {"type": "download_done", "file_index": 0, "file": "/x",
             "cached": True, "bytes": 0, "sha256": "0" * 64},
            {"type": "install_done", "ok": True, "files": 1, "elapsed_sec": 1},
        ]),
        returncode=0,
    )
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)
    rest_spy = mocker.patch.object(runpod_api, "_rest_get")

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error")

    rest_spy.assert_not_called()
    args = preset_routes.subprocess.Popen.call_args.args[0]
    assert "vol_test" in args


def test_resolve_volume_for_endpoint_picks_networkVolumeId(monkeypatch):
    """When Settings lacks volume_id, the resolver queries the endpoint and
    extracts networkVolumeId. Result is cached."""
    preset_routes._volume_cache.clear()
    calls: list[str] = []

    def _fake_get(api_key, path):
        calls.append(path)
        return {"networkVolumeId": "vol_resolved"}

    monkeypatch.setattr(preset_routes.runpod_api, "_rest_get", _fake_get)
    vol1 = preset_routes._resolve_volume_for_endpoint("rpa", "ep_x")
    vol2 = preset_routes._resolve_volume_for_endpoint("rpa", "ep_x")
    assert vol1 == vol2 == "vol_resolved"
    assert calls == ["/endpoints/ep_x"], "second call should hit the cache"


def test_resolve_volume_for_endpoint_400_when_no_volume_attached(monkeypatch):
    """Endpoint without a network volume → install can't proceed; surface a
    400 with a clear message rather than letting the CLI fail mysteriously."""
    from fastapi import HTTPException
    preset_routes._volume_cache.clear()
    monkeypatch.setattr(
        preset_routes.runpod_api, "_rest_get",
        lambda api_key, path: {"id": "ep_x"},  # no networkVolumeId anywhere
    )
    with pytest.raises(HTTPException) as exc:
        preset_routes._resolve_volume_for_endpoint("rpa", "ep_x")
    assert exc.value.status_code == 400
    assert "network volume" in exc.value.detail.lower()


# === Task 3: settings_store columns =========================================

def test_record_installed_preset_round_trips_pod_id_and_cost(tmp_path, monkeypatch):
    """The new columns must round-trip through record_installed_preset /
    get_installed_preset so the UI can render a post-install summary."""
    db = tmp_path / "test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db)
    settings_store.init_db()

    settings_store.record_installed_preset(
        preset_id="p1", version="0.2.0", disk_size_gb=50,
        workflow_json='{"workflows": [], "recommendations": {}}',
        installed_paths=["/runpod-volume/x"],
        pod_id="pod_abc", install_mode="cpu", cost_per_hr_at_spawn=0.06,
    )
    row = settings_store.get_installed_preset("p1")
    assert row is not None
    assert row["pod_id"] == "pod_abc"
    assert row["install_mode"] == "cpu"
    assert row["cost_per_hr_at_spawn"] == pytest.approx(0.06)


# === sgs-ui-wx0: status-shaped early-exit + supply-constraint UX + GPU fallback ====

def test_status_shaped_early_exit_becomes_terminal_error(client, mocker):
    """The CLI emits early-exit failures (e.g. no CPU SKU available) as
    `{"status": "error", "error": "..."}` on stdout instead of the
    documented `{"type": "install_error"}` envelope. The runner must treat
    that line as a terminal error and surface the reason."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout='{"status": "error", "error": "SUPPLY_CONSTRAINT: no CPU instance available across all 4 SKUs"}\n',
        returncode=1,
    )
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "error"
    assert "SUPPLY_CONSTRAINT" in s["error"]
    assert "no terminal event" not in s["error"]


def test_error_kind_supply_constraint_classification(client, mocker):
    """Terminal error containing SUPPLY_CONSTRAINT → error_kind='supply_constraint'."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout='{"status": "error", "error": "SUPPLY_CONSTRAINT: out of CPU"}\n',
        returncode=1,
    )
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("error", "completed", "cancelled")

    assert preset_routes._install_state["error_kind"] == "supply_constraint"


def test_error_kind_unknown_for_non_supply_failures(client, mocker):
    """Any other terminal error → error_kind='unknown' so the UI doesn't
    show the friendly retry copy and the user sees the raw reason."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "p", "token": "t"},
        {"type": "preflight_ok", "models_count": 1, "total_bytes": 0,
         "volume_free_bytes": 0},
        {"type": "install_error", "stage": "download",
         "reason": "aria2c exit 122: disk quota exceeded"},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=1)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("error", "completed", "cancelled")

    assert preset_routes._install_state["error_kind"] == "unknown"


def test_classify_error_kind_pure_helper():
    """Pure helper: regex-style detection of supply-constraint failures.
    Both the magic token and the human phrase should match."""
    assert preset_routes._classify_error_kind(
        "SUPPLY_CONSTRAINT: nothing available") == "supply_constraint"
    assert preset_routes._classify_error_kind(
        "RunPod returned 'no CPU instance available'") == "supply_constraint"
    assert preset_routes._classify_error_kind(
        "aria2c exit 122 disk quota exceeded") == "unknown"
    assert preset_routes._classify_error_kind("") == "unknown"


def test_install_mode_gpu_uses_old_download_cli(client, mocker):
    """POST /api/presets/install?mode=gpu must invoke `comfy-gen download
    --batch ... --endpoint-id <ep>` (the pre-8ww flow), NOT
    `comfy-gen install-preset`. On success, Settings.install_mode='gpu'
    and pod_id=None (the GPU endpoint isn't a pod BlockFlow controls)."""
    preset = _full_preset(n_models=2)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout='{"ok": true, "files": []}\n',
        stderr="[1/2] downloaded file0.safetensors\n[2/2] downloaded file1.safetensors\n",
        returncode=0,
    )
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post(
        "/api/presets/install?mode=gpu",
        json={"preset_id": preset["id"]},
    )
    assert r.status_code == 202
    _wait_for_install_state("completed", "error", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "completed", s

    args = preset_routes.subprocess.Popen.call_args.args[0]
    assert args[:2] == ["comfy-gen", "download"]
    assert "install-preset" not in args
    assert "--batch" in args
    assert "--endpoint-id" in args and "ep_test" in args

    row = settings_store.get_installed_preset(preset["id"])
    assert row is not None
    assert row["install_mode"] == "gpu"
    assert row["pod_id"] is None
    assert row["cost_per_hr_at_spawn"] is None
    assert len(row["installed_paths"]) == 2


def test_install_mode_gpu_failure_surfaces_stderr(client, mocker):
    """When `comfy-gen download` exits non-zero in GPU mode, the install
    state lands on error with the stderr tail in the message."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout="",
        stderr="comfy-gen: endpoint returned 502\n",
        returncode=1,
    )
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post(
        "/api/presets/install?mode=gpu",
        json={"preset_id": preset["id"]},
    )
    assert r.status_code == 202
    _wait_for_install_state("error", "completed", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "error"
    assert "502" in s["error"]
    assert settings_store.get_installed_preset(preset["id"]) is None
