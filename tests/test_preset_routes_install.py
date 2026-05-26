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


# === sgs-ui-41c: preflight refuse when CivitAI-source preset has no token ===
# The CLI fails ~3-5 minutes into the install (pod spawn + preflight + first
# 401 from CivitAI) without a token. Catch it at submit time instead.

def _civitai_preset(preset_id: str = "civitai-pack") -> dict:
    return {
        "id": preset_id,
        "name": preset_id,
        "comfygen_min_version": "0.2.0",
        "disk_size_estimate_gb": 10,
        "workflows": [{"name": "Default", "json": {"3": {}}}],
        "models": [{
            "source": "civitai",
            "url": "https://civitai.com/api/download/models/123456",
            "dest": "loras/style.safetensors",
            "sha256": "0" * 64,
            "size_gb": 1.0,
        }],
    }


def test_install_refused_when_civitai_preset_has_no_credential(client, mocker):
    """source=='civitai' + no civitai_api_key in settings → 400 with a
    structured detail that the UI can render as a 'go set the credential'
    banner. install_state untouched; Popen NOT called."""
    preset = _civitai_preset()
    _mock_registry_fetches(mocker, preset)
    popen = mocker.patch.object(preset_routes.subprocess, "Popen")

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 400, r.json()
    detail = r.json()["detail"]
    assert isinstance(detail, dict), detail
    assert detail.get("error_kind") == "missing_credential"
    assert detail.get("credential") == "civitai_api_key"
    assert detail.get("preset_id") == preset["id"]
    assert popen.call_count == 0
    assert preset_routes._install_state["state"] == "idle"


def test_install_allowed_when_civitai_preset_has_credential(client, mocker):
    """Credential present → request proceeds as normal."""
    settings_store.set_credential("civitai_api_key", "ck_present")
    preset = _civitai_preset()
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_ok", "token": "t"},
        {"type": "install_done", "ok": True, "files": 0, "elapsed_sec": 1},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202


def test_install_detects_civitai_by_url_when_source_field_missing(client, mocker):
    """Defensive: some presets only set the URL (source omitted). If the
    URL hostname is civitai.com, the gate still fires."""
    preset = _civitai_preset()
    preset["models"][0].pop("source", None)
    _mock_registry_fetches(mocker, preset)
    popen = mocker.patch.object(preset_routes.subprocess, "Popen")

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 400
    assert r.json()["detail"]["credential"] == "civitai_api_key"
    assert popen.call_count == 0


def test_install_allows_non_civitai_preset_without_civitai_credential(client, mocker):
    """HF-only preset without a CivitAI credential set → 202 (no false
    positive). The civitai gate must only fire when civitai sources exist."""
    preset = _full_preset(n_models=1)  # _full_preset uses huggingface
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_hf", "token": "t"},
        {"type": "install_done", "ok": True, "files": 0, "elapsed_sec": 1},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202


# === sgs-ui-5k7: phase + bytes_done for milestone UI ========================
# The UI renders a milestone list (pod_spawn → preflight → download →
# finalize → done|error) and a bytes-based progress bar. _install_state
# must expose `phase` and `bytes_done` so the frontend doesn't have to
# re-derive them from `files[]`.

def test_initial_install_state_has_phase_idle_and_bytes_done_zero():
    """Fresh state after _reset_install_state."""
    preset_routes._reset_install_state()
    s = preset_routes._install_state
    assert s["phase"] == "idle"
    assert s["bytes_done"] == 0


def test_process_event_pod_spawned_sets_phase_preflight():
    """pod_spawned → pod is up, agent is starting preflight."""
    preset_routes._reset_install_state()
    preset_routes._process_install_event(
        {"type": "pod_spawned", "pod_id": "p1", "token": "t"}
    )
    assert preset_routes._install_state["phase"] == "preflight"
    assert preset_routes._install_state["pod_id"] == "p1"


def test_process_event_preflight_ok_sets_phase_download():
    """preflight_ok → we now know totals; downloads start next."""
    preset_routes._reset_install_state()
    preset_routes._process_install_event(
        {"type": "preflight_ok", "preset_id": "x", "models_count": 4,
         "total_bytes": 40_000_000_000, "volume_free_bytes": 0}
    )
    assert preset_routes._install_state["phase"] == "download"
    assert preset_routes._install_state["total_download_bytes"] == 40_000_000_000


