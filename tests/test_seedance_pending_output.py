from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "seedance_block_pending_output",
    ROOT / "custom_blocks" / "seedance" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)


@pytest.mark.anyio
async def test_pending_poll_with_output_video_completes_local_job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """PiAPI can expose output.video before status flips to completed."""
    job_id = "job_pending_output"
    remote_video = "https://img.theapi.app/ephemeral/video.mp4"
    downloaded: list[tuple[str, Path]] = []

    monkeypatch.setattr(mod, "POLL_INITIAL_SEC", 0)
    monkeypatch.setattr(mod, "POLL_MAX_SEC", 0)
    monkeypatch.setattr(mod, "SEEDANCE_DIR", tmp_path)

    async def fake_submit(api_key: str, task_type: str, input_payload: dict):
        return {
            "code": 200,
            "data": {
                "task_id": "remote-task-1",
                "status": "pending",
            },
        }

    polls = iter([
        {
            "data": {
                "status": "pending",
                "output": {"video": remote_video},
                "logs": ["still says pending"],
                "meta": {"usage": {"consume": 123}},
            },
        },
        {
            "data": {
                "status": "failed",
                "error": {"message": "should not be reached"},
            },
        },
    ])

    async def fake_poll_once(api_key: str, task_id: str):
        return next(polls)

    def fake_download(url: str, dest: Path):
        downloaded.append((url, dest))
        dest.write_bytes(b"mp4")

    monkeypatch.setattr(mod, "_submit", fake_submit)
    monkeypatch.setattr(mod, "_poll_once", fake_poll_once)
    monkeypatch.setattr(mod, "_download", fake_download)

    mod.JOBS.clear()
    mod.JOBS[job_id] = {
        "job_id": job_id,
        "status": "QUEUED",
        "remote_status": None,
        "remote_id": None,
        "video_url": None,
        "remote_url": None,
        "usage": None,
        "remote_logs": [],
        "error": "",
        "started_at": 0,
        "ended_at": None,
        "cancel_requested": False,
        "task_type": "seedance-2-less-restriction",
        "mode": None,
    }

    await mod._run_job(job_id, "key", "seedance-2-less-restriction", {"prompt": "x"})

    rec = mod.JOBS[job_id]
    assert rec["status"] == "COMPLETED"
    assert rec["remote_status"] == "pending"
    assert rec["video_url"] == f"/outputs/seedance/{job_id}.mp4"
    assert rec["remote_url"] == remote_video
    assert rec["usage"] == {"consume": 123}
    assert downloaded == [(remote_video, tmp_path / f"{job_id}.mp4")]
