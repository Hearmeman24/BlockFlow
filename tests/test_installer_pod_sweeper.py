"""sgs-ui-c7n: installer-pod sweeper tests.

Covers the bead's TDD plan:
  Task 1 — pure decision function (table-driven)
  Task 2 — runpod_api list_pods / delete_pod (idempotent 404 handling)
  Task 3 — sweeper loop tolerates per-iteration exceptions
  Task 4 — on-completion DELETE fires from _run_install_subprocess
"""
from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import (  # noqa: E402
    installer_pod_sweeper,
    preset_routes,
    runpod_api,
    settings_store,
)

# === fixtures ===============================================================

@pytest.fixture
def db_isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "c7n.db")
    settings_store.init_db()
    preset_routes._reset_install_state()
    yield


# === Task 1: pure decision function =========================================

def _pod(pod_id: str = "p_x", *, name: str = "comfygen-installer-abc",
         age_min: float = 1.0) -> dict:
    created = (datetime.now(timezone.utc) - timedelta(minutes=age_min)).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")
    return {"id": pod_id, "name": name, "createdAt": created}


def test_decide_rule_a_completed_install_deletes_immediately():
    """Pod has a matching installed_presets row → DELETE now."""
    now = datetime.now(timezone.utc)
    decision, reason = installer_pod_sweeper._decide(
        _pod(age_min=0.1),
        now=now,
        completed_row={"preset_id": "qwen-image-lighting", "pod_id": "p_x"},
        is_active=False,
        active_state=None,
    )
    assert decision == "delete"
    assert reason == "install_completed"


def test_decide_rule_b_orphan_under_threshold_skips():
    """Untracked pod younger than ORPHAN_MIN → leave alone (CLI may still
    be cleaning up)."""
    now = datetime.now(timezone.utc)
    decision, _ = installer_pod_sweeper._decide(
        _pod(age_min=2.0),
        now=now, completed_row=None,
        is_active=False, active_state=None,
        orphan_min=5,
    )
    assert decision == "skip"


def test_decide_rule_b_orphan_over_threshold_deletes():
    """Untracked + older than ORPHAN_MIN → DELETE."""
    now = datetime.now(timezone.utc)
    decision, reason = installer_pod_sweeper._decide(
        _pod(age_min=10.0),
        now=now, completed_row=None,
        is_active=False, active_state=None,
        orphan_min=5,
    )
    assert decision == "delete"
    assert reason == "orphan_age_exceeded"


def test_decide_rule_c_active_install_under_stuck_threshold_skips():
    """In-flight install within the stuck window → leave alone."""
    now = datetime.now(timezone.utc)
    decision, _ = installer_pod_sweeper._decide(
        _pod(age_min=3.0),
        now=now, completed_row=None,
        is_active=True, active_state="running",
        stuck_min=60,
    )
    assert decision == "skip"


def test_decide_rule_c_active_install_over_stuck_threshold_deletes():
    """In-flight install older than STUCK_MIN → DELETE (and the caller will
    flip _install_state)."""
    now = datetime.now(timezone.utc)
    decision, reason = installer_pod_sweeper._decide(
        _pod(age_min=120.0),
        now=now, completed_row=None,
        is_active=True, active_state="running",
        stuck_min=60,
    )
    assert decision == "delete"
    assert reason == "install_stuck"


def test_parse_created_at_handles_runpod_go_time_string_format():
    """RunPod actually returns Go's `time.String()` format on /v1/pods:
    '2026-05-24 09:18:12.662 +0000 UTC' (caught in c7n live test). Earlier
    we assumed RFC3339; both must work."""
    parsed = installer_pod_sweeper._parse_created_at("2026-05-24 09:18:12.662 +0000 UTC")
    assert parsed is not None
    assert parsed.year == 2026 and parsed.month == 5 and parsed.day == 24
    assert parsed.tzinfo is not None
    # No-fraction variant
    assert installer_pod_sweeper._parse_created_at("2026-05-24 09:18:12 +0000 UTC") is not None
    # Still handles the RFC3339 format defensively
    assert installer_pod_sweeper._parse_created_at("2026-05-24T09:18:12Z") is not None


def test_decide_unparseable_createdat_skips_defensively():
    """Bad/missing createdAt → don't DELETE — better to leak a pod than to
    nuke something we can't reason about."""
    now = datetime.now(timezone.utc)
    decision, _ = installer_pod_sweeper._decide(
        {"id": "p_x", "name": "comfygen-installer-x", "createdAt": "garbage"},
        now=now, completed_row=None,
        is_active=False, active_state=None,
    )
    assert decision == "skip"


# === Task 2: runpod_api wrappers ============================================

def test_delete_pod_treats_404_as_success(mocker):
    resp = MagicMock(status_code=404, text="not found")
    mocker.patch.object(runpod_api._cffi_requests, "delete", return_value=resp)
    assert runpod_api.delete_pod("rpa_x", "pod_y") is True


