"""Tests for the seedance VIP `duration` ⇄ `video_urls` interaction.

PiAPI preview-VIP models (`seedance-2-preview-vip`,
`seedance-2-fast-preview-vip`) only accept the 5/10/15 duration enum, even
when `video_urls` is present. The docs say video references should drive output
length, but live preview-VIP tasks reject `duration: 0` with
"invalid duration, use '5' as default".

These tests pin the defensive local behavior: keep the selected enum duration
with video references so a hidden auto sentinel cannot fall back to 5s.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "seedance_block_duration",
    ROOT / "custom_blocks" / "seedance" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)

VIP_TYPES = ["seedance-2-preview-vip", "seedance-2-fast-preview-vip"]


@pytest.mark.parametrize("task_type", VIP_TYPES)
def test_vip_with_video_keeps_selected_duration(task_type):
    """With a video reference, preview-VIP still needs a valid duration enum."""
    payload = mod._validate_and_build_input(
        {
            "prompt": "make it cinematic",
            "duration": 10,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        },
        task_type,
    )
    assert payload["duration"] == 10
    assert payload["video_urls"] == ["https://tmpfiles.org/dl/abc/clip.mp4"]


@pytest.mark.parametrize("task_type", VIP_TYPES)
def test_vip_without_video_keeps_duration(task_type):
    """Image/text VIP runs still carry the chosen duration enum (5/10/15)."""
    payload = mod._validate_and_build_input(
        {
            "prompt": "a woman walks",
            "duration": 10,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "image_urls": ["https://tmpfiles.org/dl/abc/face.png"],
        },
        task_type,
    )
    assert payload["duration"] == 10


@pytest.mark.parametrize("task_type", VIP_TYPES)
def test_vip_with_video_rejects_invalid_duration(task_type):
    """Avoid sending invalid auto sentinels that PiAPI turns into 5s outputs."""
    with pytest.raises(ValueError, match="duration"):
        mod._validate_and_build_input({
            "prompt": "x",
            "duration": 0,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        }, task_type)


def test_run_route_passes_selected_duration_to_job(monkeypatch):
    """The HTTP route must pass the corrected PiAPI payload to the job runner."""
    captured: dict[str, object] = {}

    def fake_run_job(job_id, api_key, task_type, input_payload):
        captured.update({
            "job_id": job_id,
            "api_key": api_key,
            "task_type": task_type,
            "input_payload": input_payload,
        })
        return object()

    def fake_create_task(awaitable):
        captured["scheduled"] = awaitable
        return object()

    monkeypatch.setattr(mod, "_run_job", fake_run_job)
    monkeypatch.setattr(mod.asyncio, "create_task", fake_create_task)
    mod.JOBS.clear()

    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    resp = client.post(
        "/run",
        json={
            "piapi_api_key": "test-key",
            "task_type": "seedance-2-preview-vip",
            "prompt": "make it cinematic",
            "duration": 10,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        },
    )

    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert captured["task_type"] == "seedance-2-preview-vip"
    assert captured["input_payload"] == {
        "prompt": "make it cinematic",
        "aspect_ratio": "16:9",
        "resolution": "720p",
        "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        "duration": 10,
    }