def test_bytes_done_uses_average_estimate_for_in_flight_files():
    """download_progress 50% on file 0 of 4 (total=40GB) → bytes_done is
    ~5GB (avg 10GB per file × 50%)."""
    preset_routes._reset_install_state()
    preset_routes._process_install_event(
        {"type": "preflight_ok", "models_count": 4,
         "total_bytes": 40_000_000_000, "volume_free_bytes": 0}
    )
    preset_routes._process_install_event(
        {"type": "download_start", "file_index": 0, "file": "a"}
    )
    preset_routes._process_install_event(
        {"type": "download_progress", "file_index": 0, "file": "a",
         "percent": 50.0, "speed": "100MB"}
    )
    assert preset_routes._install_state["bytes_done"] == 5_000_000_000


def test_bytes_done_sums_completed_and_in_flight():
    """1 file done (12GB actual) + 1 in flight at 25% of avg(10GB) → 14.5GB."""
    preset_routes._reset_install_state()
    preset_routes._process_install_event(
        {"type": "preflight_ok", "models_count": 4,
         "total_bytes": 40_000_000_000, "volume_free_bytes": 0}
    )
    preset_routes._process_install_event(
        {"type": "download_done", "file_index": 0, "file": "a",
         "cached": False, "bytes": 12_000_000_000, "sha256": "x"}
    )
    preset_routes._process_install_event(
        {"type": "download_progress", "file_index": 1, "file": "b",
         "percent": 25.0, "speed": ""}
    )
    s = preset_routes._install_state
    # 12e9 done + 0.25 * (40e9/4) = 12e9 + 2.5e9 = 14.5e9
    assert s["bytes_done"] == 14_500_000_000


def test_bytes_done_falls_back_to_completed_sum_when_no_total():
    """preflight_ok absent or total_bytes=0 → bytes_done = sum of done bytes only."""
    preset_routes._reset_install_state()
    # Simulate files[] from preflight_ok with no total_bytes
    preset_routes._process_install_event(
        {"type": "preflight_ok", "models_count": 2,
         "total_bytes": 0, "volume_free_bytes": 0}
    )
    preset_routes._process_install_event(
        {"type": "download_done", "file_index": 0, "file": "a",
         "cached": False, "bytes": 7_000_000_000, "sha256": "x"}
    )
    preset_routes._process_install_event(
        {"type": "download_progress", "file_index": 1, "file": "b",
         "percent": 50.0, "speed": ""}
    )
    # No estimate possible for in-flight → only completed bytes count.
    assert preset_routes._install_state["bytes_done"] == 7_000_000_000