def test_delete_pod_returns_true_on_200(mocker):
    resp = MagicMock(status_code=200, text="{}")
    mocker.patch.object(runpod_api._cffi_requests, "delete", return_value=resp)
    assert runpod_api.delete_pod("rpa_x", "pod_y") is True


def test_delete_pod_raises_on_5xx(mocker):
    resp = MagicMock(status_code=500, text="boom")
    mocker.patch.object(runpod_api._cffi_requests, "delete", return_value=resp)
    with pytest.raises(runpod_api.RunPodAPIError):
        runpod_api.delete_pod("rpa_x", "pod_y")


def test_list_pods_returns_list(mocker):
    resp = MagicMock(
        status_code=200,
        text=json.dumps([{"id": "p1", "name": "comfygen-installer-abc"}]),
    )
    resp.json = lambda: [{"id": "p1", "name": "comfygen-installer-abc"}]
    mocker.patch.object(runpod_api._cffi_requests, "get", return_value=resp)
    pods = runpod_api.list_pods("rpa_x")
    assert pods == [{"id": "p1", "name": "comfygen-installer-abc"}]


def test_list_pods_unwraps_dict_response(mocker):
    """Some accounts wrap in {'pods': [...]} — handle it."""
    resp = MagicMock(status_code=200, text='{"pods": [{"id":"p2"}]}')
    resp.json = lambda: {"pods": [{"id": "p2"}]}
    mocker.patch.object(runpod_api._cffi_requests, "get", return_value=resp)
    assert runpod_api.list_pods("rpa_x") == [{"id": "p2"}]


# === Task 3: sweep_once end-to-end + loop resilience ========================

def test_sweep_once_deletes_completed_and_orphan_skips_active(db_isolated, mocker):
    """Three pods: one tracked-completed (DELETE), one orphan-old (DELETE),
    one active in-flight (SKIP)."""
    settings_store.set_credential("runpod_api_key", "rpa_test")
    settings_store.record_installed_preset(
        preset_id="qwen-image-lighting", version="0.2.0",
        workflow_json="{}", disk_size_gb=50,
        installed_paths=["/x"], pod_id="pod_done",
        install_mode="cpu", cost_per_hr_at_spawn=0.06,
    )
    preset_routes._install_state.update({
        "state": "running", "preset_id": "wan-animate", "pod_id": "pod_active",
    })

    now = datetime.now(timezone.utc)
    old = (now - timedelta(minutes=30)).isoformat(timespec="seconds").replace("+00:00", "Z")
    fresh = (now - timedelta(minutes=1)).isoformat(timespec="seconds").replace("+00:00", "Z")
    pods = [
        {"id": "pod_done",   "name": "comfygen-installer-x", "createdAt": fresh},
        {"id": "pod_orphan", "name": "comfygen-installer-y", "createdAt": old},
        {"id": "pod_active", "name": "comfygen-installer-z", "createdAt": fresh},
        {"id": "pod_unrelated", "name": "comfygen-worker-1",  "createdAt": old},  # not installer
    ]
    mocker.patch.object(runpod_api, "list_pods", return_value=pods)
    deleted: list[str] = []
    mocker.patch.object(runpod_api, "delete_pod",
                        side_effect=lambda key, pid: deleted.append(pid) or True)

    report = installer_pod_sweeper.sweep_once(now=now)

    assert sorted(deleted) == ["pod_done", "pod_orphan"]
    assert {d["pod_id"] for d in report.deleted} == {"pod_done", "pod_orphan"}
    # pod_active and pod_unrelated stay alive — first via Rule C skip, second via
    # the prefix filter (never enters the candidate list).
    assert any(s["pod_id"] == "pod_active" for s in report.skipped)
    assert "pod_unrelated" not in deleted


def test_sweep_once_returns_error_when_no_api_key_configured(db_isolated):
    report = installer_pod_sweeper.sweep_once()
    assert any(e.get("scope") == "config" for e in report.errors)
    assert report.deleted == []


def test_sweep_once_returns_error_when_list_pods_throws(db_isolated, mocker):
    settings_store.set_credential("runpod_api_key", "rpa_test")
    mocker.patch.object(runpod_api, "list_pods",
                        side_effect=runpod_api.RunPodAPIError("timeout"))
    report = installer_pod_sweeper.sweep_once()
    assert any(e.get("scope") == "list_pods" for e in report.errors)


