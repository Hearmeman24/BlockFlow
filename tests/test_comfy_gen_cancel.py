"""Cancel-route tests for sgs-ui-h1c.1.3 (audit A.2.1).

The cancel endpoint shells out to `comfy-gen cancel <remote_job_id>` to tell
RunPod to stop the GPU worker. When that subprocess times out or otherwise
fails, the UI needs to know *why* so it can show the right message and
offer retry where appropriate.

Adds a `remote_cancel_status` field to the response:
  - 'ok'             : subprocess returned 0
  - 'timeout'        : subprocess.TimeoutExpired (retryable)
  - 'error'          : any other exception or non-zero rc
  - 'no_remote_id'   : job never reached RunPod, no remote_job_id was captured

Also bumps the subprocess timeout from 10s → 30s.
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from fakes import comfy_gen as fakes  # noqa: E402

from backend import settings_store  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block_cancel",
    ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)


# ---- fixtures --------------------------------------------------------------

@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(mod.router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_jobs(monkeypatch):
    """Each test gets a clean JOBS dict + lock."""
    from backend import state
    monkeypatch.setattr(state, "JOBS", {})
    monkeypatch.setattr(state, "JOBS_LOCK", threading.Lock())
    yield


def _seed_job(*, remote_job_id: str = "rp_remote_123",
              endpoint_id: str = "ep_test") -> str:
    """Put a job into state.JOBS so the cancel route has something to act on."""
    from backend import state
    job_id = "local_job_abc"
    state.JOBS[job_id] = {
        "job_id": job_id,
        "status": "RUNNING",
        "remote_job_id": remote_job_id,
        "endpoint_id": endpoint_id,
    }
    return job_id


# ---- success case ----------------------------------------------------------

def test_cancel_success_returns_status_ok(client, monkeypatch):
    job_id = _seed_job()
    monkeypatch.setattr(
        mod.subprocess, "run",
        lambda *a, **kw: fakes.run_result(stdout="cancelled\n", returncode=0),
    )
    r = client.post(f"/cancel/{job_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["cancelled_remote"] is True
    assert body["remote_cancel_status"] == "ok"


def test_cancel_passes_settings_runpod_config(client, monkeypatch, tmp_path):
    db_path = tmp_path / "settings.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    settings_store.set_credential("runpod_api_key", "rpa_cancel")
    settings_store.set_endpoint("comfygen", endpoint_id="ep_cancel", volume_id="vol")
    job_id = _seed_job(endpoint_id="ep_cancel")
    captured: dict[str, object] = {}

    def _capture(args, **kw):
        captured["args"] = args
        captured["env"] = kw.get("env")
        captured["cfg"] = (Path(captured["env"]["HOME"]) / ".comfy-gen" / "config.json").read_text(encoding="utf-8")
        return fakes.run_result(stdout="cancelled\n", returncode=0)

    monkeypatch.setattr(mod.subprocess, "run", _capture)

    r = client.post(f"/cancel/{job_id}")

    assert r.status_code == 200
    env = captured["env"]
    cfg = captured["cfg"]
    assert env["RUNPOD_API_KEY"] == "rpa_cancel"
    assert '"runpod_api_key": "rpa_cancel"' in cfg
    assert "rpa_cancel" not in captured["args"]


# ---- timeout: the audit's core concern -------------------------------------

def test_cancel_subprocess_timeout_reports_timeout_status(client, monkeypatch):
    """When RunPod is slow and subprocess.run hits its timeout, the UI
    must see remote_cancel_status='timeout' so it can offer retry."""
    job_id = _seed_job()

    def _raise_timeout(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="comfy-gen", timeout=30)

    monkeypatch.setattr(mod.subprocess, "run", _raise_timeout)
    r = client.post(f"/cancel/{job_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["cancelled_remote"] is False
    assert body["remote_cancel_status"] == "timeout"


def test_cancel_timeout_uses_30s_not_10s(client, monkeypatch):
    """Lock in the 30s timeout — too-short timeouts were the original bug."""
    job_id = _seed_job()
    captured: dict[str, object] = {}

    def _capture(*a, **kw):
        captured.update(kw)
        return fakes.run_result(returncode=0)

    monkeypatch.setattr(mod.subprocess, "run", _capture)
    client.post(f"/cancel/{job_id}")
    assert captured.get("timeout") == 30


# ---- generic error ---------------------------------------------------------

def test_cancel_generic_exception_reports_error_status(client, monkeypatch):
    job_id = _seed_job()

    def _boom(*a, **kw):
        raise RuntimeError("RunPod 401 Unauthorized")

    monkeypatch.setattr(mod.subprocess, "run", _boom)
    r = client.post(f"/cancel/{job_id}")
    body = r.json()
    assert body["cancelled_remote"] is False
    assert body["remote_cancel_status"] == "error"
    assert "401" in body.get("remote_cancel_error", "")


def test_cancel_nonzero_returncode_reports_error_status(client, monkeypatch):
    """Subprocess ran but exited non-zero — that's an error, not a timeout
    and not a success."""
    job_id = _seed_job()
    monkeypatch.setattr(
        mod.subprocess, "run",
        lambda *a, **kw: fakes.run_result(stderr="job not found\n", returncode=1),
    )
    r = client.post(f"/cancel/{job_id}")
    body = r.json()
    assert body["cancelled_remote"] is False
    assert body["remote_cancel_status"] == "error"
    assert "job not found" in body.get("remote_cancel_error", "")


# ---- no remote_job_id ------------------------------------------------------

def test_cancel_no_remote_id_reports_no_remote_id_status(client, monkeypatch):
    """Job died before RunPod accepted it — nothing to cancel remotely."""
    job_id = _seed_job(remote_job_id="")
    # subprocess.run should never be called in this branch
    monkeypatch.setattr(
        mod.subprocess, "run",
        lambda *a, **kw: pytest.fail("subprocess.run should not be invoked"),
    )
    r = client.post(f"/cancel/{job_id}")
    body = r.json()
    assert body["cancelled_remote"] is False
    assert body["remote_cancel_status"] == "no_remote_id"


# ---- job not found ---------------------------------------------------------

def test_cancel_unknown_job_returns_404(client):
    r = client.post("/cancel/does-not-exist")
    assert r.status_code == 404


# ---- argv shape preserved --------------------------------------------------

def test_cancel_passes_endpoint_id_when_present(client, monkeypatch):
    job_id = _seed_job(endpoint_id="ep_specific")
    captured: dict[str, list] = {}

    def _capture(args, *a, **kw):
        captured["args"] = args
        return fakes.run_result(returncode=0)

    monkeypatch.setattr(mod.subprocess, "run", _capture)
    client.post(f"/cancel/{job_id}")
    assert "--endpoint-id" in captured["args"]
    assert "ep_specific" in captured["args"]