def test_install_state_transitions_through_all_phases(client, mocker):
    """End-to-end: phase goes idle → pod_spawn → preflight → download → finalize → done."""
    preset = _full_preset(n_models=2)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_z", "token": "tok"},
        {"type": "preflight_ok", "preset_id": preset["id"], "models_count": 2,
         "total_bytes": 20_000_000_000, "volume_free_bytes": 0},
        {"type": "download_start", "file_index": 0, "file": "/x/a"},
        {"type": "download_done", "file_index": 0, "file": "/x/a",
         "cached": False, "bytes": 10_000_000_000, "sha256": "0"*64},
        {"type": "download_start", "file_index": 1, "file": "/x/b"},
        {"type": "download_done", "file_index": 1, "file": "/x/b",
         "cached": False, "bytes": 10_000_000_000, "sha256": "1"*64},
        {"type": "install_done", "ok": True, "files": 2, "elapsed_sec": 60},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("completed", "error", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "completed"
    assert s["phase"] == "done"
    assert s["bytes_done"] == 20_000_000_000


def test_install_error_keeps_phase_at_failure_point(client, mocker):
    """sgs-ui-5k7: when state flips to 'error', `phase` should stay at the
    step that was active when failure happened — so the UI can mark that
    specific milestone with ✗. install_error mid-download → phase='download'."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_e", "token": "tok"},
        {"type": "preflight_ok", "preset_id": preset["id"], "models_count": 1,
         "total_bytes": 1_000_000, "volume_free_bytes": 0},
        {"type": "install_error", "stage": "download", "reason": "boom"},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=1)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("error", "completed", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "error"
    # phase NOT 'error' — UI derives error placement from (phase, state).
    assert s["phase"] == "download"


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


# --- sgs-ui-h1c.1.4 / sgs-ui-8ef: tokens via env, not argv -----------------
# BlockFlow must (a) read the CivitAI token under the 'civitai_api_key' key
# (UI + every other reader uses that), and (b) pass it to the comfy-gen
# subprocess as COMFY_GEN_CIVITAI_TOKEN on env= rather than --civitai-token
# on argv (so the token doesn't show up in `ps`). Same for HF.

def test_install_passes_civitai_token_via_env_not_argv(client, mocker):
    """Credential set as 'civitai_api_key' → Popen called with
    COMFY_GEN_CIVITAI_TOKEN in env; argv MUST NOT contain --civitai-token
    or the token value."""
    settings_store.set_credential("civitai_api_key", "ck_secret_xyz")
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_t", "token": "tok"},
        {"type": "install_done", "ok": True, "files": 0, "elapsed_sec": 1},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    popen = mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    r = client.post("/api/presets/install", json={"preset_id": preset["id"]})
    assert r.status_code == 202
    _wait_for_install_state("completed", "error", "cancelled")

    call = popen.call_args
    argv = call.args[0]
    env = call.kwargs.get("env") or {}

    assert "--civitai-token" not in argv, f"token leaked onto argv: {argv}"
    assert "ck_secret_xyz" not in argv, f"token value leaked onto argv: {argv}"
    assert env.get("COMFY_GEN_CIVITAI_TOKEN") == "ck_secret_xyz", env


def test_install_passes_hf_token_via_env_not_argv(client, mocker):
    """HF token reaches the subprocess as COMFY_GEN_HF_TOKEN; never on argv."""
    settings_store.set_credential("hf_token", "hf_secret_abc")
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_h", "token": "tok"},
        {"type": "install_done", "ok": True, "files": 0, "elapsed_sec": 1},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    popen = mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("completed", "error", "cancelled")

    call = popen.call_args
    argv = call.args[0]
    env = call.kwargs.get("env") or {}
    assert "--hf-token" not in argv
    assert "hf_secret_abc" not in argv
    assert env.get("COMFY_GEN_HF_TOKEN") == "hf_secret_abc"


def test_install_omits_token_env_when_not_configured(client, mocker):
    """No credential set → env keys absent (not empty-string) so the CLI's
    env-first fallback doesn't see a spurious empty value."""
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_n", "token": "tok"},
        {"type": "install_done", "ok": True, "files": 0, "elapsed_sec": 1},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    popen = mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("completed", "error", "cancelled")

    env = popen.call_args.kwargs.get("env") or {}
    assert "COMFY_GEN_CIVITAI_TOKEN" not in env
    assert "COMFY_GEN_HF_TOKEN" not in env


def test_install_env_forwards_path(client, mocker):
    """env= replaces the inherited environment entirely, so we MUST forward
    PATH explicitly — otherwise `comfy-gen` won't resolve on the subprocess."""
    settings_store.set_credential("civitai_api_key", "ck_x")
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_p", "token": "tok"},
        {"type": "install_done", "ok": True, "files": 0, "elapsed_sec": 1},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    popen = mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("completed", "error", "cancelled")

    env = popen.call_args.kwargs.get("env") or {}
    assert "PATH" in env and env["PATH"], "env=dict dropped PATH"


# --- sgs-ui-6ag: 90s pod-delete grace on install failure -------------------
# Gives the user a window to view pod logs / SSH in before the pod
# disappears. Success path stays immediate (no debugging window needed).

def test_install_error_schedules_delayed_delete_not_immediate(client, mocker):
    """install_error → delete_pod_post_install NOT called synchronously.
    The grace-period scheduler is called instead."""
    from backend import installer_pod_sweeper
    delete_mock = mocker.patch.object(
        installer_pod_sweeper, "delete_pod_post_install", return_value=True,
    )
    schedule_spy = mocker.patch.object(
        preset_routes, "_schedule_delayed_pod_delete",
    )
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_grace1", "token": "tok"},
        {"type": "install_error", "stage": "download", "reason": "boom"},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=1)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("error", "completed", "cancelled")

    assert delete_mock.call_count == 0  # immediate delete must NOT fire
    schedule_spy.assert_called_once_with("pod_grace1")


def test_schedule_delayed_delete_sets_pod_delete_at_in_future(mocker):
    """Unit test on the helper itself: stashes a future pod_delete_at on
    _install_state. We patch threading.Thread so we don't actually wait."""
    from datetime import datetime, timezone
    import threading as _t
    preset_routes._reset_install_state()

    class _FakeThread:
        def __init__(self, *_a, **_kw): pass
        def start(self): pass
    mocker.patch.object(_t, "Thread", _FakeThread)

    preset_routes._schedule_delayed_pod_delete("pod_x", delay_sec=90)

    s = preset_routes._install_state
    assert s.get("pod_delete_at") is not None
    deadline = datetime.fromisoformat(s["pod_delete_at"])
    now = datetime.now(timezone.utc)
    delta = (deadline - now).total_seconds()
    assert 60 < delta <= 90, f"pod_delete_at ≈90s in future; got {delta}s"