def test_sweep_once_honors_runtime_threshold_overrides(db_isolated, mocker, monkeypatch):
    """Regression for c7n live test: _decide's defaults bind to ORPHAN_MIN
    at function-definition time, so sweep_once must pass the *current*
    module-level value rather than relying on the default."""
    settings_store.set_credential("runpod_api_key", "rpa_test")
    now = datetime.now(timezone.utc)
    fresh = (now - timedelta(seconds=10)).isoformat(timespec="seconds").replace("+00:00", "Z")
    mocker.patch.object(runpod_api, "list_pods", return_value=[
        {"id": "pod_fresh", "name": "comfygen-installer-x", "createdAt": fresh},
    ])
    mocker.patch.object(runpod_api, "delete_pod", return_value=True)
    # Default ORPHAN_MIN=5 → 10-second-old pod should NOT be DELETEd.
    r = installer_pod_sweeper.sweep_once(now=now)
    assert r.deleted == []
    # Patch the module global to 0 → next sweep should DELETE.
    monkeypatch.setattr(installer_pod_sweeper, "ORPHAN_MIN", 0)
    r = installer_pod_sweeper.sweep_once(now=now)
    assert {d["pod_id"] for d in r.deleted} == {"pod_fresh"}


def test_sweep_once_flips_install_state_on_stuck_delete(db_isolated, mocker):
    """Rule C: deleting a stuck pod also marks the in-memory install as
    'error' so the UI surfaces failure and the next install can start."""
    settings_store.set_credential("runpod_api_key", "rpa_test")
    preset_routes._install_state.update({
        "state": "running", "preset_id": "stuck-preset", "pod_id": "pod_stuck",
    })
    now = datetime.now(timezone.utc)
    very_old = (now - timedelta(minutes=120)).isoformat(timespec="seconds").replace("+00:00", "Z")
    mocker.patch.object(runpod_api, "list_pods", return_value=[
        {"id": "pod_stuck", "name": "comfygen-installer-x", "createdAt": very_old},
    ])
    mocker.patch.object(runpod_api, "delete_pod", return_value=True)

    installer_pod_sweeper.sweep_once(now=now)
    assert preset_routes._install_state["state"] == "error"
    assert "sweeper" in preset_routes._install_state["error"].lower()


def test_sweeper_loop_swallows_exceptions_and_continues(mocker, monkeypatch):
    """One bad iteration must not kill the loop. Drive it through
    sweep_once(): first call raises, second returns a clean report; the
    stop_event ends the loop after the second iteration."""
    calls = {"n": 0}
    stop = threading.Event()

    def _flaky(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated swift kick")
        # Signal the loop to exit after the recovery iteration succeeds.
        stop.set()
        return installer_pod_sweeper.SweepReport(scanned_at=datetime.now(timezone.utc))

    monkeypatch.setattr(installer_pod_sweeper, "sweep_once", _flaky)
    installer_pod_sweeper.sweeper_loop(interval_sec=0, stop_event=stop)
    assert calls["n"] == 2  # crash + recovery


# === Task 4: on-completion DELETE ===========================================

def test_delete_pod_post_install_idempotent_no_apikey(db_isolated):
    """Missing api key → returns False, doesn't crash."""
    assert installer_pod_sweeper.delete_pod_post_install("pod_x") is False


def test_delete_pod_post_install_none_pod_id_short_circuits(db_isolated):
    settings_store.set_credential("runpod_api_key", "rpa_test")
    assert installer_pod_sweeper.delete_pod_post_install(None) is False


def test_delete_pod_post_install_calls_runpod_when_configured(db_isolated, mocker):
    settings_store.set_credential("runpod_api_key", "rpa_test")
    spy = mocker.patch.object(runpod_api, "delete_pod", return_value=True)
    assert installer_pod_sweeper.delete_pod_post_install("pod_done") is True
    spy.assert_called_once_with("rpa_test", "pod_done")


def test_delete_pod_post_install_swallows_runpod_error(db_isolated, mocker):
    """A failing DELETE here is not fatal — the periodic sweeper will retry
    on the next tick."""
    settings_store.set_credential("runpod_api_key", "rpa_test")
    mocker.patch.object(runpod_api, "delete_pod",
                        side_effect=runpod_api.RunPodAPIError("500"))
    assert installer_pod_sweeper.delete_pod_post_install("pod_x") is False


# === Settings store: pod_id reverse lookup ==================================

def test_get_installed_preset_by_pod_id_returns_row(db_isolated):
    settings_store.record_installed_preset(
        preset_id="p1", version="0.2.0", workflow_json="{}",
        disk_size_gb=10, pod_id="pod_abc", install_mode="cpu",
        cost_per_hr_at_spawn=0.06,
    )
    row = settings_store.get_installed_preset_by_pod_id("pod_abc")
    assert row is not None
    assert row["preset_id"] == "p1"


def test_get_installed_preset_by_pod_id_returns_none_when_missing(db_isolated):
    assert settings_store.get_installed_preset_by_pod_id("never_seen") is None


def test_get_installed_preset_by_pod_id_empty_string_returns_none(db_isolated):
    """Defensive — an empty pod_id must not match a row whose pod_id is NULL."""
    settings_store.record_installed_preset(
        preset_id="p1", version="0.2.0", workflow_json="{}",
        pod_id=None,
    )
    assert settings_store.get_installed_preset_by_pod_id("") is None