def test_install_success_keeps_immediate_pod_delete(client, mocker):
    """Regression: success path must still tear down the pod immediately."""
    from backend import installer_pod_sweeper
    delete_mock = mocker.patch.object(
        installer_pod_sweeper, "delete_pod_post_install", return_value=True,
    )
    schedule_spy = mocker.patch.object(
        preset_routes, "_schedule_delayed_pod_delete",
    )
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_ok", "token": "t"},
        {"type": "install_done", "ok": True, "files": 0, "elapsed_sec": 1},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=0)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("completed", "error", "cancelled")

    delete_mock.assert_called_once_with("pod_ok")
    assert schedule_spy.call_count == 0


def test_schedule_delayed_delete_no_op_when_pod_id_missing():
    """Defensive: helper does nothing when there's no pod_id (e.g. install
    failed before pod_spawned)."""
    preset_routes._reset_install_state()
    preset_routes._schedule_delayed_pod_delete(None)
    assert preset_routes._install_state.get("pod_delete_at") is None


# --- sgs-ui-kqr: download_done is idempotent per file_index ----------------
# Without dedupe, a duplicate event (already-on-disk skip emits a synthetic
# download_done, retries re-emit) pushes files_done past files_total.

def test_duplicate_download_done_increments_counts_only_once():
    """Two download_done events for the same file_index should produce
    cached_count=1 and files_done=1, not 2 each."""
    preset_routes._reset_install_state()
    preset_routes._process_install_event(
        {"type": "preflight_ok", "models_count": 2,
         "total_bytes": 0, "volume_free_bytes": 0}
    )
    evt = {"type": "download_done", "file_index": 0, "file": "a",
           "cached": True, "bytes": 1, "sha256": "x"}
    preset_routes._process_install_event(evt)
    preset_routes._process_install_event(evt)  # duplicate

    s = preset_routes._install_state
    assert s["files_done"] == 1, s
    assert s["cached_count"] == 1, s
    assert s["missing_count"] == 0, s


def test_distinct_download_dones_still_aggregate():
    """Defensive: dedupe must not break the normal flow — distinct file
    indices still each contribute +1."""
    preset_routes._reset_install_state()
    preset_routes._process_install_event(
        {"type": "preflight_ok", "models_count": 3,
         "total_bytes": 0, "volume_free_bytes": 0}
    )
    for i in range(3):
        preset_routes._process_install_event(
            {"type": "download_done", "file_index": i, "file": f"f{i}",
             "cached": False, "bytes": 1, "sha256": "x"}
        )

    s = preset_routes._install_state
    assert s["files_done"] == 3
    assert s["missing_count"] == 3
    assert s["cached_count"] == 0


# --- sgs-ui-515: pod must be DELETEd on every install failure path ---------
# Pods do not self-clean — without this, the pod leaks at $0.06/hr until the
# installer_pod_sweeper Rule B (5min orphan) or Rule C (60min stuck) catches
# it. Symmetric with the success branch at preset_routes.py:926-930.

def test_install_error_schedules_pod_delete(client, mocker):
    """install_error terminal → delete is SCHEDULED for ~90s out, not
    immediate (sgs-ui-6ag superseded sgs-ui-515's immediate-delete).
    Settings row still not written; pod_id preserved for the logs link."""
    schedule_spy = mocker.patch.object(
        preset_routes, "_schedule_delayed_pod_delete",
    )
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_err1", "token": "tok"},
        {"type": "install_error", "stage": "download", "reason": "boom"},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=1)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("error", "completed", "cancelled")

    assert preset_routes._install_state["state"] == "error"
    schedule_spy.assert_called_once_with("pod_err1")


def test_no_terminal_event_schedules_pod_delete(client, mocker):
    """Subprocess exits non-zero with no terminal event → grace-period
    schedule, not immediate delete."""
    schedule_spy = mocker.patch.object(
        preset_routes, "_schedule_delayed_pod_delete",
    )
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout=_events_to_stdout([{"type": "pod_spawned", "pod_id": "pod_nt", "token": "t"}]),
        stderr="crash\n",
        returncode=1,
    )
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("error", "completed", "cancelled")

    assert preset_routes._install_state["state"] == "error"
    schedule_spy.assert_called_once_with("pod_nt")


def test_outer_exception_schedules_pod_delete(client, mocker):
    """proc.wait() raises after pod_spawned → outer except path still
    schedules the pod delete with grace."""
    schedule_spy = mocker.patch.object(
        preset_routes, "_schedule_delayed_pod_delete",
    )
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout=_events_to_stdout([{"type": "pod_spawned", "pod_id": "pod_exc", "token": "t"}]),
        returncode=0,
    )
    proc.wait.side_effect = RuntimeError("wait blew up")
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("error", "completed", "cancelled")

    assert preset_routes._install_state["state"] == "error"
    assert "wait blew up" in preset_routes._install_state["error"]
    schedule_spy.assert_called_once_with("pod_exc")


def test_delete_failure_does_not_mask_install_error(client, mocker):
    """If the scheduler / underlying DELETE itself fails, the original
    install error message must still be preserved on _install_state."""
    mocker.patch.object(
        preset_routes, "_schedule_delayed_pod_delete",
        side_effect=RuntimeError("runpod 500"),
    )
    preset = _full_preset(n_models=1)
    _mock_registry_fetches(mocker, preset)
    events = [
        {"type": "pod_spawned", "pod_id": "pod_leak", "token": "tok"},
        {"type": "install_error", "stage": "download", "reason": "the real cause"},
    ]
    proc = _make_proc(stdout=_events_to_stdout(events), returncode=1)
    mocker.patch.object(preset_routes.subprocess, "Popen", return_value=proc)

    client.post("/api/presets/install", json={"preset_id": preset["id"]})
    _wait_for_install_state("error", "completed", "cancelled")

    s = preset_routes._install_state
    assert s["state"] == "error"
    assert "the real cause" in s["error"]


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


def test_install_mode_gpu_batch_spec_runs_through_canonical_translator(
    client, mocker
):
    """src-abj (supersedes src-b6b): the GPU-fallback batch spec must
    flow through preset_resolver.preset_to_download_batch — the same
    translator comfy-gen's install-preset orchestrator uses. That means:

    - source=huggingface is aliased to 'url'
    - source=url emits 'destination_path' (NOT bare 'dest' with a slash —
      the worker treats dest as a subfolder and FileExistsErrors)
    - source=civitai parses version_id out of the URL and splits dest
      into subfolder + filename (without this the worker raises
      'version_id required for civitai source')
    """
    # sgs-ui-41c: civitai-source model requires civitai_api_key now.
    settings_store.set_credential("civitai_api_key", "ck_for_translator_test")
    preset = _full_preset(n_models=1)
    preset["models"] = [
        {
            "source": "huggingface",
            "url": "https://hf.co/org/text_encoder.safetensors",
            "dest": "text_encoders/umt5_xxl_fp8.safetensors",
            "sha256": "a" * 64, "size_gb": 1.0,
        },
        {
            "source": "civitai",
            "url": "https://civitai.com/api/download/models/456789",
            "dest": "loras/cool_style.safetensors",
            "sha256": "b" * 64, "size_gb": 0.2,
        },
    ]
    _mock_registry_fetches(mocker, preset)
    proc = _make_proc(
        stdout='{"ok": true, "files": []}\n',
        stderr="[1/2] downloaded\n[2/2] downloaded\n",
        returncode=0,
    )

    captured: dict = {}

    def _capture_then_return(args, *a, **kw):
        try:
            i = args.index("--batch")
            with open(args[i + 1], "r", encoding="utf-8") as fp:
                captured["spec"] = json.load(fp)
        except (ValueError, IndexError, OSError):
            captured["spec"] = None
        return proc

    mocker.patch.object(
        preset_routes.subprocess, "Popen", side_effect=_capture_then_return
    )

    r = client.post(
        "/api/presets/install?mode=gpu",
        json={"preset_id": preset["id"]},
    )
    assert r.status_code == 202
    _wait_for_install_state("completed", "error", "cancelled")
    assert preset_routes._install_state["state"] == "completed"

    spec = captured.get("spec")
    assert spec is not None, "batch spec was not captured"
    assert len(spec) == 2

    hf_entry, civ_entry = spec
    # huggingface → url alias + destination_path
    assert hf_entry["source"] == "url"
    assert hf_entry["destination_path"] == "text_encoders/umt5_xxl_fp8.safetensors"
    assert "dest" not in hf_entry or "/" not in hf_entry["dest"]
    # civitai → version_id parsed, dest split
    assert civ_entry["source"] == "civitai"
    assert civ_entry["version_id"] == "456789"
    assert civ_entry["dest"] == "loras"
    assert civ_entry["filename"] == "cool_style.safetensors"


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
